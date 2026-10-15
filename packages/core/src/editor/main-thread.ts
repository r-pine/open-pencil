/** How long one turn may run before the tab must take a click or paint. Chrome reports a page unresponsive after about five seconds of continuous work. */
export const MAIN_THREAD_SLICE_MS = 12

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Ends the current turn. `setTimeout` is a macrotask, so input queued during the slice runs
 * before the next one. `requestAnimationFrame` is not used: tests and workers do not pump it.
 */
export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
