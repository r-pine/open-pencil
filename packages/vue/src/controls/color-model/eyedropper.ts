import { nextTick, ref } from 'vue'

import { tryParseColor } from '@open-pencil/scene-graph/color'

/** True while the browser EyeDropper UI is open — popovers must ignore outside dismiss. */
export const eyeDropperActive = ref(false)

export function isEyeDropperSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as EyeDropperWindow).EyeDropper === 'function'
}

type EyeDropperWindow = Window &
  typeof globalThis & {
    EyeDropper?: new () => {
      open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>
    }
  }

/**
 * Hold the flag until after the click that finished EyeDropper is fully processed, so
 * DismissableLayer outside/focus handlers still see it as active and do not cancel the picker.
 * Chromium often delivers that click (and focus changes) a few frames after `open()` resolves.
 */
export async function releaseEyeDropperGuard(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  // One macrotask later catches late focusin/pointer handlers after the rAF flush.
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
  eyeDropperActive.value = false
}

/** Samples a screen pixel via the browser EyeDropper API. Returns `#rrggbb` or `null` if cancelled. */
export async function sampleScreenColor(signal?: AbortSignal): Promise<string | null> {
  const EyeDropperCtor = (window as EyeDropperWindow).EyeDropper
  if (!EyeDropperCtor) return null
  const eyeDropper = new EyeDropperCtor()
  try {
    const result = await eyeDropper.open(signal ? { signal } : undefined)
    const hex = result.sRGBHex?.trim()
    if (!hex) return null
    // Normalize to #rrggbb so updateHex / culori always accept the sample (some builds yield #rrggbbaa).
    const parsed = tryParseColor(hex.startsWith('#') ? hex : `#${hex}`)
    if (!parsed) return null
    const r = Math.round(parsed.r * 255)
      .toString(16)
      .padStart(2, '0')
    const g = Math.round(parsed.g * 255)
      .toString(16)
      .padStart(2, '0')
    const b = Math.round(parsed.b * 255)
      .toString(16)
      .padStart(2, '0')
    return `#${r}${g}${b}`
  } catch {
    // User cancelled (Escape) or the browser aborted the session.
    return null
  }
}
