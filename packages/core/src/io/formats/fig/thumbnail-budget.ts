import type { SceneGraph } from '@open-pencil/scene-graph'

/**
 * A save thumbnail paints the page through a viewport large enough to include every layer,
 * and that decodes every image fill (including mipmaps) just before the archive patch is
 * cloned. Past these limits the decode exhausts the tab, so the save keeps the thumbnail
 * the file already has.
 */
const FIG_THUMBNAIL_MAX_NODES = 2_500
const FIG_THUMBNAIL_MAX_IMAGES = 64
const FIG_THUMBNAIL_MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function figThumbnailIsExpensive(graph: SceneGraph): boolean {
  if (graph.nodes.size > FIG_THUMBNAIL_MAX_NODES) return true
  let images = 0
  let bytes = 0
  for (const data of graph.images.values()) {
    images += 1
    bytes += data.byteLength
    if (images > FIG_THUMBNAIL_MAX_IMAGES || bytes > FIG_THUMBNAIL_MAX_IMAGE_BYTES) return true
  }
  return false
}

/** True when a thumbnail render or the following archive `postMessage` ran out of memory. */
export function isFigSaveMemoryError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    if (error.name === 'DataCloneError' || error.name === 'QuotaExceededError') return true
  }
  if (error instanceof RangeError) return true
  if (!(error instanceof Error)) return false
  if (error.name === 'DataCloneError') return true
  const message = error.message.toLowerCase()
  return (
    message.includes('data cannot be cloned') ||
    message.includes('could not be cloned') ||
    message.includes('out of memory') ||
    /\boom\b/.test(message) ||
    message.includes('allocation failed') ||
    message.includes('memory access out of bounds')
  )
}
