<script setup lang="ts">
import { useObjectUrl } from '@vueuse/core'
import { shallowRef, watch } from 'vue'

import type { Editor } from '@open-pencil/core/editor'

import { renderNodePreview } from '@/app/ai/attachment/node/preview'
import type { ReferencedNode } from '@/app/ai/chat/context'

const { editor, node } = defineProps<{ editor: Editor; node: ReferencedNode }>()
const blob = shallowRef<Blob | null>(null)
const previewURL = useObjectUrl(blob)
let requestId = 0

watch(
  () => node.id,
  async () => {
    const request = ++requestId
    const renderer = editor.renderer
    if (!renderer || !editor.graph.getNode(node.id)) return
    let data: Uint8Array | null = null
    try {
      data = renderNodePreview(editor.graph, renderer, node.id, 40)
    } catch (error) {
      console.warn('Node preview skipped', error)
    }
    if (request === requestId) blob.value = data ? new Blob([data], { type: 'image/png' }) : null
  },
  { immediate: true }
)
</script>

<template>
  <img
    v-if="previewURL"
    :src="previewURL"
    alt=""
    class="size-10 shrink-0 rounded-md border border-border bg-canvas object-contain"
  />
  <div
    v-else
    class="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-canvas"
  >
    <icon-lucide-box class="size-4 text-muted" aria-hidden="true" />
  </div>
</template>
