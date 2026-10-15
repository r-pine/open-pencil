import { storeState, type IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { paintImageBatch, type CollabImageBytes } from '@/app/collab/room/images'
import { SYNC_ALL_NODES_SYNC_LIMIT } from '@/app/collab/yjs-sync'
import type { EditorStore } from '@/app/editor/active-store'

function logRoomImageError(context: string, error: unknown) {
  console.error(`[Collab] ${context}:`, error)
}

function sharedImageEntries(
  yimages: Y.Map<Uint8Array>,
  held: ReadonlyMap<string, Uint8Array>
): Array<[string, Uint8Array]> {
  const entries = new Map<string, Uint8Array>()
  for (const [hash, bytes] of held) {
    if (hash && bytes.byteLength > 0) entries.set(hash, bytes)
  }
  for (const [hash, bytes] of yimages.entries()) {
    if (hash && bytes.byteLength > 0) entries.set(hash, bytes)
  }
  return [...entries]
}

function cloneSharedValue(value: unknown): unknown {
  if (!(value instanceof Y.Map)) return value
  const copy = new Y.Map<unknown>()
  for (const [key, entry] of value.entries()) copy.set(key, cloneSharedValue(entry))
  return copy
}

function roomIsTooLargeToSnapshot(doc: Y.Doc): boolean {
  return doc.getMap('nodes').size > SYNC_ALL_NODES_SYNC_LIMIT
}

/** A Yjs update of `doc` with the `images` map left out, so deleted binaries cannot ride along. */
export function encodeDocWithoutImages(doc: Y.Doc): Uint8Array {
  // Copying every Y.Map into a second document, then encoding it, is one buffer of the whole file.
  if (roomIsTooLargeToSnapshot(doc)) return new Uint8Array()
  const fresh = new Y.Doc()
  fresh.transact(() => {
    for (const [name, shared] of doc.share) {
      if (name === 'images') continue
      if (!(shared instanceof Y.Map)) continue
      const copy = fresh.getMap<unknown>(name)
      for (const [key, entry] of shared.entries()) copy.set(key, cloneSharedValue(entry))
    }
  })
  const update = Y.encodeStateAsUpdate(fresh)
  fresh.destroy()
  return update
}

function snapshotKeepsImages(doc: Y.Doc): boolean {
  if (roomIsTooLargeToSnapshot(doc)) return false
  const update = Y.encodeStateAsUpdate(doc)
  const probe = new Y.Doc()
  Y.applyUpdate(probe, update)
  const kept = probe.getMap('images').size > 0
  probe.destroy()
  return kept
}

async function overwriteUpdates(
  persistence: IndexeddbPersistence,
  update: Uint8Array
): Promise<void> {
  const db = persistence.db ?? (await persistence._db)
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('updates', 'readwrite')
    const store = transaction.objectStore('updates')
    store.clear()
    const added = store.add(update)
    added.onsuccess = () => {
      persistence._dbref = Number(added.result) + 1
      persistence._dbsize = 1
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('Failed to rewrite the room snapshot'))
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('Failed to rewrite the room snapshot'))
    }
  })
}

/**
 * Replaces the saved Yjs updates with one snapshot of the document.
 * Image bytes are omitted: Yjs drops deleted map values, and a snapshot that still carries them
 * is rewritten from the layers and meta alone before `storeState` compacts IndexedDB.
 */
export async function replaceRoomSnapshot(persistence: IndexeddbPersistence): Promise<void> {
  // `storeState` and `encodeStateAsUpdate` turn every layer into one buffer. That is the
  // allocation that freezes a file the size of aska-app, so a large room keeps its updates apart.
  if (persistence.doc.getMap('nodes').size > SYNC_ALL_NODES_SYNC_LIMIT) return
  if (persistence._storeTimeoutId !== null) {
    clearTimeout(persistence._storeTimeoutId)
    persistence._storeTimeoutId = null
  }
  // Drop the stored updates before compaction. `storeState` would otherwise read every saved
  // update, including image bytes that are already gone from the live document.
  const update = snapshotKeepsImages(persistence.doc)
    ? encodeDocWithoutImages(persistence.doc)
    : Y.encodeStateAsUpdate(persistence.doc)
  await overwriteUpdates(persistence, update)
  await storeState(persistence, true)
}

export async function settleRoomImages({
  store,
  ydoc,
  yimages,
  held,
  images,
  setSuppressYjsEvents,
  replaceStoredState,
  isActive = () => true
}: {
  store: EditorStore
  ydoc: Y.Doc
  yimages: Y.Map<Uint8Array>
  held: Map<string, Uint8Array>
  images: CollabImageBytes
  setSuppressYjsEvents: (value: boolean) => void
  replaceStoredState?: () => Promise<void>
  isActive?: () => boolean
}): Promise<void> {
  try {
    const entries = sharedImageEntries(yimages, held)
    if (entries.length > 0) {
      await images.write(
        entries,
        (batch) => {
          if (isActive()) paintImageBatch(store, batch)
        },
        isActive
      )
      if (!isActive()) return
      // Observers stay quiet so this delete cannot clear bytes just copied onto the canvas.
      setSuppressYjsEvents(true)
      try {
        const keys = [...yimages.keys()]
        ydoc.transact(() => {
          for (const key of keys) yimages.delete(key)
        })
      } finally {
        setSuppressYjsEvents(false)
      }
      for (const [hash] of entries) held.delete(hash)
      if (replaceStoredState) await replaceStoredState()
      return
    }
    await images.read((batch) => {
      if (isActive()) paintImageBatch(store, batch)
    }, isActive)
  } catch (error) {
    logRoomImageError('Failed to settle room images', error)
  }
}
