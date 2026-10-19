import { findPageId, renderNodesToImage } from '@open-pencil/core/io'

import type { NodePresentation } from '@/app/ai/attachment/presentation/types'
import type { ReferencedNode } from '@/app/ai/chat/context'
import type { EditorStore } from '@/app/editor/active-store'

export function snapshotNode(
  store: EditorStore,
  messageId: string,
  node: ReferencedNode
): NodePresentation | null {
  const renderer = store.renderer
  const liveNode = store.graph.getNode(node.id)
  const pageId = findPageId(store.graph, node.id)
  if (!renderer || !liveNode || !pageId) return null
  const maxDimension = Math.max(liveNode.width, liveNode.height, 1)
  let data: Uint8Array | null
  try {
    data = renderNodesToImage(renderer.ck, renderer, store.graph, pageId, [node.id], {
      scale: 320 / maxDimension,
      format: 'PNG'
    })
  } catch (error) {
    console.warn('[Chat] Could not preview a referenced layer:', error)
    return null
  }
  if (!data) return null
  const previewBytes = new Uint8Array(data.byteLength)
  previewBytes.set(data)
  return {
    id: crypto.randomUUID(),
    messageId,
    kind: 'node',
    name: node.name || node.type,
    preview: new Blob([previewBytes.buffer], { type: 'image/png' }),
    nodeId: node.id,
    nodeType: node.type,
    originalSize: { x: liveNode.width, y: liveNode.height }
  }
}
