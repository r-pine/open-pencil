import type { DBSchema } from 'idb'

import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import type { EditorStore } from '@/app/editor/active-store'
import { APP_DATABASE_NAMES, connectAppDatabase, defineAppDatabase } from '@/app/storage/idb'

const IMAGE_STORE = 'images'
/** One image per turn. A file the size of aska-app has about 1900, and copying them together freezes the tab. */
const IMAGE_BATCH = 1
const IMAGE_BATCH_BYTES = 64 * 1024

/**
 * Image bytes for one room. They stay out of the Y.Doc, so a saved room snapshot can open
 * without replaying every fill on the main thread.
 */
export interface CollabImageBytes {
  /** Remembers bytes for image fills. A hash already stored in this session is left as it is. */
  retain(entries: ReadonlyArray<readonly [string, Uint8Array]>): void
  /** Forgets stored hashes that no remaining fill uses. */
  releaseUnused(used: ReadonlySet<string>): void
  /**
   * Stores bytes, yielding between batches. `onStored` runs after each batch is durable, so the
   * canvas can paint those images before the rest are written.
   */
  write(
    entries: ReadonlyArray<readonly [string, Uint8Array]>,
    onStored?: (batch: ReadonlyArray<readonly [string, Uint8Array]>) => void,
    isActive?: () => boolean
  ): Promise<void>
  /** Reads saved images a few at a time. The callback paints one batch. */
  read(
    onBatch: (entries: ReadonlyArray<readonly [string, Uint8Array]>) => void,
    isActive?: () => boolean
  ): Promise<void>
}

interface RoomImageDatabase extends DBSchema {
  images: {
    key: string
    value: Uint8Array
  }
}

const roomImageDatabase = defineAppDatabase<RoomImageDatabase>({
  name: APP_DATABASE_NAMES.roomImages,
  version: 1,
  callbacks: {
    upgrade(database) {
      if (!database.objectStoreNames.contains(IMAGE_STORE)) database.createObjectStore(IMAGE_STORE)
    }
  }
})

function logRoomImageError(context: string, error: unknown) {
  console.error(`[Collab] ${context}:`, error)
}

/**
 * Lets the browser paint and take a click before the next image. Idle callbacks can run several
 * batches back to back when the tab is otherwise idle, which is the whole image set in one stretch.
 */
function nextImageIdle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export function imageHashesOf(node: SceneNode | undefined): Set<string> {
  const hashes = new Set<string>()
  if (!node) return hashes
  for (const paint of node.fills) if (paint.imageHash) hashes.add(paint.imageHash)
  for (const paint of node.strokes) if (paint.imageHash) hashes.add(paint.imageHash)
  return hashes
}

export function imageHashesInGraph(graph: SceneGraph): Set<string> {
  const used = new Set<string>()
  for (const node of graph.getAllNodes()) {
    for (const hash of imageHashesOf(node)) used.add(hash)
  }
  return used
}

function sameHashes(left: ReadonlySet<string> | undefined, right: ReadonlySet<string>): boolean {
  if (!left) return right.size === 0
  if (left.size !== right.size) return false
  for (const hash of right) if (!left.has(hash)) return false
  return true
}

export function imageHashesChanged(
  previous: ReadonlySet<string> | undefined,
  next: ReadonlySet<string>
): boolean {
  return !sameHashes(previous, next)
}

