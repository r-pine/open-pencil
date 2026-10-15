import type { Color } from '@open-pencil/scene-graph/primitives'
import { eyeDropperActive, type BindableValueActions, type BindingTarget } from '@open-pencil/vue'

export type PaintBindingKind = 'fills' | 'strokes'

export function paintBindingTargets(
  nodeIds: string[],
  kind: PaintBindingKind,
  index: number
): BindingTarget[] {
  return nodeIds.map((nodeId) => ({ nodeId, path: `${kind}/${index}/color` }))
}

export function applyPaintMutation(
  actions: BindableValueActions<Color>,
  flush: () => void,
  update: () => void
): boolean {
  flush()
  const started = actions.beginMutation('edit')
  // An unresolved binding (a style id the document cannot resolve, shown as "0:72") refuses
  // beginMutation, which used to skip the fill write. Detach it anyway so the pill clears and
  // the sampled color is what the picker and the canvas both show.
  if (eyeDropperActive.value) actions.unbind()
  if (!started && !eyeDropperActive.value) return false
  update()
  // Text writes the sample onto style runs. That update can copy a fill style's variable
  // back onto the layer, so detach again after the write. Commit immediately (like the hex
  // field) so a later popover dismiss cannot restore the binding — otherwise displayFill
  // keeps showing the bound color and the channel fields look unchanged.
  if (eyeDropperActive.value) actions.unbind()
  if (started && eyeDropperActive.value) actions.commitMutation()
  return true
}

export function commitPaintMutation(actions: BindableValueActions<Color>) {
  actions.commitMutation()
}

export function cancelPaintMutation(actions: BindableValueActions<Color>) {
  // A dismiss that races the EyeDropper sample must keep the applied color, not restore
  // the previous variable/style binding (otherwise RGB/fill look unchanged).
  if (eyeDropperActive.value) actions.commitMutation()
  else actions.cancelMutation()
}
