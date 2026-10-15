import { describe, expect, test } from 'bun:test'

import { SceneGraph, type Fill } from '@open-pencil/scene-graph'

import {
  LARGE_FIG_ARCHIVE_BYTES,
  openRoomSession,
  shouldOpenRoomDatabase,
  type RoomSession,
  type RoomSessionOptions
} from '@/app/collab/session'
import { SYNC_ALL_NODES_SYNC_LIMIT } from '@/app/collab/yjs-sync'
import { createEditorStore, type EditorStore } from '@/app/editor/session'
import { presenceOf } from '@/app/presence/registry'

import { expectDefined, getNodeOrThrow } from '#tests/helpers/assert'
import { createMemoryRooms } from '#tests/helpers/collab/memory-transport'

const ROOM_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ROOM_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const noSavedCopy = () => ({ whenSynced: Promise.resolve(), destroy: () => undefined })

async function withRooms(
  run: (
    open: (options: Omit<RoomSessionOptions, 'joinRoom'>) => RoomSession,
    settle: () => Promise<void>
  ) => Promise<void>
) {
  const rooms = createMemoryRooms()
  const sessions: RoomSession[] = []
  const stores: EditorStore[] = []
  try {
    await run((options) => {
      stores.push(options.store)
      const session = openRoomSession({
        openSavedCopy: noSavedCopy,
        ...options,
        joinRoom: rooms.join
      })
      sessions.push(session)
      return session
    }, rooms.settle)
  } finally {
    for (const session of sessions) session.dispose()
    for (const store of stores) store.preparationController.dispose()
  }
}

function newStore(name = 'Untitled', graph = new SceneGraph()) {
  const store = createEditorStore(graph)
  store.state.documentName = name
  return store
}

/** The same layer ids a second tab gets by opening the same file. */
function largeDocument(): SceneGraph {
  let next = 0
  const graph = new SceneGraph(() => `doc-${next++}`)
  const pageId = expectDefined(graph.getPages()[0], 'first page').id
  for (let index = 0; index < SYNC_ALL_NODES_SYNC_LIMIT; index++) {
    graph.createNode('RECTANGLE', pageId, { id: `layer-${index}`, x: 0 })
  }
  return graph
}

function firstPageId(store: EditorStore) {
  return expectDefined(store.graph.getPages()[0], 'first page').id
}

