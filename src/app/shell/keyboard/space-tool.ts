import { useEventListener } from '@vueuse/core'
import type { ComputedRef } from 'vue'

import type { EditorStore } from '@/app/editor/active-store'

import { isButtonActivation } from './focus'

let pointer: { x: number; y: number } | null = null

function isTypingTarget(hit: Element): boolean {
  for (let node: Element | null = hit; node; node = node.parentElement) {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return true
    if (node instanceof HTMLElement && node.isContentEditable) return true
  }
  return false
}

/** The canvas under the pointer, when that point is not an editor the user is typing in. */
export function canvasAreaAtPoint(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y)
  if (!(hit instanceof Element) || isTypingTarget(hit)) return null
  const area = hit.closest('[data-test-id="canvas-area"]')
  return area instanceof HTMLElement ? area : null
}

function canvasUnderPointer(): HTMLElement | null {
  if (pointer) return canvasAreaAtPoint(pointer.x, pointer.y)
  const area = document.querySelector('[data-test-id="canvas-area"]:hover')
  if (!(area instanceof HTMLElement)) return null
  for (const node of area.querySelectorAll('input, textarea, [contenteditable]')) {
    if (node instanceof HTMLElement && node.matches(':hover') && isTypingTarget(node)) return null
  }
  return area
}

function focusCanvas(area: HTMLElement) {
  const canvas = area.querySelector('[data-test-id="canvas-element"]')
  if (canvas instanceof HTMLElement && document.activeElement !== canvas) {
    canvas.focus({ preventScroll: true })
  }
}

export function bindSpaceHandTool(inputFocused: ComputedRef<boolean>, store: EditorStore) {
  let toolBeforeSpace: typeof store.state.activeTool | null = null

  function restoreTool() {
    if (toolBeforeSpace === null) return
    store.setTool(toolBeforeSpace)
    toolBeforeSpace = null
  }

  useEventListener(window, 'pointermove', (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY }
  })

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (event.code !== 'Space' || event.isComposing || isButtonActivation(event)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // A text layer on the canvas still takes the space character.
    if (store.state.editingTextId) return
    const area = canvasUnderPointer()
    // An input keeps the key, unless the pointer is already over the canvas: then this
    // press focuses the canvas, the way a click there would, and the hold pans.
    if (!area && inputFocused.value) return
    event.preventDefault()
    if (area) focusCanvas(area)
    if (toolBeforeSpace !== null || store.state.activeTool === 'HAND') return
    toolBeforeSpace = store.state.activeTool
    store.setTool('HAND')
  })

  useEventListener(window, 'keyup', (event: KeyboardEvent) => {
    if (event.code === 'Space') restoreTool()
  })

  useEventListener(window, 'blur', restoreTool)

  return {
    resetToolBeforeSpace() {
      toolBeforeSpace = null
    }
  }
}
