import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import type { RenderOverlays } from '#core/canvas/renderer'
import { createSceneGeometry } from '#core/geometry'

import { hasFrameTitle } from './layout'

export interface CachedSection {
  nodeId: string
  absX: number
  absY: number
  nested: boolean
}

/** A frame on the page or in a section, which shows its name above it. */
export interface CachedFrame {
  nodeId: string
  absX: number
  absY: number
}

export interface CachedComponent {
  nodeId: string
  absX: number
  absY: number
  parentType: string
}

interface Viewport {
  x: number
  y: number
  w: number
  h: number
}

const LABEL_TYPES = new Set(['COMPONENT', 'COMPONENT_SET'])
const COMPONENT_LABEL_PARENT_TYPES = new Set(['CANVAS', 'SECTION', 'COMPONENT_SET'])

function isInViewport(absX: number, absY: number, w: number, h: number, vp: Viewport): boolean {
  return absX + w >= vp.x && absY + h >= vp.y && absX <= vp.x + vp.w && absY <= vp.y + vp.h
}

function collectVisibleLabels<
  T extends { nodeId: string; absX: number; absY: number },
  U extends object
>(
  graph: SceneGraph,
  viewport: Viewport,
  cachedItems: T[],
  metadata: (cached: T) => U,
  preview: RenderOverlays['rotationPreview']
): Array<{ node: SceneNode; absX: number; absY: number } & U> {
  const result: Array<{ node: SceneNode; absX: number; absY: number } & U> = []
  const geometry = createSceneGeometry(graph, preview)
  for (const cached of cachedItems) {
    const node = graph.getNode(cached.nodeId)
    if (!node) continue
    const bounds = geometry.bounds(node)
    if (!isInViewport(bounds.x, bounds.y, bounds.width, bounds.height, viewport)) continue
    const origin = geometry.toWorld(node, { x: 0, y: 0 })
    result.push({ node, absX: origin.x, absY: origin.y, ...metadata(cached) })
  }
  return result
}