function batchesOf(
  entries: ReadonlyArray<readonly [string, Uint8Array]>
): Array<Array<readonly [string, Uint8Array]>> {
  const batches: Array<Array<readonly [string, Uint8Array]>> = []
  let batch: Array<readonly [string, Uint8Array]> = []
  let bytes = 0
  for (const entry of entries) {
    const size = entry[1].byteLength
    if (batch.length > 0 && (batch.length >= IMAGE_BATCH || bytes + size > IMAGE_BATCH_BYTES)) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(entry)
    bytes += size
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/** Paints image bytes that are not on the canvas yet, and asks for a frame when any were added. */
export function paintImageBatch(
  store: EditorStore,
  batch: ReadonlyArray<readonly [string, Uint8Array]>
): void {
  let painted = false
  for (const [hash, bytes] of batch) {
    if (!hash || store.graph.images.has(hash)) continue
    store.graph.images.set(hash, bytes)
    painted = true
  }
  if (painted) store.requestRender()
}

function imageKey(roomId: string, hash: string): string {
  return `${roomId}\u0000${hash}`
}

function hashFromKey(roomId: string, key: string): string {
  const prefix = `${roomId}\u0000`
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

/** In-memory stand-in for tests and for runtimes without IndexedDB. */
export function createMemoryRoomImages(): CollabImageBytes & {
  get(hash: string): Uint8Array | undefined
  has(hash: string): boolean
} {
  const saved = new Map<string, Uint8Array>()
  return {
    retain(entries) {
      for (const [hash, bytes] of entries) saved.set(hash, bytes)
    },
    releaseUnused(used) {
      for (const hash of saved.keys()) if (!used.has(hash)) saved.delete(hash)
    },
    async write(entries, onStored, isActive) {
      for (const batch of batchesOf(entries)) {
        if (isActive && !isActive()) return
        await nextImageIdle()
        if (isActive && !isActive()) return
        for (const [hash, bytes] of batch) saved.set(hash, bytes)
        onStored?.(batch)
      }
    },
    async read(onBatch, isActive) {
      for (const batch of batchesOf([...saved])) {
        if (isActive && !isActive()) return
        await nextImageIdle()
        if (isActive && !isActive()) return
        onBatch(batch)
      }
    },
    get: (hash) => saved.get(hash),
    has: (hash) => saved.has(hash)
  }
}

function createIdbRoomImages(roomId: string): CollabImageBytes {
  const database = connectAppDatabase(roomImageDatabase)
  const written = new Set<string>()
  const prefix = `${roomId}\u0000`

  async function keysForRoom(): Promise<string[]> {
    const db = await database.open()
    return db.getAllKeys(IMAGE_STORE, IDBKeyRange.bound(prefix, `${prefix}\uffff`))
  }

  async function putBatch(batch: ReadonlyArray<readonly [string, Uint8Array]>): Promise<void> {
    const db = await database.open()
    const tx = db.transaction(IMAGE_STORE, 'readwrite')
    await Promise.all([
      ...batch.map(([hash, bytes]) => tx.store.put(bytes, imageKey(roomId, hash))),
      tx.done
    ])
    for (const [hash] of batch) written.add(hash)
  }

  async function storeEntries(
    entries: ReadonlyArray<readonly [string, Uint8Array]>,
    onStored?: (batch: ReadonlyArray<readonly [string, Uint8Array]>) => void,
    isActive?: () => boolean,
    onlyMissing = false
  ): Promise<void> {
    for (const batch of batchesOf(entries)) {
      if (isActive && !isActive()) return
      await nextImageIdle()
      if (isActive && !isActive()) return
      const fresh = onlyMissing ? batch.filter(([hash]) => !written.has(hash)) : batch
      if (fresh.length > 0) await putBatch(fresh)
      onStored?.(batch)
    }
  }

  return {
    retain(entries) {
      const fresh = entries.filter(([hash]) => hash && !written.has(hash))
      if (fresh.length === 0) return
      for (const [hash] of fresh) written.add(hash)
      void storeEntries(fresh).catch((error: unknown) => {
        for (const [hash] of fresh) written.delete(hash)
        logRoomImageError('Failed to save room images', error)
      })
    },
    releaseUnused(used) {
      void keysForRoom()
        .then(async (keys) => {
          const stale = keys.filter((key) => !used.has(hashFromKey(roomId, key)))
          for (let index = 0; index < stale.length; index += IMAGE_BATCH) {
            await nextImageIdle()
            const slice = stale.slice(index, index + IMAGE_BATCH)
            const db = await database.open()
            const tx = db.transaction(IMAGE_STORE, 'readwrite')
            await Promise.all([...slice.map((key) => tx.store.delete(key)), tx.done])
            for (const key of slice) written.delete(hashFromKey(roomId, key))
          }
          return undefined
        })
        .catch((error: unknown) => {
          logRoomImageError('Failed to drop unused room images', error)
        })
    },
    write(entries, onStored, isActive) {
      return storeEntries(entries, onStored, isActive, true)
    },
    async read(onBatch, isActive) {
      const keys = await keysForRoom()
      for (let index = 0; index < keys.length; index += IMAGE_BATCH) {
        if (isActive && !isActive()) return
        await nextImageIdle()
        if (isActive && !isActive()) return
        const slice = keys.slice(index, index + IMAGE_BATCH)
        const db = await database.open()
        const tx = db.transaction(IMAGE_STORE)
        const batch: Array<readonly [string, Uint8Array]> = []
        for (const key of slice) {
          const value = await tx.store.get(key)
          if (value) batch.push([hashFromKey(roomId, key), value])
        }
        await tx.done
        if (batch.length > 0) onBatch(batch)
      }
    }
  }
}

export function createRoomImageBytes(roomId: string): CollabImageBytes {
  if (typeof indexedDB === 'undefined') return createMemoryRoomImages()
  return createIdbRoomImages(roomId)
}
