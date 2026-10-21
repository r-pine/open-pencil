import { expect, test } from 'bun:test'

import { SceneGraph } from '@open-pencil/scene-graph'

import {
  figPageThumbnailIsExpensive,
  figThumbnailIsExpensive
} from '#core/io/formats/fig/thumbnail-budget'

test('a small cover page can be painted inside a file that has too many images', () => {
  const graph = new SceneGraph()
  const cover = graph.addPage('00 Обложка')
  graph.createNode('FRAME', cover.id, { name: 'Board', width: 100, height: 100 })
  for (let index = 0; index < 70; index++) graph.images.set(`img-${index}`, new Uint8Array([1]))

  expect(figThumbnailIsExpensive(graph)).toBe(true)
  expect(figPageThumbnailIsExpensive(graph, cover.id)).toBe(false)
})

test('an unloaded page of a large file is not painted over the existing thumbnail', () => {
  const graph = new SceneGraph()
  const pending = graph.addPage('00 Обложка')
  for (let index = 0; index < 70; index++) graph.images.set(`img-${index}`, new Uint8Array([1]))

  expect(figPageThumbnailIsExpensive(graph, pending.id)).toBe(true)
})
