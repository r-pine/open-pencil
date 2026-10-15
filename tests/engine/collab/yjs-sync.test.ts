import { describe, test, expect, spyOn } from 'bun:test'

import { create as createPRNG } from 'lib0/prng'
import * as Y from 'yjs'
import { TestConnector, type TestYInstance } from 'yjs/testHelper'

import type { Fill, GeometryPath, SceneNode } from '@open-pencil/scene-graph'
import { getInstanceOverride, SceneGraph, setInstanceOverride } from '@open-pencil/scene-graph'
import { nodeVisualBounds } from '@open-pencil/scene-graph/geometry'
import { createDefaultSourceMetadata } from '@open-pencil/scene-graph/node-defaults'

import { decodeNodeFromYjs, syncEncodedNodeToYMap } from '@/app/collab/node-codec'
import { settleRoomImages } from '@/app/collab/room/image-sync'
import { createMemoryRoomImages } from '@/app/collab/room/images'
import { createLocalEdit } from '@/app/collab/shared-tree/sync'
import {
  REMOTE_DUMP_UPDATE_BYTES,
  remoteUpdateIsHistoricalDump,
  SYNC_ALL_NODES_SYNC_LIMIT
} from '@/app/collab/yjs-sync'

import { expectDefined, getNodeOrThrow } from '#tests/helpers/assert'
import { withSyncedStores } from '#tests/helpers/collab/synced-stores'

function firstPage(graph: SceneGraph): SceneNode {
  return expectDefined(graph.getPages()[0], 'first page')
}

/** Two calls build the same ids, as two tabs that opened one .fig do. */
function documentWithLayers(extra: number): SceneGraph {
  let next = 0
  const graph = new SceneGraph(() => `doc-${next++}`)
  const pageId = firstPage(graph).id
  for (let index = 0; index < extra; index++) {
    graph.createNode('RECTANGLE', pageId, { id: `layer-${index}`, x: 0, name: `Layer ${index}` })
  }
  return graph
}

