import { omit, pick } from 'es-toolkit/object'
import { isEqual } from 'es-toolkit/predicate'

import type { CharacterStyleOverride, SceneNode, StyleRun } from '@open-pencil/scene-graph'

import type { EditorContext } from '#core/editor/types'
import {
  characterStyles,
  styleRunsWithPatch,
  TEXT_STYLE_KEYS,
  type TextStyleKey
} from '#core/text/character-style'

type NodeUpdate = (id: string, changes: Partial<SceneNode>) => void

const FILL_COLOR_BINDING = /^fills\/\d+\/color$/

function styleKeys(changes: Partial<SceneNode>): TextStyleKey[] {
  return TEXT_STYLE_KEYS.filter((key) => Object.hasOwn(changes, key))
}

/** Drop fill-color variables overridden by a direct color, so the panel stops resolving them. */
function withoutFillColorBindings(node: SceneNode): Partial<SceneNode> {
  const boundVariables = { ...node.boundVariables }
  const variableBindingScales = { ...node.variableBindingScales }
  let removed = false
  for (const key of Object.keys(boundVariables)) {
    if (!FILL_COLOR_BINDING.test(key)) continue
    delete boundVariables[key]
    delete variableBindingScales[key]
    removed = true
  }
  return removed ? { boundVariables, variableBindingScales } : {}
}

/**
 * While text is edited with characters selected, a property its characters can each have, such
 * as a fill or font size, styles the selected characters instead of the layer, as in Figma. A
 * change that applies a text style still applies to the layer.
 */
export function createTextSelectionStyle(
  ctx: EditorContext,
  runTextEditStep: (change: () => void) => void
) {
  /**
   * The style runs a previewed change started from, which its commit records as undone to, and
   * the runs it last left; anything else changing them since ends the preview.
   */
  let preview: { nodeId: string; start: StyleRun[]; shown: StyleRun[] } | null = null

  function previewOf(id: string) {
    const node = ctx.graph.getNode(id)
    // Graph values are replaced rather than written into, so the runs it left are still its own.
    return preview?.nodeId === id && node?.styleRuns === preview.shown ? preview : null
  }

  function selectedRange(id: string): [number, number] | null {
    if (ctx.state.editingTextId !== id) return null
    return ctx.getTextEditor()?.getSelectionRange() ?? null
  }

  function rangeChanges(id: string, changes: Partial<SceneNode>): Partial<SceneNode> | null {
    const range = selectedRange(id)
    const node = ctx.graph.getNode(id)
    const keys = styleKeys(changes)
    if (!range || !node || keys.length === 0 || Object.hasOwn(changes, 'textStyleId')) return null
    const patch = pick(changes, keys) as CharacterStyleOverride
    const styleRuns = styleRunsWithPatch(node, ...range, patch)
    // A range that is the whole text is the layer's fill. Keep `fills` so the panel, not only
    // the runs, shows the color after editing ends. A partial range stays on style runs.
    const coversText = range[0] === 0 && range[1] >= node.text.length
    const omitted = coversText ? keys.filter((key) => key !== 'fills') : keys
    const next: Partial<SceneNode> = { ...omit(changes, omitted), styleRuns }
    // `fills` on a partial range never reaches the layer, so shared-style detachment does not
    // clear fillStyleId and the style pill stays. Leave the style, and any fills/N/color binding.
    if (keys.includes('fills')) {
      next.fillStyleId = null
      Object.assign(next, withoutFillColorBindings(node))
    }
    return next
  }

  /** A change shown before it is committed, such as a dragged field. */
  function updateNode(id: string, changes: Partial<SceneNode>, update: NodeUpdate) {
    const ranged = rangeChanges(id, changes)
    if (!ranged) {
      update(id, changes)
      return
    }
    const current = previewOf(id)
    let start = current?.start ?? []
    // What was typed becomes a step of its own before the preview starts.
    if (!current) {
      runTextEditStep(() => {
        start = structuredClone(ctx.graph.getNode(id)?.styleRuns ?? [])
      })
    }
    update(id, ranged)
    preview = { nodeId: id, start, shown: ctx.graph.getNode(id)?.styleRuns ?? [] }
  }

  function updateNodeWithUndo(id: string, changes: Partial<SceneNode>, update: NodeUpdate) {
    const ranged = rangeChanges(id, changes)
    if (!ranged) {
      update(id, changes)
      return
    }
    preview = null
    runTextEditStep(() => update(id, ranged))
  }

  /**
   * Records a previewed change, given the values it replaced. The selected characters had
   * styles of their own, so the step undoes to the runs the preview started from.
   */
  function commitNodeUpdate(
    id: string,
    previous: Partial<SceneNode>,
    commit: NodeUpdate,
    updateWithUndo: NodeUpdate
  ) {
    const current = previewOf(id)
    const keys = styleKeys(previous)
    preview = null
    if (!current || keys.length === 0) {
      commit(id, previous)
      return
    }
    const previewed = current.shown
    // Back to where the preview started, so the edit session records nothing of its own.
    ctx.graph.updateNode(id, { styleRuns: current.start })
    runTextEditStep(() => {
      if (!isEqual(previewed, current.start)) updateWithUndo(id, { styleRuns: previewed })
      commit(id, omit(previous, keys))
    })
  }

  /**
   * The style of the selected characters as the layer's own properties, for the panel to show;
   * characters styled differently show the first one's.
   */
  function selectionStyle(node: SceneNode): Partial<SceneNode> | null {
    const range = selectedRange(node.id)
    if (!range) return null
    const [style] = characterStyles(node, range[0], range[0] + 1)
    // Links, styles, and bindings of characters are not the layer's own properties.
    return pick(style, TEXT_STYLE_KEYS)
  }

  return { updateNode, updateNodeWithUndo, commitNodeUpdate, selectionStyle }
}
