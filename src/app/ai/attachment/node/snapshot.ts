import { renderNodePreview } from '@/app/ai/attachment/node/preview'

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
  if (!renderer || !liveNode) return null
  let data: Uint8Array | null
  try {
    data = renderNodePreview(store.graph, renderer, node.id, 320)
  } catch (error) {
    console.warn('Node preview skipped', error)
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
