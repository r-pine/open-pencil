import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import { DEFAULT_FONT_FAMILY } from '#core/constants'
import { MAIN_THREAD_SLICE_MS, nowMs, yieldToMainThread } from '#core/editor/main-thread'
import type { FontLoadedSource, FontUnavailableReason } from '#core/text/font/sources'
import { fontManager, type FontManager } from '#core/text/fonts'
import { collectNodeFontFaces } from '#core/text/requirements'

export type FontFaceStatus = 'available' | 'substituted' | 'unresolved'

export interface DocumentFontFaceStatus {
  family: string
  style: string
  status: FontFaceStatus
  source: FontLoadedSource | null
  substituteFamily: string | null
  /** Why the requested face could not be loaded, when the host reported a reason. */
  reason: FontUnavailableReason | null
  nodeIds: string[]
  nodeNames: string[]
}

export interface DocumentFontStatus {
  faithful: boolean
  faces: DocumentFontFaceStatus[]
  issues: DocumentFontFaceStatus[]
}

interface MutableFontFaceUse {
  family: string
  style: string
  nodeIds: Set<string>
  nodeNames: Set<string>
}

function faceKey(family: string, style: string): string {
  return `${family}\0${style}`
}

function rootTextNodes(graph: SceneGraph, rootIds: readonly string[]): SceneNode[] {
  return rootIds.flatMap((rootId) =>
    graph.flattenTree(rootId).flatMap(({ node }) => (node.type === 'TEXT' ? [node] : []))
  )
}

function collectFaceUses(graph: SceneGraph, rootIds: readonly string[]): MutableFontFaceUse[] {
  const uses = new Map<string, MutableFontFaceUse>()
  for (const node of rootTextNodes(graph, rootIds)) rememberFace(uses, node)
  return [...uses.values()]
}

function faceStatus(use: MutableFontFaceUse, manager: FontManager): DocumentFontFaceStatus {
  const exactSource = manager.loadedFontSource(use.family, use.style)
  if (exactSource) {
    return {
      family: use.family,
      style: use.style,
      status: 'available',
      source: exactSource,
      substituteFamily: null,
      reason: null,
      nodeIds: [...use.nodeIds],
      nodeNames: [...use.nodeNames]
    }
  }

  if (manager.isLoaded(use.family)) {
    return {
      family: use.family,
      style: use.style,
      status: 'substituted',
      source: null,
      substituteFamily: use.family,
      reason: manager.unavailableReason(use.family, use.style),
      nodeIds: [...use.nodeIds],
      nodeNames: [...use.nodeNames]
    }
  }

  const defaultSource = manager.loadedFontSource(DEFAULT_FONT_FAMILY, 'Regular')
  return {
    family: use.family,
    style: use.style,
    status: defaultSource ? 'substituted' : 'unresolved',
    source: null,
    substituteFamily: defaultSource ? DEFAULT_FONT_FAMILY : null,
    reason: manager.unavailableReason(use.family, use.style),
    nodeIds: [...use.nodeIds],
    nodeNames: [...use.nodeNames]
  }
}

export function documentFontStatus(
  graph: SceneGraph,
  rootIds: string | readonly string[],
  manager: FontManager = fontManager
): DocumentFontStatus {
  const roots = typeof rootIds === 'string' ? [rootIds] : rootIds
  return statusFromUses(collectFaceUses(graph, roots), manager)
}

function statusFromUses(uses: MutableFontFaceUse[], manager: FontManager): DocumentFontStatus {
  const faces = uses
    .map((use) => faceStatus(use, manager))
    .sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style))
  const issues = faces.filter((face) => face.status !== 'available')
  return { faithful: issues.length === 0, faces, issues }
}

function rememberFace(uses: Map<string, MutableFontFaceUse>, node: SceneNode) {
  for (const { family, style } of collectNodeFontFaces(node)) {
    const key = faceKey(family, style)
    const use = uses.get(key) ?? {
      family,
      style,
      nodeIds: new Set<string>(),
      nodeNames: new Set<string>()
    }
    use.nodeIds.add(node.id)
    use.nodeNames.add(node.name)
    uses.set(key, use)
  }
}

/**
 * Same report as `documentFontStatus`, walked a slice at a time. A page of this file is the
 * whole design, and scanning it inside the edit kept the canvas from panning. Returns null
 * when `shouldContinue` fails, so a newer edit can abandon the walk.
 */
export async function documentFontStatusWhenIdle(
  graph: SceneGraph,
  rootId: string,
  shouldContinue: () => boolean = () => true,
  manager: FontManager = fontManager
): Promise<DocumentFontStatus | null> {
  const uses = new Map<string, MutableFontFaceUse>()
  const stack = [...(graph.getNode(rootId)?.childIds ?? [])].reverse()
  let scanned = 0
  let sliceStart = nowMs()
  while (stack.length > 0) {
    if (!shouldContinue()) return null
    const id = stack.pop()
    if (!id) continue
    const node = graph.getNode(id)
    if (!node) continue
    scanned++
    if (node.type === 'TEXT') rememberFace(uses, node)
    for (let index = node.childIds.length - 1; index >= 0; index--) {
      const childId = node.childIds[index]
      if (childId) stack.push(childId)
    }
    if (scanned % 400 === 0 || nowMs() - sliceStart >= MAIN_THREAD_SLICE_MS) {
      await yieldToMainThread()
      sliceStart = nowMs()
      if (!shouldContinue()) return null
    }
  }
  return statusFromUses([...uses.values()], manager)
}