describe('collab yjs-sync', () => {
  test('createNodeWithId forces the requested id even if synced props contain a stale id', () => {
    const graph = new SceneGraph()
    const page = firstPage(graph)
    const node = graph.createNodeWithId('remote-id', 'RECTANGLE', page.id, {
      id: 'stale-local-id',
      width: 50
    })

    expect(node.id).toBe('remote-id')
    expect(graph.getNode('remote-id')).toBe(node)
    expect(graph.getNode('stale-local-id')).toBeUndefined()
    expect(page.childIds).toContain('remote-id')
  })

  test('excludes derived text pictures from collaboration payloads', () => {
    const graph = new SceneGraph()
    const page = firstPage(graph)
    const text = graph.createNode('TEXT', page.id, {
      text: 'Shared text',
      textPicture: new Uint8Array([4, 5, 6])
    })
    const doc = new Y.Doc()
    const ynode = new Y.Map<unknown>()
    doc.getMap<Y.Map<unknown>>('nodes').set(text.id, ynode)

    syncEncodedNodeToYMap(text, ynode)

    expect(ynode.has('textPicture')).toBe(false)
    ynode.set('textPicture', new Uint8Array([9]))
    expect(decodeNodeFromYjs(ynode).textPicture).toBeNull()
  })

  test('carries instance overrides to other peers', () => {
    const graph = new SceneGraph()
    const instance = graph.createNode('FRAME', firstPage(graph).id, { name: 'Player' })
    instance.instanceOverrides = {
      self: new Map<string, unknown>([['name', 'Night Shift']]),
      descendants: new Map([['title', new Map<string, unknown>([['text', 'Side B']])]])
    }
    const local = new Y.Doc()
    const ynode = new Y.Map<unknown>()
    local.getMap<Y.Map<unknown>>('nodes').set(instance.id, ynode)
    syncEncodedNodeToYMap(instance, ynode)

    // Through Yjs's own update encoding, as a peer receives it.
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
    const received = expectDefined(remote.getMap<Y.Map<unknown>>('nodes').get(instance.id), 'node')

    expect(decodeNodeFromYjs(received).instanceOverrides).toEqual(instance.instanceOverrides)
  })

  test('reads overrides a room stored before they were serialized as none', () => {
    const doc = new Y.Doc()
    const ynode = new Y.Map<unknown>()
    doc.getMap<Y.Map<unknown>>('nodes').set('legacy', ynode)
    ynode.set('instanceOverrides', { self: {}, descendants: {} })

    const { instanceOverrides } = decodeNodeFromYjs(ynode)

    expect(instanceOverrides?.self).toEqual(new Map())
    expect(instanceOverrides?.descendants).toEqual(new Map())
  })

  test('normalizes malformed source metadata and geometry at the remote boundary', () => {
    const doc = new Y.Doc()
    const ynode = new Y.Map<unknown>()
    doc.getMap<Y.Map<unknown>>('nodes').set('remote', ynode)
    ynode.set('source', { format: 'fig', fig: { rawNodeFields: 'invalid' } })
    ynode.set('fillGeometry', [
      {
        windingRule: 'EVENODD',
        commandsBlob: new Uint8Array([0]),
        fills: [
          null,
          'invalid',
          {
            type: 'GRADIENT_LINEAR',
            color: { r: 0, g: 0, b: 0, a: 1 },
            opacity: 1,
            visible: true,
            gradientStops: 'invalid'
          },
          {
            type: 'NOISE',
            color: { r: 0, g: 0, b: 0, a: 1 },
            opacity: 1,
            visible: true,
            noiseSize: 'invalid'
          },
          {
            type: 'GRADIENT_LINEAR',
            color: { r: 0, g: 0, b: 0, a: 1 },
            opacity: 0.8,
            visible: true,
            gradientStops: [
              { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
              { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }
            ],
            gradientTransform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }
          },
          {
            type: 'SOLID',
            color: { r: 1, g: 0, b: 0, a: 1 },
            opacity: 1,
            visible: true
          }
        ]
      },
      { windingRule: 'NONZERO', commandsBlob: 'invalid' }
    ])
    ynode.set('strokeGeometry', 'invalid')

    const props = decodeNodeFromYjs(ynode)
    const source = props.source as SceneNode['source']
    const fillGeometry = props.fillGeometry as GeometryPath[]

    expect(source).toEqual({
      ...createDefaultSourceMetadata(),
      format: 'fig'
    })
    expect(fillGeometry).toHaveLength(1)
    expect(fillGeometry[0]?.commandsBlob).toBeInstanceOf(Uint8Array)
    expect(fillGeometry[0]?.fills).toHaveLength(2)
    expect(fillGeometry[0]?.fills?.[0]).toMatchObject({
      type: 'GRADIENT_LINEAR',
      opacity: 0.8,
      gradientStops: [
        { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
        { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }
      ],
      gradientTransform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }
    })
    expect(fillGeometry[0]?.fills?.[1]?.type).toBe('SOLID')
    expect(props.strokeGeometry).toEqual([])
  })

  test('geometry blobs stay on the local graph and out of the room', () => {
    const host = new SceneGraph()
    const page = firstPage(host)
    const blob = new Uint8Array(64 * 1024)
    blob[0] = 1
    const geometry: GeometryPath[] = [{ windingRule: 'NONZERO', commandsBlob: blob }]
    const ellipse = host.createNode('ELLIPSE', page.id, {
      width: 100,
      height: 100,
      fillGeometry: geometry,
      vectorNetwork: {
        vertices: [{ x: 0, y: 0 }],
        segments: [],
        regions: []
      }
    })
    ellipse.source = {
      ...ellipse.source,
      format: 'fig',
      fig: {
        ...ellipse.source.fig,
        rawNodeFields: {
          strokeWeight: 2,
          vectorData: { vectorNetworkBlob: { __openPencilFigmaBlob: blob } },
          fillGeometry: [{ commandsBlob: { __openPencilFigmaBlob: blob } }],
          strokeGeometry: [{ commandsBlob: { __openPencilFigmaBlob: blob } }]
        }
      }
    }

    const doc = new Y.Doc()
    const ynode = new Y.Map<unknown>()
    doc.getMap<Y.Map<unknown>>('nodes').set(ellipse.id, ynode)
    syncEncodedNodeToYMap(ellipse, ynode)

    expect(ynode.has('fillGeometry')).toBe(false)
    expect(ynode.has('strokeGeometry')).toBe(false)
    expect(ynode.get('vectorNetwork')).toMatchObject({ vertices: [{ x: 0, y: 0 }] })
    expect(ynode.get('width')).toBe(100)
    const source = ynode.get('source') as {
      fig: { rawNodeFields: Record<string, unknown> }
    }
    expect(source.fig.rawNodeFields.strokeWeight).toBe(2)
    expect(source.fig.rawNodeFields).not.toHaveProperty('vectorData')
    expect(source.fig.rawNodeFields).not.toHaveProperty('fillGeometry')
    expect(source.fig.rawNodeFields).not.toHaveProperty('strokeGeometry')
    expect(JSON.stringify(source)).not.toContain('__openPencilFigmaBlob')
    const props = decodeNodeFromYjs(ynode)
    expect(props.fillGeometry).toBeUndefined()
    expect(ellipse.fillGeometry[0]?.commandsBlob).toBe(blob)
  })

  test('instance overrides survive a Yjs state round-trip as maps', () => {
    const graph = new SceneGraph()
    const page = firstPage(graph)
    const component = graph.createNode('COMPONENT', page.id, {
      name: 'Card',
      width: 10,
      height: 10
    })
    const instance = graph.createInstance(component.id, page.id)
    if (!instance) throw new Error('missing instance')
    setInstanceOverride(instance.instanceOverrides, instance.id, instance.id, 'opacity', 0.25)
    setInstanceOverride(instance.instanceOverrides, instance.id, 'child', 'text', 'Custom')

    const doc = new Y.Doc()
    const ynode = new Y.Map<unknown>()
    doc.getMap<Y.Map<unknown>>('nodes').set(instance.id, ynode)
    syncEncodedNodeToYMap(instance, ynode)

    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    const remote = copy.getMap<Y.Map<unknown>>('nodes').get(instance.id)
    if (!remote) throw new Error('missing remote node')
    const props = decodeNodeFromYjs(remote)
    const overrides = props.instanceOverrides
    if (!overrides) throw new Error('missing overrides')

    expect(overrides.self).toBeInstanceOf(Map)
    expect(overrides.descendants).toBeInstanceOf(Map)
    expect(getInstanceOverride(overrides, instance.id, instance.id, 'opacity')).toBe(0.25)
    expect(getInstanceOverride(overrides, instance.id, 'child', 'text')).toBe('Custom')
  })

  test('a fresh peer reconstructs one ellipse with no duplicate child entries', async () => {
    await withSyncedStores(
      ({ hostStore, peerStore, hostSync, hostDoc, peerDoc }) => {
        const hostPage = firstPage(hostStore.graph)
        const ellipse = hostStore.graph.createNode('ELLIPSE', hostPage.id, {
          width: 80,
          height: 60
        })
        hostSync.syncAllNodesToYjs()
        Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(hostDoc))

        const peer = peerStore.graph
        const peerEllipse = getNodeOrThrow(peer, ellipse.id)
        expect(peerEllipse.type).toBe('ELLIPSE')
        expect(peerEllipse.parentId).toBe(hostPage.id)
        const refs = getNodeOrThrow(peer, hostPage.id).childIds.filter((c) => c === ellipse.id)
        expect(refs).toHaveLength(1)
        expect(peer.getPages().map((page) => page.id)).toContain(hostPage.id)
        expect(() =>
          nodeVisualBounds(peerEllipse, (id) => {
            const n = peer.getNode(id)
            return { x: n?.x ?? 0, y: n?.y ?? 0 }
          })
        ).not.toThrow()
      },
      { connectImmediately: false }
    )
  })

  test('deduplicates a pending page switch and handles its rejection', async () => {
    await withSyncedStores(async ({ hostStore, peerStore, hostSync }) => {
      const page = firstPage(hostStore.graph)
      const node = hostStore.graph.createNode('RECTANGLE', page.id)
      const { promise: pending, reject: rejectSwitch } = Promise.withResolvers<undefined>()
      const switchPage = spyOn(peerStore, 'switchPage').mockReturnValue(pending)
      const log = spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        hostSync.syncAllNodesToYjs()
        hostSync.syncNodeToYjs(node.id)
        expect(switchPage).toHaveBeenCalledTimes(1)
        const error = new Error('Page preparation failed')
        rejectSwitch(error)
        await pending.catch(() => undefined)
        await Promise.resolve()
        expect(log).toHaveBeenCalledWith('[Collab] Failed to switch to a synced page:', error)
      } finally {
        switchPage.mockRestore()
        log.mockRestore()
      }
    })
  })

  test('a large document is shared in several updates, with no image bytes in the Y.Doc', async () => {
    const images = createMemoryRoomImages()
    await withSyncedStores(
      async ({ hostStore, peerStore, hostSync, hostDoc }) => {
        const page = firstPage(hostStore.graph)
        const cover = new Uint8Array([137, 80, 78, 71])
        hostStore.graph.images.set('cover', cover)
        for (let index = 0; index < 50; index++) {
          hostStore.graph.createNode('RECTANGLE', page.id, {
            name: `Layer ${index}`,
            fills: [
              {
                type: 'IMAGE',
                color: { r: 0, g: 0, b: 0, a: 1 },
                opacity: 1,
                visible: true,
                imageHash: 'cover',
                imageScaleMode: 'FILL'
              }
            ]
          })
        }

        const updates: Uint8Array[] = []
        hostDoc.on('update', (update: Uint8Array) => {
          updates.push(update)
        })
        await hostSync.syncAllNodesInChunks()

        expect(updates.length).toBeGreaterThan(1)
        const whole = Y.encodeStateAsUpdate(hostDoc)
        expect(Math.max(...updates.map((update) => update.byteLength))).toBeLessThan(whole.byteLength)
        expect(hostDoc.getMap('images').size).toBe(0)
        expect(images.get('cover')).toEqual(cover)
        expect(peerStore.graph.rootId).toBe(hostStore.graph.rootId)
        for (const node of hostStore.graph.getAllNodes()) {
          expect(peerStore.graph.getNode(node.id)?.parentId).toBe(node.parentId)
        }
      },
      { hostImageBytes: images }
    )
  })

  test('a chunked share leaves geometry blobs on the local graph', async () => {
    await withSyncedStores(async ({ hostStore, hostSync, hostDoc }) => {
      const page = firstPage(hostStore.graph)
      const blob = new Uint8Array(64 * 1024)
      blob[0] = 7
      const source = createDefaultSourceMetadata()
      source.format = 'fig'
      source.fig.rawNodeFields = {
        fillGeometry: [{ commandsBlob: { __openPencilFigmaBlob: blob } }]
      }
      source.fig.derivedSymbolData = [{ commandsBlob: { __openPencilFigmaBlob: blob } }]
      const node = hostStore.graph.createNode('VECTOR', page.id, {
        name: 'Heavy',
        x: 12,
        fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: blob }],
        source
      })

      const updates: Uint8Array[] = []
      hostDoc.on('update', (update: Uint8Array) => {
        updates.push(update)
      })
      await hostSync.syncAllNodesInChunks()

      const ynode = hostDoc.getMap<Y.Map<unknown>>('nodes').get(node.id)
      expect(ynode?.has('fillGeometry')).toBe(false)
      expect(ynode?.has('strokeGeometry')).toBe(false)
      const sharedSource = ynode?.get('source') as {
        fig: { rawNodeFields: Record<string, unknown>; derivedSymbolData: unknown[] }
      }
      expect(sharedSource.fig.rawNodeFields).not.toHaveProperty('fillGeometry')
      expect(JSON.stringify(sharedSource.fig.derivedSymbolData)).not.toContain('__openPencilFigmaBlob')
      expect(ynode?.get('name')).toBe('Heavy')
      expect(ynode?.get('x')).toBe(12)
      expect(hostStore.graph.getNode(node.id)?.fillGeometry[0]?.commandsBlob[0]).toBe(7)
      expect(updates.length).toBeGreaterThan(0)
      expect(Math.max(...updates.map((update) => update.byteLength))).toBeLessThan(blob.byteLength)
    })
  })

  test('syncAllNodesToYjs populates peer graph and current page', async () => {
    await withSyncedStores(async ({ hostStore, peerStore, hostSync }) => {
      const hostPage = firstPage(hostStore.graph)
      const rect = hostStore.graph.createNode('RECTANGLE', hostPage.id, { width: 80, height: 60 })

      const pageChanged = new Promise<void>((resolve) => {
        const off = peerStore.onEditorEvent('page:changed', () => {
          off()
          resolve()
        })
      })
      hostSync.syncAllNodesToYjs()

      expect(peerStore.graph.rootId).toBe(hostStore.graph.rootId)
      await pageChanged
      expect(peerStore.state.currentPageId).toBe(hostPage.id)
      expect(peerStore.graph.getPages().map((page) => page.id)).toContain(hostPage.id)
      expect(getNodeOrThrow(peerStore.graph, rect.id).type).toBe('RECTANGLE')
    })
  })

  test('live-created and edited nodes sync in both directions', async () => {
    await withSyncedStores(({ hostStore, peerStore, hostSync, peerSync }) => {
      const hostPage = firstPage(hostStore.graph)
      hostSync.syncAllNodesToYjs()

      const rect = hostStore.graph.createNode('RECTANGLE', hostPage.id, { width: 50, height: 50 })
      hostSync.syncNodeToYjs(rect.id)

      const peerRect = getNodeOrThrow(peerStore.graph, rect.id)
      expect(peerRect.parentId).toBe(hostPage.id)
      expect(getNodeOrThrow(peerStore.graph, hostPage.id).childIds).toContain(rect.id)

      peerStore.graph.updateNode(rect.id, { x: 42, y: 24 })
      peerSync.syncNodeToYjs(rect.id)

      expect(getNodeOrThrow(hostStore.graph, rect.id).x).toBe(42)
      expect(getNodeOrThrow(hostStore.graph, rect.id).y).toBe(24)
    })
  })

  test('unchanged node synchronization emits no Yjs update', async () => {
    await withSyncedStores(({ hostStore, hostSync, hostDoc }) => {
      const hostPage = firstPage(hostStore.graph)
      const rect = hostStore.graph.createNode('RECTANGLE', hostPage.id, { width: 80, height: 60 })
      hostSync.syncNodeToYjs(rect.id)

      let updateCount = 0
      let updateBytes = 0
      const trackUpdate = (update: Uint8Array) => {
        updateCount++
        updateBytes += update.byteLength
      }
      hostDoc.on('update', trackUpdate)
      for (let index = 0; index < 100; index++) hostSync.syncNodeToYjs(rect.id)
      hostDoc.off('update', trackUpdate)

      expect(updateCount).toBe(0)
      expect(updateBytes).toBe(0)
    })
  })

  test('repeated drag-like updates stay field-sized and do not echo', async () => {
    await withSyncedStores(({ hostStore, peerStore, hostSync, hostDoc, peerDoc }) => {
      const hostPage = firstPage(hostStore.graph)
      const rect = hostStore.graph.createNode('RECTANGLE', hostPage.id, { width: 80, height: 60 })
      hostSync.syncAllNodesToYjs()
      hostSync.syncNodeToYjs(rect.id)

      let hostUpdateCount = 0
      let hostUpdateBytes = 0
      let peerUpdateCount = 0
      const trackHostUpdate = (update: Uint8Array) => {
        hostUpdateCount++
        hostUpdateBytes += update.byteLength
      }
      const trackPeerUpdate = () => {
        peerUpdateCount++
      }
      hostDoc.on('update', trackHostUpdate)
      peerDoc.on('update', trackPeerUpdate)

      for (let index = 1; index <= 100; index++) {
        hostStore.graph.updateNode(rect.id, { x: index })
        hostSync.syncNodeToYjs(rect.id)
      }

      hostDoc.off('update', trackHostUpdate)
      peerDoc.off('update', trackPeerUpdate)
      expect(getNodeOrThrow(peerStore.graph, rect.id).x).toBe(100)
      expect(hostUpdateCount).toBe(100)
      expect(peerUpdateCount).toBe(100)
      expect(hostUpdateBytes).toBeLessThan(8_000)
    })
  })

  test('queued concurrent edits converge through the official Yjs test connector', async () => {
    const connector = new TestConnector(createPRNG(526))
    const hostDoc: TestYInstance = connector.createY(1)
    const peerDoc: TestYInstance = connector.createY(2)
    connector.syncAll()

    await withSyncedStores(
      ({ hostStore, peerStore, hostSync, peerSync }) => {
        const hostPage = firstPage(hostStore.graph)
        const rect = hostStore.graph.createNode('RECTANGLE', hostPage.id, {
          width: 80,
          height: 60
        })
        hostSync.syncAllNodesToYjs()
        hostSync.syncNodeToYjs(rect.id)
        connector.flushAllMessages()
        expect(getNodeOrThrow(peerStore.graph, rect.id).type).toBe('RECTANGLE')

        hostDoc.disconnect()
        hostStore.graph.updateNode(rect.id, { x: 42 })
        hostSync.syncNodeToYjs(rect.id)
        peerStore.graph.updateNode(rect.id, { y: 24 })
        peerSync.syncNodeToYjs(rect.id)

        hostDoc.connect()
        expect(connector.flushRandomMessage()).toBe(true)
        connector.flushAllMessages()

        expect(getNodeOrThrow(hostStore.graph, rect.id)).toMatchObject({ x: 42, y: 24 })
        expect(getNodeOrThrow(peerStore.graph, rect.id)).toMatchObject({ x: 42, y: 24 })
        expect(Y.encodeStateVector(hostDoc)).toEqual(Y.encodeStateVector(peerDoc))
      },
      { hostDoc, peerDoc, connectImmediately: false }
    )
  })

  test('image fills sync image bytes', async () => {
    const images = createMemoryRoomImages()
    await withSyncedStores(
      ({ hostStore, peerStore, hostSync, hostDoc, peerDoc }) => {
        const hostPage = firstPage(hostStore.graph)
        hostSync.syncAllNodesToYjs()
        const imageHash = 'image-hash'
        const imageFill: Fill = {
          type: 'IMAGE',
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true,
          imageHash,
          imageScaleMode: 'FILL'
        }
        const rect = hostStore.graph.createNode('RECTANGLE', hostPage.id, { fills: [imageFill] })
        hostStore.graph.images.set(imageHash, new Uint8Array([9, 8, 7]))

        hostSync.syncNodeToYjs(rect.id)

        expect(getNodeOrThrow(peerStore.graph, rect.id).fills[0]?.imageHash).toBe(imageHash)
        expect(Array.from(expectDefined(images.get(imageHash), 'saved image'))).toEqual([9, 8, 7])
        expect(hostStore.graph.images.get(imageHash)).toEqual(new Uint8Array([9, 8, 7]))
        expect(peerStore.graph.images.has(imageHash)).toBe(false)
        expect(hostDoc.getMap('images').size).toBe(0)
        expect(peerDoc.getMap('images').size).toBe(0)
      },
      { hostImageBytes: images }
    )
  })

  test('removing the last image fill drops the saved bytes', async () => {
    const images = createMemoryRoomImages()
    await withSyncedStores(
      ({ hostStore, hostSync }) => {
        const hostPage = firstPage(hostStore.graph)
        hostSync.syncAllNodesToYjs()
        const imageHash = 'image-hash'
        const sharedHash = 'shared-hash'
        const imageFill = (hash: string): Fill => ({
          type: 'IMAGE',
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true,
          imageHash: hash,
          imageScaleMode: 'FILL'
        })
        const rect = hostStore.graph.createNode('RECTANGLE', hostPage.id, {
          fills: [imageFill(imageHash)]
        })
        const other = hostStore.graph.createNode('RECTANGLE', hostPage.id, {
          fills: [imageFill(sharedHash)]
        })
        hostStore.graph.images.set(imageHash, new Uint8Array([9, 8, 7]))
        hostStore.graph.images.set(sharedHash, new Uint8Array([1, 2, 3]))
        hostSync.syncNodeToYjs(rect.id)
        hostSync.syncNodeToYjs(other.id)

        hostStore.graph.updateNode(rect.id, { fills: [] })
        hostSync.syncNodeToYjs(rect.id)

        expect(images.has(imageHash)).toBe(false)
        expect(images.get(sharedHash)).toEqual(new Uint8Array([1, 2, 3]))
      },
      { hostImageBytes: images }
    )
  })

  test('a remote image-key delete does not clear local image bytes', async () => {
    await withSyncedStores(({ hostDoc, peerStore }) => {
      const imageHash = 'image-hash'
      const bytes = new Uint8Array([4, 5, 6])
      peerStore.graph.images.set(imageHash, bytes)
      hostDoc.getMap<Uint8Array>('images').set(imageHash, bytes)
      hostDoc.getMap<Uint8Array>('images').delete(imageHash)

      expect(peerStore.graph.images.get(imageHash)).toEqual(bytes)
      expect(hostDoc.getMap('images').size).toBe(0)
    })
  })

  test('a fat image map is copied aside and left out of the room snapshot', async () => {
    const images = createMemoryRoomImages()
    let replaced = false
    await withSyncedStores(async ({ hostStore, hostDoc }) => {
      const payload = new Uint8Array(8_000)
      payload[0] = 9
      payload[1] = 8
      hostDoc.getMap<Uint8Array>('images').set('image-hash', payload)
      await settleRoomImages({
        store: hostStore,
        ydoc: hostDoc,
        yimages: hostDoc.getMap('images'),
        held: new Map([['image-hash', payload]]),
        images,
        setSuppressYjsEvents: () => undefined,
        replaceStoredState: async () => {
          replaced = true
        },
        isActive: () => true
      })

      expect(hostDoc.getMap('images').size).toBe(0)
      expect(hostStore.graph.images.get('image-hash')).toBe(payload)
      expect(images.get('image-hash')).toEqual(payload)
      expect(replaced).toBe(true)
      const update = Y.encodeStateAsUpdate(hostDoc)
      const probe = new Y.Doc()
      Y.applyUpdate(probe, update)
      expect(probe.getMap('images').size).toBe(0)
      expect(update.byteLength).toBeLessThan(payload.byteLength)
      probe.destroy()
    })
  })

  test('a small file still accepts a room update of any size', () => {
    expect(remoteUpdateIsHistoricalDump(10, REMOTE_DUMP_UPDATE_BYTES + 1)).toBe(false)
    expect(
      remoteUpdateIsHistoricalDump(SYNC_ALL_NODES_SYNC_LIMIT + 1, REMOTE_DUMP_UPDATE_BYTES)
    ).toBe(false)
    expect(
      remoteUpdateIsHistoricalDump(SYNC_ALL_NODES_SYNC_LIMIT + 1, REMOTE_DUMP_UPDATE_BYTES + 1)
    ).toBe(true)
  })

  test('a file over the sync limit stays out of the room until someone edits it', async () => {
    const extra = SYNC_ALL_NODES_SYNC_LIMIT
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await withSyncedStores(
        async ({ hostStore, peerStore, hostSync, peerSync, hostDoc }) => {
          const pageId = firstPage(hostStore.graph).id
          const order = [...getNodeOrThrow(peerStore.graph, pageId).childIds]
          hostSync.claimSharedDocument()
          peerSync.claimSharedDocument()
          await hostSync.syncAllNodesInChunks()
          hostSync.syncAllNodesToYjs()

          expect(hostStore.graph.nodes.size).toBeGreaterThan(SYNC_ALL_NODES_SYNC_LIMIT)
          expect(hostDoc.getMap('nodes').size).toBe(0)
          expect(peerStore.graph.nodes.size).toBe(hostStore.graph.nodes.size)

          hostStore.graph.updateNode('layer-3', { x: 42, name: 'Edited' })
          hostSync.syncNodeToYjs('layer-3')

          expect(hostDoc.getMap('nodes').size).toBeLessThan(SYNC_ALL_NODES_SYNC_LIMIT)
          expect(getNodeOrThrow(peerStore.graph, 'layer-3')).toMatchObject({
            x: 42,
            name: 'Edited',
            parentId: pageId
          })
          expect(getNodeOrThrow(peerStore.graph, 'layer-0').parentId).toBe(pageId)
          expect(getNodeOrThrow(peerStore.graph, pageId).childIds).toEqual(order)
          expect(peerStore.graph.nodes.size).toBe(hostStore.graph.nodes.size)

          const removal = createLocalEdit()
          hostStore.graph.deleteNode('layer-4')
          removal.deleted.add('layer-4')
          hostSync.syncLocalEdit(removal)
          await Promise.resolve()

          expect(peerStore.graph.getNode('layer-4')).toBeUndefined()
          expect(getNodeOrThrow(peerStore.graph, pageId).childIds).toEqual(
            getNodeOrThrow(hostStore.graph, pageId).childIds
          )
          expect(getNodeOrThrow(peerStore.graph, 'layer-0').parentId).toBe(pageId)
          expect(peerStore.graph.nodes.size).toBe(hostStore.graph.nodes.size)
          expect(hostDoc.getMap('nodes').size).toBeLessThan(SYNC_ALL_NODES_SYNC_LIMIT)
          expect(warn.mock.calls.some((call) => String(call[0]).includes('large document'))).toBe(
            true
          )
        },
        { hostGraph: documentWithLayers(extra), peerGraph: documentWithLayers(extra) }
      )
    } finally {
      warn.mockRestore()
    }
  })

  test('a historical full node map is not applied onto the open graph', async () => {
    await withSyncedStores(async ({ hostStore, peerStore, peerSync, hostDoc }) => {
      const page = firstPage(hostStore.graph)
      const kept = hostStore.graph.createNode('RECTANGLE', page.id, {
        id: 'kept',
        x: 5,
        name: 'Kept'
      })
      const before = hostStore.graph.nodes.size
      const dump = new Y.Doc()
      dump.transact(() => {
        const nodes = dump.getMap<Y.Map<unknown>>('nodes')
        for (let index = 0; index < SYNC_ALL_NODES_SYNC_LIMIT + 1; index++) {
          const ynode = new Y.Map<unknown>()
          ynode.set('type', 'RECTANGLE')
          ynode.set('name', `Dump ${index}`)
          ynode.set('x', 9)
          nodes.set(`dump-${index}`, ynode)
        }
      })
      const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        Y.applyUpdate(hostDoc, Y.encodeStateAsUpdate(dump))
        expect(hostStore.graph.nodes.size).toBe(before)
        expect(hostStore.graph.getNode('dump-0')).toBeUndefined()
        expect(getNodeOrThrow(hostStore.graph, kept.id)).toMatchObject({ x: 5, parentId: page.id })

        peerSync.claimSharedDocument()
        const peerPage = firstPage(peerStore.graph)
        const live = peerStore.graph.createNode('RECTANGLE', peerPage.id, {
          id: 'live',
          x: 3,
          name: 'Live'
        })
        peerSync.syncNodeToYjs(live.id)
        expect(getNodeOrThrow(hostStore.graph, 'live')).toMatchObject({ x: 3, name: 'Live' })
      } finally {
        warn.mockRestore()
        dump.destroy()
      }
    })
  })
})
