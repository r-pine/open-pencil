import { isEqual } from 'es-toolkit/predicate'

import type { SceneGraph, SceneNode, SharedStyle, SharedStyleKind, SharedStyleType } from './index'

const STYLE_REF_KEYS = {
  fill: 'fillStyleId',
  stroke: 'strokeStyleId',
  text: 'textStyleId',
  effect: 'effectStyleId',
  grid: 'gridStyleId'
} as const satisfies Record<SharedStyleKind, keyof SceneNode>

const STYLE_TYPES = {
  fill: 'FILL',
  stroke: 'FILL',
  text: 'TEXT',
  effect: 'EFFECT',
  grid: 'GRID'
} as const satisfies Record<SharedStyleKind, SharedStyleType>

/** The fields a text style gives what uses it; changing one leaves the style. */
export const SHARED_TEXT_STYLE_FIELDS = [
  'fontFamily',
  'fontWeight',
  'italic',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'textDecoration',
  'textCase',
  'fontFeatures'
] as const satisfies readonly (keyof SceneNode)[]

const TEXT_STYLE_KEYS = new Set<keyof SceneNode>(SHARED_TEXT_STYLE_FIELDS)

export function sharedStyleRefKey(kind: SharedStyleKind): (typeof STYLE_REF_KEYS)[SharedStyleKind] {
  return STYLE_REF_KEYS[kind]
}

export function sharedStyleTypeForKind(kind: SharedStyleKind): SharedStyleType {
  return STYLE_TYPES[kind]
}

export function getSharedStyles(graph: SceneGraph, kind: SharedStyleKind): SharedStyle[] {
  const type = sharedStyleTypeForKind(kind)
  const styles: SharedStyle[] = []
  for (const node of graph.getAllNodes()) {
    if (node.sharedStyleType !== type || !node.source.id) continue
    styles.push({ id: node.source.id, nodeId: node.id, name: node.name, type })
  }
  return styles.sort((left, right) => left.name.localeCompare(right.name))
}

function styleAt(runs: SceneNode['styleRuns'], index: number) {
  return runs.find((run) => index >= run.start && index < run.start + run.length)?.style
}

/**
 * A text edit writes `styleRuns` instead of `fills`. That still overrides the fill style when a
 * run's fill or its fill-style link changes, the same way a `fills` patch does.
 */
function styleRunsOverrideFills(node: SceneNode, runs: SceneNode['styleRuns'] | undefined): boolean {
  if (!runs || node.type !== 'TEXT' || !node.fillStyleId) return false
  for (let index = 0; index < node.text.length; index++) {
    const before = styleAt(node.styleRuns, index)
    const after = styleAt(runs, index)
    if (!after) continue
    if (after.fillStyleId === null && before?.fillStyleId !== null) return true
    if (after.fills !== undefined && !isEqual(after.fills, before?.fills)) return true
  }
  return false
}

export function styleDetachmentChanges(
  node: SceneNode,
  changes: Partial<SceneNode>
): Partial<SceneNode> {
  const next = { ...changes }
  if (
    !('fillStyleId' in changes) &&
    node.fillStyleId &&
    ('fills' in changes || styleRunsOverrideFills(node, changes.styleRuns))
  ) {
    next.fillStyleId = null
  }
  if ('strokes' in changes && !('strokeStyleId' in changes) && node.strokeStyleId) {
    next.strokeStyleId = null
  }
  if ('effects' in changes && !('effectStyleId' in changes) && node.effectStyleId) {
    next.effectStyleId = null
  }
  if ('layoutGrids' in changes && !('gridStyleId' in changes) && node.gridStyleId) {
    next.gridStyleId = null
  }
  const changesTextStyle = (Object.keys(changes) as (keyof SceneNode)[]).some((key) =>
    TEXT_STYLE_KEYS.has(key)
  )
  if (changesTextStyle && !('textStyleId' in changes) && node.textStyleId) {
    next.textStyleId = null
  }
  return next
}
