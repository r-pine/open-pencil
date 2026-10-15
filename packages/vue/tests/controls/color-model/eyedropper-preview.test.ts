import { describe, expect, test } from 'bun:test'
import { effectScope, nextTick, ref } from 'vue'

import type { Color } from '@open-pencil/scene-graph/primitives'
import { useColorModel } from '@open-pencil/vue'

const BOUND: Color = { r: 201 / 255, g: 224 / 255, b: 0, a: 1 }

describe('useColorModel eyedropper preview', () => {
  test('shows the sampled color while the bound source stays put', async () => {
    const scope = effectScope()
    const color = ref<Color>({ ...BOUND })
    let updates = 0
    const model = scope.run(() =>
      useColorModel({
        color,
        onUpdate: () => {
          updates += 1
        }
      })
    )
    if (!model) throw new Error('color model did not start')

    model.updateHex('#3366ff')
    await nextTick()

    expect(updates).toBe(1)
    expect(Math.round(model.rgb.value.r)).toBe(0x33)
    expect(Math.round(model.rgb.value.g)).toBe(0x66)
    expect(Math.round(model.rgb.value.b)).toBe(0xff)
    expect(Math.round(model.hsl.value.h)).toBeGreaterThan(200)
    expect(Math.round(model.hsb.value.h)).toBeGreaterThan(200)
    expect(model.okhcl.value.h).toBeGreaterThan(200)
    scope.stop()
  })

  test('drops the preview once the source color catches up', async () => {
    const scope = effectScope()
    const color = ref<Color>({ ...BOUND })
    const model = scope.run(() =>
      useColorModel({
        color,
        onUpdate: (next) => {
          color.value = next
        }
      })
    )
    if (!model) throw new Error('color model did not start')

    model.updateHex('#3366ff')
    await nextTick()

    expect(Math.round(model.rgb.value.r)).toBe(0x33)
    expect(Math.round(model.rgb.value.b)).toBe(0xff)
    scope.stop()
  })

  test('follows a later source change such as undo', async () => {
    const scope = effectScope()
    const color = ref<Color>({ ...BOUND })
    const model = scope.run(() =>
      useColorModel({
        color,
        onUpdate: () => {}
      })
    )
    if (!model) throw new Error('color model did not start')

    model.updateHex('#3366ff')
    await nextTick()
    color.value = { r: 0, g: 0, b: 0, a: 1 }
    await nextTick()

    expect(Math.round(model.rgb.value.r)).toBe(0)
    expect(Math.round(model.rgb.value.g)).toBe(0)
    expect(Math.round(model.rgb.value.b)).toBe(0)
    scope.stop()
  })
})
