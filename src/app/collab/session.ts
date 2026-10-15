import { useIntervalFn } from '@vueuse/core'
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'

import { shareAgentPreviews } from '@/app/collab/agent-preview'
import { buildRemotePeers } from '@/app/collab/awareness'
import { useCollabIdentity } from '@/app/collab/identity'
import { publishLocalAgents } from '@/app/collab/local-awareness'
import { connectCollabRoom } from '@/app/collab/room/connection'
import { replaceRoomSnapshot, settleRoomImages } from '@/app/collab/room/image-sync'
import { createRoomImageBytes } from '@/app/collab/room/images'
import { deriveRoomStatus, type RoomStatus } from '@/app/collab/room/status'
import {
  readRoomName,
  readRoot,
  TREE_FORMAT,
  writeRoomName,
  type YNodes
} from '@/app/collab/shared-tree/fields'
import type { JoinCollabRoom } from '@/app/collab/transport'
import type { RemotePeer } from '@/app/collab/types'
import { bindVariableSync, type YRecords } from '@/app/collab/variables'
import { attachRoomVoice, type RoomVoice } from '@/app/collab/voice/room'
import {
  bindCollabGraphEvents,
  createYjsGraphSync,
  registerYjsObservers,
  BULK_SHARE_ORIGIN,
  remoteUpdateIsHistoricalDump,
  SYNC_ALL_NODES_SYNC_LIMIT
} from '@/app/collab/yjs-sync'
import type { EditorStore } from '@/app/editor/active-store'
import { setPeers } from '@/app/presence/registry'
import { ROOM_STATUS_TICK_MS, ROOM_UNREACHABLE_MS } from '@/constants'

/** How a tab came to be in a room: by sharing its own document, or by joining someone's. */
export type RoomOrigin = 'shared' | 'joined'

/** One room, live in one tab: its document, presence, connection, and saved copy. */
export interface RoomSession {
  readonly roomId: string
  readonly store: EditorStore
  readonly origin: RoomOrigin
  readonly peers: Readonly<Ref<RemotePeer[]>>
  readonly status: ComputedRef<RoomStatus>
  /** Whether the room's document has reached this tab, from a peer or the saved copy. */
  readonly hasDocument: Readonly<Ref<boolean>>
  readonly voice: RoomVoice
  updateCursor(x: number, y: number, pageId: string): void
  updateSelection(ids: string[]): void
  /** Writes the tab's whole document into the room and makes its root the room's. */
  shareDocument(): void
  /** Leaves the room and releases its connection, presence, and saved-copy handle. */
  dispose(): void
}

/** This device's saved copy of a room, so it opens before anyone else is online. */
export interface RoomSavedCopy {
  whenSynced: Promise<unknown>
  destroy(): unknown
  /** Rewrites the saved Yjs updates after image bytes leave the document. */
  replaceStoredState?(): Promise<void>
  /** Reads saved updates one record at a time, without joining them into one buffer. */
  replayUpdates?(send: (update: Uint8Array, peerId: string) => void, peerId: string): void
}

export interface RoomSessionOptions {
  roomId: string
  store: EditorStore
  origin: RoomOrigin
  joinRoom?: JoinCollabRoom
  /** Who this tab is in the room; the device's own identity unless a host stands in for one. */
  identity?: Pick<ReturnType<typeof useCollabIdentity>, 'name' | 'color'>
  openSavedCopy?: (roomId: string, ydoc: Y.Doc) => RoomSavedCopy
  /**
   * Byte length of the .fig this tab opened. First-page populate leaves most of a large
   * archive out of `graph.nodes`, so the layer count cannot decide this.
   */
  archiveBytes?: number
  /** How long the tab tries to reach the service that introduces peers before saying it cannot. */
  unreachableMs?: number
  /** How often the tab rechecks its connection while it waits for the file. */
  tickMs?: number
}

