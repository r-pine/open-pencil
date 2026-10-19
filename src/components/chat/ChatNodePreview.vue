<script setup lang="ts">
import { useObjectUrl } from '@vueuse/core'
import { shallowRef, watch } from 'vue'

import type { Editor } from '@open-pencil/core/editor'
import { findPageId, renderNodesToImage } from '@open-pencil/core/io'

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
    const liveNode = editor.graph.getNode(node.id)
    const pageId = findPageId(editor.graph, node.id)
    if (!renderer || !liveNode || !pageId) return
    const maxDimension = Math.max(liveNode.width, liveNode.height, 1)
    let data: Uint8Array | null
    try {
      data = renderNodesToImage(renderer.ck, renderer, editor.graph, pageId, [node.id], {
        scale: 40 / maxDimension,
        format: 'PNG'
      })
    } catch (error) {
      console.warn('[Chat] Could not preview a referenced layer:', error)
      return
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
