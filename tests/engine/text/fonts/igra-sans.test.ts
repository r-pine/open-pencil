import { describe, expect, test } from 'bun:test'

import { documentFontStatus, FontManager, SceneGraph } from '@open-pencil/core'

describe('Igra Sans', () => {
  test('Regular is bundled, so a page that uses it is not substituted', async () => {
    const manager = new FontManager()
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    if (!page) throw new Error('Expected default page')
    graph.createNode('TEXT', page.id, {
      name: 'Ask a',
      fontFamily: 'Igra Sans',
      fontWeight: 400,
      text: 'Аска'
    })

    const data = await manager.loadFont('Igra Sans', 'Regular')
    expect(data).toBeTruthy()
    expect(manager.loadedFontSource('Igra Sans', 'Regular')).toBe('bundled')
    expect(documentFontStatus(graph, page.id, manager).faithful).toBe(true)
  })
})