/**
 * A `.fig` larger than this is not a document whose whole graph fits in a room database.
 * aska-app is about 35MB and opens with `populate: 'first-page'`, so the canvas holds the
 * cover (about 100 layers) while the saved room snapshot still holds the old full dump.
 * Opening that database applies the dump in one synchronous transaction.
 */
export const LARGE_FIG_ARCHIVE_BYTES = 8 * 1024 * 1024

/**
 * Room IndexedDB is safe only for a document whose whole graph is already in memory and whose
 * archive is small. A first-page open of a large fig fails this even when `graphNodes` is 97.
 */
export function shouldOpenRoomDatabase(graphNodes: number, archiveBytes?: number): boolean {
  if (archiveBytes !== undefined && archiveBytes > LARGE_FIG_ARCHIVE_BYTES) return false
  if (graphNodes > SYNC_ALL_NODES_SYNC_LIMIT) return false
  return true
}

/**
 * No room database. `IndexeddbPersistence` would read the saved updates and apply them in one
 * `Y.applyUpdate` before this tab can reject the dump.
 */
function openUnpersistedRoomCopy(): RoomSavedCopy {
  return {
    whenSynced: Promise.resolve(),
    destroy() {
      return undefined
    }
  }
}

function openIndexedDBCopy(roomId: string, ydoc: Y.Doc): RoomSavedCopy {
  const persistence = new IndexeddbPersistence(`op-room-${roomId}`, ydoc)
  // y-indexeddb compacts every 500 updates with encodeStateAsUpdate of the whole document.
  // That one buffer is the tab-killing allocation for a file the size of aska-app, so updates
  // are appended and left as separate records.
  const stopUncompactedStore = keepRoomUpdatesUncompacted(persistence, ydoc)
  return {
    whenSynced: persistence.whenSynced,
    destroy: () => {
      stopUncompactedStore()
      return persistence.destroy()
    },
    replaceStoredState: () => replaceRoomSnapshot(persistence),
    replayUpdates(send, peerId) {
      const db = persistence.db
      if (!db || persistence._destroyed) return
      const request = db.transaction('updates', 'readonly').objectStore('updates').openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        if (cursor.value instanceof Uint8Array) send(cursor.value, peerId)
        cursor.continue()
      }
    }
  }
}

function keepRoomUpdatesUncompacted(persistence: IndexeddbPersistence, ydoc: Y.Doc): () => void {
  ydoc.off('update', persistence._storeUpdate)
  const storeUpdate = (update: Uint8Array, origin: unknown) => {
    // A bulk share is one update per chunk. Persisting them makes the next open apply the
    // whole room in a single y-indexeddb transaction. Edits after that stay small and are kept.
    if (
      origin === persistence ||
      origin === BULK_SHARE_ORIGIN ||
      persistence._destroyed ||
      update.byteLength > 256 * 1024
    ) {
      return
    }
    const db = persistence.db
    if (!db) return
    try {
      db.transaction('updates', 'readwrite').objectStore('updates').add(update)
    } catch (error) {
      console.error('[Collab] Failed to store a room update:', error)
    }
  }
  ydoc.on('update', storeUpdate)
  return () => ydoc.off('update', storeUpdate)
}

type CursorState = { x: number; y: number; pageId: string; zoom: number }

