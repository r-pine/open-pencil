import { expect, test } from 'bun:test'

import { SceneGraph } from '@open-pencil/scene-graph'

import { createPopulationWorkerClient } from '#core/kiwi/fig/population/client'
import { trackArchiveChanges } from '#core/kiwi/fig/session/archive-changes'
import type { FigSessionPopulateRequest, FigSessionResponse } from '#core/kiwi/fig/session/protocol'

test('aborting a population request leaves the worker up and ignores the late result', async () => {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  let terminated = false
  let request: FigSessionPopulateRequest | undefined
  const port = {
    onmessage: null as ((event: MessageEvent<FigSessionResponse>) => void) | null,
    postMessage: (message: FigSessionPopulateRequest) => {
      request = message
    },
    start: () => undefined,
    close: () => undefined
  }
  const worker = {
    terminate: () => {
      terminated = true
    },
    postMessage: () => undefined,
    onerror: null,
    onmessage: null
  }
  const client = createPopulationWorkerClient(graph, worker, port)
  const controller = new AbortController()
  const pending = client.populate(page.id, controller.signal)
  const abandoned = request
  controller.abort()
  await expect(pending).rejects.toThrow('Aborted')
  expect(terminated).toBe(false)
  if (!abandoned) throw new Error('Missing request')
  port.onmessage?.(
    new MessageEvent<FigSessionResponse>('message', {
      data: {
        type: 'population-result',
        requestId: abandoned.requestId,
        baseRevision: abandoned.baseRevision,
        populated: true,
        delta: {
          created: [],
          updated: [[page.id, { name: 'Late' }]],
          deleted: [],
          instanceIndex: [],
          populatedRootIds: [page.id]
        }
      }
    })
  )
  expect(page.name).not.toBe('Late')
  const again = client.populate(page.id)
  if (!request || request === abandoned) throw new Error('Missing follow-up request')
  port.onmessage?.(
    new MessageEvent<FigSessionResponse>('message', {
      data: {
        type: 'population-result',
        requestId: request.requestId,
        baseRevision: request.baseRevision,
        populated: true,
        delta: {
          created: [],
          updated: [[page.id, { name: 'Loaded' }]],
          deleted: [],
          instanceIndex: [],
          populatedRootIds: [page.id]
        }
      }
    })
  )
  expect(await again).toBe(true)
  expect(page.name).toBe('Loaded')
  expect(terminated).toBe(false)
  client.terminate()
})

for (const mutation of ['local-child', 'reorder', 'wrong-revision'] as const) {
  test(`rejects population deltas after ${mutation}`, async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    const first = graph.createNode('RECTANGLE', page.id)
    const second = graph.createNode('RECTANGLE', page.id)
    let request: FigSessionPopulateRequest | undefined
    const port = {
      onmessage: null as ((event: MessageEvent<FigSessionResponse>) => void) | null,
      start: () => undefined,
      close: () => undefined,
      postMessage(message: FigSessionPopulateRequest) {
        request = message
      }
    }
    const worker = {
      terminate: () => undefined,
      postMessage: () => undefined,
      onerror: null,
      onmessage: null
    }
    const client = createPopulationWorkerClient(graph, worker, port)
    try {
      const pending = client.populate(page.id)
      if (!request) throw new Error('Missing request')
      if (mutation === 'local-child') graph.createNode('RECTANGLE', page.id)
      if (mutation === 'reorder') graph.insertChildAt(second.id, page.id, 0)
      const expected = [...page.childIds]
      port.onmessage?.(
        new MessageEvent<FigSessionResponse>('message', {
          data: {
            type: 'population-result',
            requestId: request.requestId,
            baseRevision: request.baseRevision + (mutation === 'wrong-revision' ? 1 : 0),
            populated: true,
            delta: {
              created: [],
              updated: [[page.id, { childIds: [first.id] }]],
              deleted: [],
              instanceIndex: [],
              populatedRootIds: [page.id]
            }
          }
        })
      )
      expect(await pending).toBeNull()
      expect(page.childIds).toEqual(expected)
    } finally {
      client.terminate()
    }
  })
}