/** Past this many layers, rebuilding labels inside the edit's frame keeps the canvas from panning. */
const DEFERRED_LABEL_GRAPH_NODES = 2500
const LABEL_WALK_SLICE = 400

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export class LabelCache {
  private sections: CachedSection[] = []
  private components: CachedComponent[] = []
  private frames: CachedFrame[] = []
  private componentSets: CachedFrame[] = []
  private cachedSceneVersion = -1
  private cachedPositionPreviewVersion = -1
  private cachedPageId: string | null = null
  private pendingKey: string | null = null
  private rebuildToken = 0

  update(
    graph: SceneGraph,
    pageId: string | null,
    sceneVersion: number,
    positionPreviewVersion = graph.positionPreviewVersion
  ): void {
    if (
      sceneVersion === this.cachedSceneVersion &&
      positionPreviewVersion === this.cachedPositionPreviewVersion &&
      pageId === this.cachedPageId
    ) {
      return
    }
    if (graph.nodes.size <= DEFERRED_LABEL_GRAPH_NODES) {
      this.rebuild(graph, pageId)
      this.remember(pageId, sceneVersion, positionPreviewVersion)
      this.pendingKey = null
      return
    }
    const key = `${pageId ?? ''}:${sceneVersion}:${positionPreviewVersion}`
    if (this.pendingKey === key) return
    this.pendingKey = key
    const token = ++this.rebuildToken
    void this.rebuildWhenIdle(graph, pageId, sceneVersion, positionPreviewVersion, token)
  }

  private remember(pageId: string | null, sceneVersion: number, positionPreviewVersion: number) {
    this.cachedSceneVersion = sceneVersion
    this.cachedPositionPreviewVersion = positionPreviewVersion
    this.cachedPageId = pageId
  }

  invalidate(): void {
    this.cachedSceneVersion = -1
    this.cachedPositionPreviewVersion = -1
    this.cachedPageId = null
    this.sections = []
    this.components = []
    this.frames = []
    this.componentSets = []
  }

  getSections(
    graph: SceneGraph,
    viewport: Viewport,
    preview?: RenderOverlays['rotationPreview']
  ): Array<{ node: SceneNode; absX: number; absY: number; nested: boolean }> {
    return collectVisibleLabels(
      graph,
      viewport,
      this.sections,
      (cached) => ({
        nested: cached.nested
      }),
      preview
    )
  }

  getComponents(
    graph: SceneGraph,
    viewport: Viewport,
    preview?: RenderOverlays['rotationPreview']
  ): Array<{ node: SceneNode; absX: number; absY: number; inside: boolean }> {
    return collectVisibleLabels(
      graph,
      viewport,
      this.components,
      () => ({
        inside: false
      }),
      preview
    )
  }

  getFrames(
    graph: SceneGraph,
    viewport: Viewport,
    preview?: RenderOverlays['rotationPreview']
  ): Array<{ node: SceneNode; absX: number; absY: number }> {
    return collectVisibleLabels(graph, viewport, this.frames, () => ({}), preview)
  }

  /** Every visible component set on the page in the viewport, wherever it is nested. */
  getComponentSets(
    graph: SceneGraph,
    viewport: Viewport,
    preview?: RenderOverlays['rotationPreview']
  ): Array<{ node: SceneNode; absX: number; absY: number }> {
    return collectVisibleLabels(graph, viewport, this.componentSets, () => ({}), preview)
  }

  getAllFrames(): readonly CachedFrame[] {
    return this.frames
  }

  getAllSections(): readonly CachedSection[] {
    return this.sections
  }

  getAllComponents(): readonly CachedComponent[] {
    return this.components
  }

  private async rebuildWhenIdle(
    graph: SceneGraph,
    pageId: string | null,
    sceneVersion: number,
    positionPreviewVersion: number,
    token: number
  ) {
    await yieldTurn()
    if (token !== this.rebuildToken) return
    const sections: CachedSection[] = []
    const components: CachedComponent[] = []
    const frames: CachedFrame[] = []
    const componentSets: CachedFrame[] = []
    const pageNode = graph.getNode(pageId ?? graph.rootId)
    if (!pageNode) {
      this.sections = []
      this.components = []
      this.frames = []
      this.componentSets = []
      this.remember(pageId, sceneVersion, positionPreviewVersion)
      return
    }
    const stack: Array<{ parentId: string; insideSection: boolean; index: number }> = [
      { parentId: pageNode.id, insideSection: false, index: 0 }
    ]
    let scanned = 0
    while (stack.length > 0) {
      if (token !== this.rebuildToken) return
      const frame = stack[stack.length - 1]
      if (!frame) break
      const parent = graph.getNode(frame.parentId)
      if (!parent || frame.index >= parent.childIds.length) {
        stack.pop()
        continue
      }
      const childId = parent.childIds[frame.index]
      frame.index++
      const child = childId ? graph.getNode(childId) : undefined
      if (!child || !child.visible) continue
      scanned++
      if (child.type === 'SECTION') {
        const origin = graph.getAbsolutePosition(child.id)
        sections.push({
          nodeId: child.id,
          absX: origin.x,
          absY: origin.y,
          nested: frame.insideSection
        })
        stack.push({ parentId: child.id, insideSection: true, index: 0 })
      } else if (LABEL_TYPES.has(child.type)) {
        if (child.type === 'COMPONENT_SET') {
          const origin = graph.getAbsolutePosition(child.id)
          componentSets.push({ nodeId: child.id, absX: origin.x, absY: origin.y })
        }
        if (COMPONENT_LABEL_PARENT_TYPES.has(parent.type)) {
          const origin = graph.getAbsolutePosition(child.id)
          components.push({
            nodeId: child.id,
            absX: origin.x,
            absY: origin.y,
            parentType: parent.type
          })
        }
        if (child.childIds.length > 0) {
          stack.push({ parentId: child.id, insideSection: frame.insideSection, index: 0 })
        }
      } else {
        if (hasFrameTitle(child, parent.type)) {
          const origin = graph.getAbsolutePosition(child.id)
          frames.push({ nodeId: child.id, absX: origin.x, absY: origin.y })
        }
        if (child.childIds.length > 0) {
          stack.push({ parentId: child.id, insideSection: frame.insideSection, index: 0 })
        }
      }
      if (scanned % LABEL_WALK_SLICE === 0) await yieldTurn()
    }
    if (token !== this.rebuildToken) return
    this.sections = sections
    this.components = components
    this.frames = frames
    this.componentSets = componentSets
    this.remember(pageId, sceneVersion, positionPreviewVersion)
  }

  private rebuild(graph: SceneGraph, pageId: string | null): void {
    this.sections = []
    this.components = []
    this.frames = []
    this.componentSets = []

    const pageNode = graph.getNode(pageId ?? graph.rootId)
    if (!pageNode) return

    this.walkChildren(graph, pageNode.id, false)
  }

  private walkChildren(graph: SceneGraph, parentId: string, insideSection: boolean): void {
    const parent = graph.getNode(parentId)
    if (!parent) return
    const parentType = parent.type

    for (const childId of parent.childIds) {
      const child = graph.getNode(childId)
      if (!child || !child.visible) continue

      if (child.type === 'SECTION') {
        const origin = graph.getAbsolutePosition(childId)
        this.sections.push({
          nodeId: childId,
          absX: origin.x,
          absY: origin.y,
          nested: insideSection
        })
        this.walkChildren(graph, childId, true)
      } else if (LABEL_TYPES.has(child.type)) {
        if (child.type === 'COMPONENT_SET') {
          const origin = graph.getAbsolutePosition(childId)
          this.componentSets.push({ nodeId: childId, absX: origin.x, absY: origin.y })
        }
        if (COMPONENT_LABEL_PARENT_TYPES.has(parentType)) {
          const origin = graph.getAbsolutePosition(childId)
          this.components.push({ nodeId: childId, absX: origin.x, absY: origin.y, parentType })
        }
        if (child.childIds.length > 0) {
          this.walkChildren(graph, childId, insideSection)
        }
      } else {
        if (hasFrameTitle(child, parentType)) {
          const origin = graph.getAbsolutePosition(childId)
          this.frames.push({ nodeId: childId, absX: origin.x, absY: origin.y })
        }
        if (child.childIds.length > 0) this.walkChildren(graph, childId, insideSection)
      }
    }
  }
}
