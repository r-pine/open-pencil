import { findPageId, renderNodesToImage } from '@open-pencil/core/io'

type RasterGraph = Parameters<typeof renderNodesToImage>[2]
type RasterRenderer = Parameters<typeof renderNodesToImage>[1]

/**
 * Rasterizes one referenced node on the page that owns it. Chat attachments are often
 * components on another page than the one on screen, and the exporter rejects that mix.
 */
export function renderNodePreview(
  graph: RasterGraph,
  renderer: { ck: Parameters<typeof renderNodesToImage>[0] } & RasterRenderer,
  nodeId: string,
  longestEdge: number
): Uint8Array | null {
  const node = graph.getNode(nodeId)
  const pageId = findPageId(graph, nodeId)
  if (!node || !pageId) return null
  const maxDimension = Math.max(node.width, node.height, 1)
  return renderNodesToImage(renderer.ck, renderer, graph, pageId, [nodeId], {
    scale: longestEdge / maxDimension,
    format: 'PNG'
  })
}