test('a later archive load keeps edited layers and still adds the unloaded page', async () => {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const kept = graph.createNode('RECTANGLE', page.id, { name: 'Kept' })
  trackArchiveChanges(graph)
  const port = {
    onmessage: null as ((event: MessageEvent<FigSessionResponse>) => void) | null,
    start: () => undefined,
    close: () => undefined,
    postMessage(_message: FigSessionPopulateRequest) {}
  }
  const worker = {
    terminate: () => undefined,
    postMessage: () => undefined,
    onerror: null,
    onmessage: null
  }
  const client = createPopulationWorkerClient(graph, worker, port)
  graph.updateNode(kept.id, { name: 'Edited' })
  const second = graph.addPage('Second')
  const extra = graph.createNode('RECTANGLE', second.id, { name: 'Extra' })
  const born = structuredClone(kept)
  born.id = 'born'
  born.name = 'Born'
  born.parentId = second.id
  born.childIds = []
  let request: FigSessionPopulateRequest | undefined
  port.postMessage = (message) => {
    request = message
  }
  try {
    expect(await client.populate(second.id)).toBeNull()
    const loading = client.populateFromArchive(second.id)
    if (!request) throw new Error('Missing request')
    port.onmessage?.(
      new MessageEvent<FigSessionResponse>('message', {
        data: {
          type: 'population-result',
          requestId: request.requestId,
          baseRevision: request.baseRevision,
          populated: true,
          delta: {
            created: [[born.id, born]],
            updated: [
              [kept.id, { name: 'From file' }],
              [second.id, { name: 'From file', childIds: [born.id] }]
            ],
            deleted: [kept.id],
            instanceIndex: [],
            populatedRootIds: [second.id]
          }
        }
      })
    )
    expect(await loading).toBe(true)
    expect(graph.getNode(kept.id)?.name).toBe('Edited')
    expect(graph.getNode(born.id)?.name).toBe('Born')
    expect(graph.getNode(second.id)?.name).toBe('Second')
    expect(second.childIds).toEqual([born.id, extra.id])
  } finally {
    client.terminate()
  }
})

test('an edit during an archive load drops that load', async () => {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const kept = graph.createNode('RECTANGLE', page.id, { name: 'Kept' })
  trackArchiveChanges(graph)
  let request: FigSessionPopulateRequest | undefined
  const port = {
    onmessage: null as ((event: MessageEvent<FigSessionResponse>) => void) | null,
    start: () => undefined,
    close: () => undefined,
    postMessage(message: FigSessionPopulateRequest) {
      request = message
    }
  }
  const worker = {
    terminate: () => undefined,
    postMessage: () => undefined,
    onerror: null,
    onmessage: null
  }
  const client = createPopulationWorkerClient(graph, worker, port)
  graph.updateNode(kept.id, { name: 'Edited' })
  try {
    const loading = client.populateFromArchive(page.id)
    if (!request) throw new Error('Missing request')
    graph.updateNode(kept.id, { name: 'Again' })
    const expected = [...page.childIds]
    port.onmessage?.(
      new MessageEvent<FigSessionResponse>('message', {
        data: {
          type: 'population-result',
          requestId: request.requestId,
          baseRevision: request.baseRevision,
          populated: true,
          delta: {
            created: [],
            updated: [[page.id, { childIds: [] }]],
            deleted: [],
            instanceIndex: [],
            populatedRootIds: [page.id]
          }
        }
      })
    )
    expect(await loading).toBeNull()
    expect(page.childIds).toEqual(expected)
    expect(kept.name).toBe('Again')
  } finally {
    client.terminate()
  }
})

test('layout after a resize does not drop an archive load', async () => {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const kept = graph.createNode('RECTANGLE', page.id, { name: 'Kept' })
  trackArchiveChanges(graph)
  let request: FigSessionPopulateRequest | undefined
  const port = {
    onmessage: null as ((event: MessageEvent<FigSessionResponse>) => void) | null,
    start: () => undefined,
    close: () => undefined,
    postMessage(message: FigSessionPopulateRequest) {
      request = message
    }
  }
  const worker = {
    terminate: () => undefined,
    postMessage: () => undefined,
    onerror: null,
    onmessage: null
  }
  const client = createPopulationWorkerClient(graph, worker, port)
  graph.updateNode(kept.id, { width: 40 })
  try {
    const loading = client.populateFromArchive(page.id)
    if (!request) throw new Error('Missing request')
    graph.applyDerivedLayoutDuring(() => {
      graph.updateNode(kept.id, { x: 12 })
    })
    port.onmessage?.(
      new MessageEvent<FigSessionResponse>('message', {
        data: {
          type: 'population-result',
          requestId: request.requestId,
          baseRevision: request.baseRevision,
          populated: true,
          delta: {
            created: [],
            updated: [[page.id, { childIds: [kept.id] }]],
            deleted: [],
            instanceIndex: [],
            populatedRootIds: [page.id]
          }
        }
      })
    )
    expect(await loading).toBe(true)
    expect(kept.x).toBe(12)
  } finally {
    client.terminate()
  }
})