describe('room sessions', () => {
  test("a joined tab shows the sharer's document, with its name, once it arrives", async () => {
    await withRooms(async (open, settle) => {
      const host = newStore('Checkout flow')
      host.graph.createNode('RECTANGLE', firstPageId(host), { id: 'host:1', name: 'Card' })
      const shared = open({ roomId: ROOM_A, store: host, origin: 'shared' })
      shared.shareDocument()
      const guest = newStore('Shared file')
      const joined = open({ roomId: ROOM_A, store: guest, origin: 'joined' })
      expect(joined.status.value).toBe('connecting')

      await settle()
      expect(joined.status.value).toBe('live')
      expect(shared.status.value).toBe('live')
      expect(guest.graph.rootId).toBe(host.graph.rootId)
      expect(getNodeOrThrow(guest.graph, 'host:1').name).toBe('Card')
      expect(guest.state.documentName).toBe('Checkout flow')
    })
  })

  test('a room nobody with the document is in waits, then opens when the sharer comes', async () => {
    await withRooms(async (open, settle) => {
      const guest = newStore()
      const joined = open({ roomId: ROOM_A, store: guest, origin: 'joined' })
      await settle()
      expect(joined.status.value).toBe('waiting')
      expect(joined.hasDocument.value).toBe(false)

      const host = newStore('Late')
      open({ roomId: ROOM_A, store: host, origin: 'shared' }).shareDocument()
      await settle()
      expect(joined.status.value).toBe('live')
      expect(guest.graph.rootId).toBe(host.graph.rootId)
    })
  })

  test('two rooms in two tabs stay apart: edits and cursors reach only their own room', async () => {
    await withRooms(async (open, settle) => {
      const hostA = newStore('A')
      const hostB = newStore('B')
      const roomA = open({ roomId: ROOM_A, store: hostA, origin: 'shared' })
      const roomB = open({ roomId: ROOM_B, store: hostB, origin: 'shared' })
      roomA.shareDocument()
      roomB.shareDocument()
      const guestA = newStore()
      const guestB = newStore()
      const joinedA = open({ roomId: ROOM_A, store: guestA, origin: 'joined' })
      const joinedB = open({ roomId: ROOM_B, store: guestB, origin: 'joined' })
      await settle()

      guestA.graph.createNode('RECTANGLE', firstPageId(guestA), { id: 'guest:a' })
      joinedA.updateCursor(10, 20, firstPageId(guestA))
      await settle()

      expect(hostA.graph.getNode('guest:a')).toBeDefined()
      expect(hostB.graph.getNode('guest:a')).toBeUndefined()
      expect(guestB.graph.getNode('guest:a')).toBeUndefined()
      expect(roomA.peers.value.map((peer) => peer.cursor?.x)).toEqual([10])
      expect(roomB.peers.value.map((peer) => peer.cursor)).toEqual([undefined])
      expect(joinedB.status.value).toBe('live')
    })
  })

  test('an edit in a tab whose room has no document yet stays in that tab', async () => {
    await withRooms(async (open, settle) => {
      const guest = newStore()
      open({ roomId: ROOM_A, store: guest, origin: 'joined' })
      guest.graph.createNode('RECTANGLE', firstPageId(guest), { id: 'early' })
      await settle()

      const host = newStore()
      open({ roomId: ROOM_A, store: host, origin: 'shared' }).shareDocument()
      await settle()
      expect(host.graph.getNode('early')).toBeUndefined()
    })
  })

  test('peers say whether they have the file, so a newcomer knows whom it is waiting for', async () => {
    await withRooms(async (open, settle) => {
      const host = newStore('Shared')
      open({ roomId: ROOM_A, store: host, origin: 'shared' }).shareDocument()
      const early = open({ roomId: ROOM_B, store: newStore(), origin: 'joined' })
      const other = open({ roomId: ROOM_B, store: newStore(), origin: 'joined' })
      const guest = open({ roomId: ROOM_A, store: newStore(), origin: 'joined' })
      await settle()

      expect(guest.peers.value.map((peer) => peer.hasFile)).toEqual([true])
      expect(early.peers.value.map((peer) => peer.hasFile)).toEqual([false])
      expect(early.status.value).toBe('waiting')
      expect(other.status.value).toBe('waiting')
    })
  })

  test('a room a tab has left no longer changes that tab or its people', async () => {
    await withRooms(async (open, settle) => {
      const host = newStore('Shared')
      const shared = open({ roomId: ROOM_A, store: host, origin: 'shared' })
      shared.shareDocument()
      const guest = newStore()
      const joined = open({ roomId: ROOM_A, store: guest, origin: 'joined' })
      await settle()
      expect(joined.peers.value).toHaveLength(1)

      joined.dispose()
      host.graph.createNode('RECTANGLE', firstPageId(host), { id: 'after-leave' })
      shared.updateCursor(10, 10, firstPageId(host))
      await settle()
      expect(guest.graph.getNode('after-leave')).toBeUndefined()
      expect(joined.peers.value).toEqual([])
      expect(presenceOf(guest).peers.value).toEqual([])
    })
  })

  test('a large shared file claims the room and syncs a later edit, not its layers', async () => {
    await withRooms(async (open, settle) => {
      const host = newStore('aska', largeDocument())
      const peer = newStore('aska', largeDocument())
      const pageId = firstPageId(host)
      const order = [...getNodeOrThrow(peer.graph, pageId).childIds]
      open({ roomId: ROOM_A, store: host, origin: 'shared' }).shareDocument()
      open({ roomId: ROOM_A, store: peer, origin: 'shared' }).shareDocument()
      await settle()

      expect(peer.graph.getNode('layer-0')).toBeDefined()
      expect(peer.graph.nodes.size).toBe(host.graph.nodes.size)
      host.graph.updateNode('layer-3', { x: 42 })
      await settle()

      expect(getNodeOrThrow(peer.graph, 'layer-3').x).toBe(42)
      expect(getNodeOrThrow(peer.graph, 'layer-3').parentId).toBe(pageId)
      expect(getNodeOrThrow(peer.graph, 'layer-0').parentId).toBe(pageId)
      expect(getNodeOrThrow(peer.graph, pageId).childIds).toEqual(order)
      expect(peer.graph.nodes.size).toBe(host.graph.nodes.size)
    })
  })

  test('room database follows archive bytes, not the layer count after first-page populate', () => {
    expect(shouldOpenRoomDatabase(97, LARGE_FIG_ARCHIVE_BYTES + 1)).toBe(false)
    expect(shouldOpenRoomDatabase(97, 48_000)).toBe(true)
    expect(shouldOpenRoomDatabase(SYNC_ALL_NODES_SYNC_LIMIT, undefined)).toBe(true)
    expect(shouldOpenRoomDatabase(SYNC_ALL_NODES_SYNC_LIMIT + 1, 48_000)).toBe(false)
  })

  test('a 97-node cover of a large fig does not open room IndexedDB', async () => {
    await withRooms(async (open, settle) => {
      const host = newStore('aska')
      const pageId = firstPageId(host)
      const blob = new Uint8Array(64)
      blob[0] = 9
      host.graph.createNode('VECTOR', pageId, {
        id: 'cover-shape',
        fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: blob }]
      })
      host.graph.images.set('cover', new Uint8Array([1, 2, 3, 4]))
      const imageFill: Fill = {
        type: 'IMAGE',
        color: { r: 0, g: 0, b: 0, a: 1 },
        opacity: 1,
        visible: true,
        imageHash: 'cover',
        imageScaleMode: 'FILL'
      }
      host.graph.createNode('RECTANGLE', pageId, { id: 'cover-image', fills: [imageFill] })
      while (host.graph.nodes.size < 97) {
        host.graph.createNode('RECTANGLE', pageId, { id: `cover-${host.graph.nodes.size}` })
      }
      expect(host.graph.nodes.size).toBe(97)

      let databaseOpens = 0
      const shared = open({
        roomId: ROOM_A,
        store: host,
        origin: 'shared',
        archiveBytes: LARGE_FIG_ARCHIVE_BYTES + 1,
        openSavedCopy: () => {
          databaseOpens += 1
          // Opening the real database would Y.applyUpdate the saved full dump here.
          host.graph.createNode('RECTANGLE', pageId, { id: 'from-dump' })
          return noSavedCopy()
        }
      })
      shared.shareDocument()
      expect(databaseOpens).toBe(0)
      expect(host.graph.getNode('from-dump')).toBeUndefined()
      expect(host.graph.nodes.size).toBe(97)

      const guest = newStore()
      open({ roomId: ROOM_A, store: guest, origin: 'joined' })
      await settle()

      expect(getNodeOrThrow(guest.graph, 'cover-shape').fillGeometry).toEqual([])
      expect(host.graph.getNode('cover-shape')?.fillGeometry[0]?.commandsBlob[0]).toBe(9)
      expect(getNodeOrThrow(guest.graph, 'cover-image').fills[0]?.imageHash).toBe('cover')
      expect(guest.graph.images.has('cover')).toBe(false)

      host.graph.updateNode('cover-shape', { x: 42 })
      await settle()
      expect(getNodeOrThrow(guest.graph, 'cover-shape').x).toBe(42)
      expect(guest.graph.images.has('cover')).toBe(false)
    })
  })

  test('a small archive still opens room IndexedDB and syncs its whole graph', async () => {
    await withRooms(async (open, settle) => {
      const host = newStore('Notes')
      const pageId = firstPageId(host)
      host.graph.createNode('RECTANGLE', pageId, { id: 'card', x: 1 })
      expect(host.graph.nodes.size).toBeLessThan(SYNC_ALL_NODES_SYNC_LIMIT)

      let databaseOpens = 0
      const shared = open({
        roomId: ROOM_A,
        store: host,
        origin: 'shared',
        archiveBytes: 48_000,
        openSavedCopy: () => {
          databaseOpens += 1
          return noSavedCopy()
        }
      })
      shared.shareDocument()
      expect(databaseOpens).toBe(1)

      const guest = newStore()
      open({ roomId: ROOM_A, store: guest, origin: 'joined' })
      await settle()
      expect(getNodeOrThrow(guest.graph, 'card').x).toBe(1)

      host.graph.updateNode('card', { x: 7 })
      await settle()
      expect(getNodeOrThrow(guest.graph, 'card').x).toBe(7)
    })
  })
})
