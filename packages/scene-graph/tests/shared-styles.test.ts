import { describe, expect, test } from 'bun:test'

import { SceneGraph, type Fill } from '@open-pencil/scene-graph'

const YELLOW: Fill = {
  type: 'SOLID',
  color: { r: 201 / 255, g: 224 / 255, b: 0, a: 1 },
  opacity: 1,
  visible: true
}

const RED: Fill = {
  type: 'SOLID',
  color: { r: 1, g: 0, b: 0, a: 1 },
  opacity: 1,
  visible: true
}

describe('style detachment', () => {
  test('style runs that override a fill clear fillStyleId', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    const text = graph.createNode('TEXT', page.id, {
      text: 'Hello',
      fills: [YELLOW],
      fillStyleId: '1:72'
    })

    graph.updateNode(text.id, {
      styleRuns: [{ start: 0, length: 5, style: { fills: [RED], fillStyleId: null } }]
    })

    const updated = graph.getNode(text.id)
    expect(updated?.fillStyleId).toBeNull()
    expect(updated?.styleRuns).toEqual([
      { start: 0, length: 5, style: { fills: [RED], fillStyleId: null } }
    ])
    expect(updated?.fills).toEqual([YELLOW])
  })

  test('a font-size style run keeps fillStyleId', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    const text = graph.createNode('TEXT', page.id, {
      text: 'Hello',
      fills: [YELLOW],
      fillStyleId: '1:72'
    })

    graph.updateNode(text.id, {
      styleRuns: [{ start: 0, length: 5, style: { fontSize: 32 } }]
    })

    expect(graph.getNode(text.id)?.fillStyleId).toBe('1:72')
  })

  test('a fills patch still clears fillStyleId', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    const rect = graph.createNode('RECTANGLE', page.id, {
      fills: [YELLOW],
      fillStyleId: '1:72'
    })

    graph.updateNode(rect.id, { fills: [RED] })

    expect(graph.getNode(rect.id)?.fillStyleId).toBeNull()
    expect(graph.getNode(rect.id)?.fills).toEqual([RED])
  })
})
