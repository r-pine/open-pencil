<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import type { FocusOutsideEvent, PointerDownOutsideEvent } from 'reka-ui'
import { computed } from 'vue'

import { colorToCSS } from '@open-pencil/scene-graph/color'
import type { Color } from '@open-pencil/scene-graph/primitives'

import { eyeDropperActive } from '#vue/controls/color-model/eyedropper'
import { useRetainedPopup } from '#vue/lifecycle/retention/popup'

export interface ColorPickerUI {
  content?: string
  swatch?: string
}

const {
  color,
  label = 'Edit color',
  ui
} = defineProps<{
  color: Color
  label?: string
  ui?: ColorPickerUI
}>()

const emit = defineEmits<{
  update: [color: Color]
  openChange: [open: boolean]
  cancel: []
}>()

const swatchBg = computed(() => colorToCSS(color))
const { open: popupOpen, portalActive } = useRetainedPopup(undefined, () => {
  emit('cancel')
  emit('openChange', false)
})

function cancelFromEscape(event: KeyboardEvent) {
  if (eyeDropperActive.value) {
    event.preventDefault()
    return
  }
  event.stopPropagation()
  emit('cancel')
}

function retainWhileEyedropping(event: PointerDownOutsideEvent | FocusOutsideEvent) {
  if (eyeDropperActive.value) event.preventDefault()
}

/** Last line of defense: DismissableLayer can still race the EyeDropper click past preventDefault. */
function onOpenChange(open: boolean) {
  if (!open && eyeDropperActive.value) {
    popupOpen.value = true
    return
  }
  emit('openChange', open)
}
</script>

<template>
  <PopoverRoot v-model:open="popupOpen" @update:open="onOpenChange">
    <PopoverTrigger as-child>
      <slot name="trigger" :style="{ background: swatchBg }">
        <button
          type="button"
          :aria-label="label"
          :class="ui?.swatch"
          :style="{ background: swatchBg }"
        />
      </slot>
    </PopoverTrigger>

    <PopoverPortal v-if="portalActive">
      <PopoverContent
        :class="ui?.content"
        :side-offset="4"
        side="left"
        data-picker-content
        @escape-key-down="cancelFromEscape"
        @pointer-down-outside="retainWhileEyedropping"
        @focus-outside="retainWhileEyedropping"
        @interact-outside="retainWhileEyedropping"
      >
        <slot :color="color" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
