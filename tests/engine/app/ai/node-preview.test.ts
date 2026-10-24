import { describe, expect, test } from 'bun:test'

import { SceneGraph } from '@open-pencil/scene-graph'

import { renderNodePreview } from '@/app/ai/attachment/node/preview'

describe('chat node preview', () => {
  test('rasterizes a referenced node on its own page, not the page on screen', () => {
    const graph = new SceneGraph()
    const components = graph.addPage('Components')
    const node = graph.createNode('COMPONENT', components.id, {
      name: 'Status icon components',
      width: 40,
      height: 40
    })
    const renderer = { ck: {} }

    // The page check throws before CanvasKit. Reaching Malloc means the node's own page was used.
    expect(() => renderNodePreview(graph, renderer as never, node.id, 40)).toThrow(/Malloc/)
  })
})