export function openRoomSession({
  roomId,
  store,
  origin,
  joinRoom,
  identity = useCollabIdentity(),
  openSavedCopy = openIndexedDBCopy,
  archiveBytes,
  unreachableMs = ROOM_UNREACHABLE_MS,
  tickMs = ROOM_STATUS_TICK_MS
}: RoomSessionOptions): RoomSession {
  const ydoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(ydoc)
  const ynodes: YNodes = ydoc.getMap('nodes')
  const yimages = ydoc.getMap<Uint8Array>('images')
  const meta = ydoc.getMap<unknown>('meta')
  const yvariables: YRecords = ydoc.getMap('variables')
  const ycollections: YRecords = ydoc.getMap('collections')
  // y-indexeddb applies every saved update inside one Y.applyUpdate before any observer can
  // refuse it. A large archive must not open that database at all. The in-memory layer count
  // is not the signal: first-page populate of aska-app leaves about 97 layers on screen.
  const persistence = shouldOpenRoomDatabase(store.graph.nodes.size, archiveBytes)
    ? openSavedCopy(roomId, ydoc)
    : openUnpersistedRoomCopy()
  const roomImages = createRoomImageBytes(roomId)
  const heldImages = new Map<string, Uint8Array>()
  let imageSync: Promise<void> = Promise.resolve()

  const peers = shallowRef<RemotePeer[]>([])
  const hasDocument = ref(false)
  const savedCopyLoaded = ref(false)
  const openedAt = Date.now()
  const now = ref(openedAt)
  /** When the current stretch of being connected to the service that introduces peers began. */
  const connectedSince = ref<number | null>(null)
  let suppressYjsEvents = false
  let suppressGraphSync = false
  let disposed = false

  const status = computed(() =>
    deriveRoomStatus({
      hasDocument: hasDocument.value,
      savedCopyLoaded: savedCopyLoaded.value,
      openFor: now.value - openedAt,
      connectedFor: connectedSince.value === null ? null : now.value - connectedSince.value,
      discoveryMs: connection.room.discoveryMs,
      unreachableMs,
      peerCount: peers.value.length,
      peersWithFile: peers.value.filter((peer) => peer.hasFile).length
    })
  )

  const sync = createYjsGraphSync({
    getStore: () => store,
    getYdoc: () => (disposed ? null : ydoc),
    getYnodes: () => (disposed ? null : ynodes),
    setSuppressYjsEvents: (value) => {
      suppressYjsEvents = value
    },
    images: roomImages
  })

  function syncRoomImages() {
    if (disposed) return
    imageSync = imageSync
      .then(async () => {
        if (disposed) return undefined
        await settleRoomImages({
          store,
          ydoc,
          yimages,
          held: heldImages,
          images: roomImages,
          setSuppressYjsEvents: (value) => {
            suppressYjsEvents = value
          },
          replaceStoredState: persistence.replaceStoredState?.bind(persistence),
          isActive: () => !disposed
        })
        return undefined
      })
      .catch((error: unknown) => {
        console.error('[Collab] Failed to settle room images:', error)
      })
  }

  function refreshDocument() {
    if (disposed) return
    const rootId = readRoot(meta)
    hasDocument.value = rootId !== undefined && store.graph.rootId === rootId
    // Newcomers wait for someone who has the file, so peers say whether they do.
    if (awareness.getLocalState()?.hasFile !== hasDocument.value) {
      awareness.setLocalStateField('hasFile', hasDocument.value)
    }
    const name = readRoomName(meta)
    if (hasDocument.value && name && origin === 'joined') store.state.documentName = name
  }

  function updatePeers() {
    const next = buildRemotePeers(
      awareness.getStates() as Map<number, Record<string, unknown>>,
      awareness.clientID
    )
    peers.value = next
    setPeers(store, next)
  }

  function broadcastIdentity() {
    awareness.setLocalStateField('user', { name: identity.name.value, color: identity.color })
    awareness.setLocalStateField('treeFormat', TREE_FORMAT)
  }

  const unregisterYjsObservers = registerYjsObservers({
    store,
    ynodes,
    yimages,
    getSuppressYjsEvents: () => suppressYjsEvents,
    setSuppressGraphSync: (value) => {
      suppressGraphSync = value
    },
    applyYjsToGraph: (events) => {
      sync.applyYjsToGraph(events)
      refreshDocument()
    },
    rememberSharedImage: (hash, bytes) => {
      heldImages.set(hash, bytes)
    },
    onSharedImagesAdded: () => {
      if (!savedCopyLoaded.value || disposed) return
      syncRoomImages()
    }
  })
  meta.observe(refreshDocument)
  awareness.on('change', updatePeers)

  const connection = connectCollabRoom({
    roomId,
    ydoc,
    awareness,
    updatePeersList: updatePeers,
    joinRoom,
    replayStoredUpdates: persistence.replayUpdates?.bind(persistence),
    acceptRemoteUpdate(update) {
      if (!remoteUpdateIsHistoricalDump(store.graph.nodes.size, update.byteLength)) return true
      console.warn(
        '[Collab] Skipped a historical room snapshot; the open file stays as it is.'
      )
      return false
    }
  })
  broadcastIdentity()

  // y-indexeddb resolves whenSynced only after a successful read, and never rejects it.
  // A stuck database would otherwise leave the room on "connecting" with the spinner up.
  const savedCopyTimer = setTimeout(() => {
    if (disposed || savedCopyLoaded.value) return
    savedCopyLoaded.value = true
  }, unreachableMs)
  void persistence.whenSynced.then(
    () => {
      if (disposed) return undefined
      clearTimeout(savedCopyTimer)
      savedCopyLoaded.value = true
      refreshDocument()
      syncRoomImages()
      return undefined
    },
    () => {
      if (disposed) return undefined
      clearTimeout(savedCopyTimer)
      savedCopyLoaded.value = true
      return undefined
    }
  )
  // Signaling services report no events, so the tab polls while it waits for the file.
  function checkConnection() {
    now.value = Date.now()
    if (!connection.room.signalingConnected()) connectedSince.value = null
    else connectedSince.value ??= now.value
  }
  checkConnection()
  const connectionTimer = useIntervalFn(() => {
    if (!hasDocument.value) checkConnection()
  }, tickMs)

  const stopNameWatch = watch(identity.name, broadcastIdentity)
  const stopZoomWatch = store.onEditorEvent('viewport:changed', (viewport) => {
    const cursor = awareness.getLocalState()?.cursor as CursorState | undefined
    if (cursor) awareness.setLocalStateField('cursor', { ...cursor, zoom: viewport.zoom })
  })
  const stopAgentSync = publishLocalAgents(store, () => awareness, identity.color)
  const stopAgentPreviews = shareAgentPreviews(store, connection)
  const voice = attachRoomVoice({ awareness, peers, connection })
  const variableSync = bindVariableSync({ store, ydoc, yvariables, ycollections })
  const unbindGraphEvents = bindCollabGraphEvents({
    store,
    getYdoc: () => (disposed ? null : ydoc),
    getYnodes: () => (disposed ? null : ynodes),
    getSuppressGraphSync: () => suppressGraphSync,
    syncLocalEdit: sync.syncLocalEdit
  })

  return {
    roomId,
    store,
    origin,
    peers,
    status,
    hasDocument,
    voice,
    updateCursor(x, y, pageId) {
      awareness.setLocalStateField('cursor', { x, y, pageId, zoom: store.state.zoom })
    },
    updateSelection(ids) {
      awareness.setLocalStateField('selection', ids)
    },
    shareDocument() {
      writeRoomName(meta, store.state.documentName)
      // A large file is already on screen from S3. Copying its layers into the room walks
      // them all after paint and freezes the tab. Presence and later edits still sync.
      if (store.graph.nodes.size > SYNC_ALL_NODES_SYNC_LIMIT) {
        sync.claimSharedDocument()
        refreshDocument()
        return
      }
      sync.syncAllNodesToYjs()
      variableSync.share()
      refreshDocument()
    },
    dispose() {
      if (disposed) return
      // Unbinding writes an edit still waiting to be sent, so it runs while the room is open.
      unbindGraphEvents()
      variableSync.dispose()
      disposed = true
      connectionTimer.pause()
      clearTimeout(savedCopyTimer)
      stopNameWatch()
      stopZoomWatch()
      stopAgentSync()
      stopAgentPreviews()
      voice.dispose()
      meta.unobserve(refreshDocument)
      unregisterYjsObservers()
      // Destroying the awareness can emit a last change; nothing here should react to it.
      awareness.off('change', updatePeers)
      void connection.room.leave()
      awareness.destroy()
      void persistence.destroy()
      ydoc.destroy()
      peers.value = []
      setPeers(store, [])
    }
  }
}
