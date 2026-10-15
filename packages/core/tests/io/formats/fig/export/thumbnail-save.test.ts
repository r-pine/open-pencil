import { expect, test } from 'bun:test'

import type { CanvasKit } from 'canvaskit-wasm'
import { unzipSync, zipSync } from 'fflate'

import { exportFigFile, initCodec, parseFigFile, SceneGraph } from '@open-pencil/core'

import type { SkiaRenderer } from '#core/canvas/renderer'
import { figThumbnailIsExpensive } from '#core/io/formats/fig/thumbnail-budget'
import { releaseFigArchive } from '#core/kiwi/fig/session/archive'

const MARKER = new Uint8Array([9, 9, 9, 1, 2, 3, 4])

function replaceThumbnail(bytes: Uint8Array, thumbnail: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes)
  entries['thumbnail.png'] = thumbnail
  return zipSync(entries)
}

async function openedDocument(): Promise<{ graph: SceneGraph; pageId: string }> {
  await initCodec()
  const source = new SceneGraph()
  const pageId = source.getPages()[0].id
  source.createNode('RECTANGLE', pageId, { name: 'Box', width: 20, height: 20 })
  const bytes = replaceThumbnail(await exportFigFile(source), MARKER)
  const graph = await parseFigFile(bytes.slice().buffer as ArrayBuffer, { populate: 'first-page' })
  return { graph, pageId: graph.getPages()[0].id }
}

function renderer(hooks: {
  onPaint?: () => void
  onRelease?: () => void
}): SkiaRenderer {
  return {
    imageCache: { clear: () => hooks.onRelease?.() },
    invalidateAllPictures: () => undefined,
    renderSceneToCanvas: () => hooks.onPaint?.()
  } as SkiaRenderer
}

function canvasKit(onAllocate: () => void): CanvasKit {
  return { Malloc: () => onAllocate() } as CanvasKit
}

test('a small document still attempts a save thumbnail', async () => {
  const { graph, pageId } = await openedDocument()
  const box = [...graph.nodes.values()].find((node) => node.name === 'Box')
  if (!box) throw new Error('Missing layer')
  graph.updateNode(box.id, { name: 'Box renamed' })
  let painted = false
  const saved = await exportFigFile(
    graph,
    canvasKit(() => {
      painted = true
      throw new Error('render-started')
    }),
    renderer({}),
    pageId
  )
  releaseFigArchive(graph)
  expect(painted).toBe(true)
  expect(saved.byteLength).toBeGreaterThan(0)
  const reopened = await parseFigFile(saved.slice().buffer as ArrayBuffer, {
    populate: 'first-page'
  })
  expect([...reopened.nodes.values()].some((node) => node.name === 'Box renamed')).toBe(true)
  releaseFigArchive(reopened)
})

test('a large document saves without painting a thumbnail and keeps the archive one', async () => {
  const { graph, pageId } = await openedDocument()
  const box = [...graph.nodes.values()].find((node) => node.name === 'Box')
  if (!box) throw new Error('Missing layer')
  graph.updateNode(box.id, { name: 'Box renamed' })
  for (let index = 0; index < 70; index++) graph.images.set(`img-${index}`, new Uint8Array(8))
  expect(figThumbnailIsExpensive(graph)).toBe(true)
  let painted = false
  const saved = await exportFigFile(
    graph,
    canvasKit(() => {
      painted = true
    }),
    renderer({ onPaint: () => (painted = true) }),
    pageId
  )
  releaseFigArchive(graph)
  const entries = unzipSync(saved)
  expect(painted).toBe(false)
  expect(entries['thumbnail.png']).toEqual(MARKER)
  expect(entries['images/img-0']).toEqual(new Uint8Array(8))
  const reopened = await parseFigFile(saved.slice().buffer as ArrayBuffer, {
    populate: 'first-page'
  })
  expect([...reopened.nodes.values()].some((node) => node.name === 'Box renamed')).toBe(true)
  releaseFigArchive(reopened)
})

test('a thumbnail that runs out of memory is skipped and the document still saves', async () => {
  const { graph, pageId } = await openedDocument()
  const box = [...graph.nodes.values()].find((node) => node.name === 'Box')
  if (!box) throw new Error('Missing layer')
  graph.updateNode(box.id, { name: 'Box renamed' })
  let released = false
  const saved = await exportFigFile(
    graph,
    canvasKit(() => {
      const error = new Error('postMessage on MessagePort: Data cannot be cloned, out of memory')
      error.name = 'DataCloneError'
      throw error
    }),
    renderer({ onRelease: () => (released = true) }),
    pageId
  )
  releaseFigArchive(graph)
  expect(released).toBe(true)
  expect(unzipSync(saved)['thumbnail.png']).toEqual(MARKER)
})

test('thumbnail cost follows node count, image count, and image bytes', () => {
  const small = new SceneGraph()
  expect(figThumbnailIsExpensive(small)).toBe(false)
  small.images.set('one', new Uint8Array(32))
  expect(figThumbnailIsExpensive(small)).toBe(false)

  const manyImages = new SceneGraph()
  for (let index = 0; index < 65; index++) manyImages.images.set(String(index), new Uint8Array(4))
  expect(figThumbnailIsExpensive(manyImages)).toBe(true)

  const heavy = new SceneGraph()
  heavy.images.set('bitmap', new Uint8Array(8 * 1024 * 1024 + 1))
  expect(figThumbnailIsExpensive(heavy)).toBe(true)

  const crowded = new SceneGraph()
  const pageId = crowded.getPages()[0].id
  while (crowded.nodes.size <= 2500) crowded.createNode('RECTANGLE', pageId, { width: 1, height: 1 })
  expect(figThumbnailIsExpensive(crowded)).toBe(true)
})
