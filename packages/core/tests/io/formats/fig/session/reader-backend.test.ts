import { expect, test } from 'bun:test'

import { exportFigFile } from '@open-pencil/core/io'
import { initCodec } from '@open-pencil/core/kiwi'
import { SceneGraph } from '@open-pencil/scene-graph'

import { openReaderSession } from '#core/kiwi/fig/session/reader'

test('replacement worker backend opens first page and populates by graph page ID', async () => {
  await initCodec()
  const graph = new SceneGraph()
  graph.createNode('TEXT', graph.getPages()[0].id, { text: 'First' })
  graph.createNode('TEXT', graph.addPage('Second').id, { text: 'Second' })
  const bytes = await exportFigFile(graph)
  const session = openReaderSession(bytes.buffer as ArrayBuffer, 'first-page')
  const pages = session.graph.getPages()
  expect(session.graph.getChildren(pages[0].id)).toHaveLength(1)
  expect(session.graph.getChildren(pages[1].id)).toHaveLength(0)
  expect(session.graph.figSchemaDeflated).not.toBeNull()
  expect(session.populate(pages[1].id).populated).toBe(true)
  expect(session.graph.getChildren(pages[1].id)[0].text).toBe('Second')
  const again = session.populate(pages[1].id)
  expect(again.populated).toBe(true)
  expect(again.delta.created.some(([, node]) => node.text === 'Second')).toBe(true)
  expect(session.graph.getChildren(pages[1].id)).toHaveLength(1)
  expect(() => session.populate('missing')).toThrow('Unknown graph page')
})
