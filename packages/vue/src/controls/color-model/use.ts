import { computed, ref, toValue, watch } from 'vue'

import { colorToHexRaw, okhclToRGBA, tryParseColor } from '@open-pencil/scene-graph/color'
import type { Color } from '@open-pencil/scene-graph/primitives'

import {
  applyOkHCLPatch,
  colorsEqual,
  createColorModelValue,
  createOkHCLSliderGradientModel,
  createOkHCLSliderPreviewModel,
  createSliderGradientModel,
  createSliderPreviewModel,
  normalizeOkHCLPatch,
  okhclPatchChangesColor,
  rekaToSceneColor,
  withAlpha,
  withHSBChannel,
  withHSLChannel,
  withHue,
  withRGBChannel
} from '#vue/controls/color-model/model'
import type {
  ColorFieldFormat,
  HSBChannel,
  HSLChannel,
  OkHCLChannel,
  RGBChannel,
  RekaColorValue,
  UseColorModelOptions
} from '#vue/controls/color-model/types'

/** Built-in presentation formats understood by the color model. */
export const BUILT_IN_COLOR_FORMATS = ['hex', 'rgb', 'hsl', 'hsb', 'okhcl'] as const

/**
 * Creates reactive color-space values, channel actions, and slider presentation data without
 * requiring an editor context.
 */
export function useColorModel(options: UseColorModelOptions) {
  const localFormat = ref<ColorFieldFormat>(options.defaultFormat ?? 'rgb')
  /**
   * The color the user just chose, shown before the bound fill prop catches up.
   * A variable or style binding keeps feeding the previous resolved color into `options.color`,
   * so the swatch and RGB/HSL/HSB/OkHCL fields would otherwise stay on that color after an
   * eyedropper sample even though the canvas fill already changed.
   */
  const preview = ref<Color | null>(null)
  let acceptingPreviewEcho = false
  const sourceColor = computed(() => toValue(options.color))
  const color = computed(() => preview.value ?? sourceColor.value)
  const sourceOkHCL = computed(() => {
    // While a sample is pinned, channels come from that RGBA. The stored OkHCL still
    // describes the previous variable or style color.
    if (preview.value) return undefined
    return toValue(options.okhcl)
  })
  const value = computed(() => createColorModelValue(color.value, sourceOkHCL.value))
  const format = computed(() => toValue(options.format) ?? localFormat.value)
  const hex = computed(() => colorToHexRaw(color.value))
  const sliderPreview = computed(() => createSliderPreviewModel(value.value))
  const sliderGradient = computed(() => createSliderGradientModel(value.value))
  const okhclSliderPreview = computed(() => createOkHCLSliderPreviewModel(value.value.okhcl))
  const okhclSliderGradient = computed(() => createOkHCLSliderGradientModel(value.value.okhcl))

  watch(sourceColor, (next, prev) => {
    const shown = preview.value
    if (!shown) return
    if (colorsEqual(shown, next)) {
      preview.value = null
      return
    }
    // A new object with the same channels is still the bound color the sample replaced.
    if (!prev || colorsEqual(prev, next)) return
    // Undo or another edit replaced the sample. Keep the preview through the echo of this edit.
    if (!acceptingPreviewEcho) preview.value = null
  })

  function emitColor(nextColor: Color): Color {
    if (colorsEqual(color.value, nextColor)) return nextColor
    preview.value = nextColor
    acceptingPreviewEcho = true
    try {
      options.onUpdate?.(nextColor)
    } finally {
      acceptingPreviewEcho = false
    }
    return nextColor
  }

  function updateHex(input: string) {
    const raw = input.trim()
    const parsed = tryParseColor(raw.startsWith('#') ? raw : `#${raw}`)
    // Reject invalid input instead of falling back to black (EyeDropper / hex field).
    if (!parsed) return color.value
    return emitColor({ ...parsed, a: color.value.a })
  }

  function setFormat(nextFormat: ColorFieldFormat) {
    if (format.value === nextFormat) return
    localFormat.value = nextFormat
    options.onFormatChange?.(nextFormat)
  }

  function updateFromReka(nextColor: RekaColorValue) {
    return emitColor(rekaToSceneColor(nextColor))
  }

  function updateHue(hue: number) {
    return emitColor(withHue(value.value, hue))
  }

  function updateAlpha(alpha: number) {
    return emitColor(withAlpha(color.value, alpha))
  }

  function updateRGBChannel(channel: RGBChannel, channelValue: number) {
    return emitColor(withRGBChannel(color.value, channel, channelValue))
  }

  function updateHSLChannel(channel: HSLChannel, channelValue: number) {
    return emitColor(withHSLChannel(value.value, channel, channelValue))
  }

  function updateHSBChannel(channel: HSBChannel, channelValue: number) {
    return emitColor(withHSBChannel(value.value, channel, channelValue))
  }

  function updateOkHCLChannel(channel: OkHCLChannel, channelValue: number) {
    const patch = normalizeOkHCLPatch(channel, channelValue)
    if (!okhclPatchChangesColor(value.value.okhcl, patch)) return value.value.okhcl

    if (options.onUpdateOkHCL) {
      options.onUpdateOkHCL(patch)
      return applyOkHCLPatch(value.value.okhcl, patch)
    }

    const next = applyOkHCLPatch(value.value.okhcl, patch)
    emitColor(okhclToRGBA(next))
    return next
  }

  return {
    color,
    format,
    hex,
    rekaColor: computed(() => value.value.rekaColor),
    rgb: computed(() => value.value.rgb),
    hsl: computed(() => value.value.hsl),
    hsb: computed(() => value.value.hsb),
    okhcl: computed(() => value.value.okhcl),
    sliderPreview,
    sliderGradient,
    okhclSliderPreview,
    okhclSliderGradient,
    setFormat,
    updateColor: emitColor,
    updateHex,
    updateFromReka,
    updateHue,
    updateAlpha,
    updateRGBChannel,
    updateHSLChannel,
    updateHSBChannel,
    updateOkHCLChannel
  }
}
