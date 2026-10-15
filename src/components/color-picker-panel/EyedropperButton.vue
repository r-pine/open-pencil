<script setup lang="ts">
import { tv } from 'tailwind-variants'
import { computed, ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { useColorPickerPanelContext } from '@/components/color-picker-panel/context'
import {
  eyeDropperActive,
  isEyeDropperSupported,
  releaseEyeDropperGuard,
  sampleScreenColor
} from '@/components/color-picker-panel/eyedropper'
import Tip from '@/components/ui/overlay/Tip.vue'
import theme from '@/theme/button/icon-button'

const ctx = useColorPickerPanelContext()
const { panels } = useI18n()
const picking = ref(false)
const supported = isEyeDropperSupported()

const label = computed(() =>
  supported ? panels.value.eyedropper : panels.value.eyedropperUnsupported
)

const unavailable = computed(() => !supported || picking.value)

const cls = computed(() =>
  tv(theme)({
    size: 'xs',
    disabled: unavailable.value,
    active: picking.value
  })
)

async function onPick() {
  if (!supported || picking.value) return
  picking.value = true
  eyeDropperActive.value = true
  // Capture before await — panel context must still apply after EyeDropper yields even if
  // DismissableLayer races a dismiss (we also keep the popover open via eyeDropperActive).
  const applyHex = ctx.updateHex
  try {
    const hex = await sampleScreenColor()
    if (hex) applyHex(hex)
  } finally {
    picking.value = false
    // Keep the guard up until after apply + outside-click handlers settle.
    await releaseEyeDropperGuard()
  }
}
</script>

<template>
  <!-- Wrapper keeps the tooltip reachable when the control is aria-disabled. -->
  <Tip :label="label">
    <span class="inline-flex shrink-0">
      <button
        type="button"
        data-test-id="color-eyedropper"
        :aria-label="label"
        :aria-disabled="unavailable ? 'true' : undefined"
        :class="cls"
        @click="onPick"
      >
        <icon-lucide-pipette class="size-3.5" aria-hidden="true" />
      </button>
    </span>
  </Tip>
</template>
