import * as Y from 'yjs'

import { normalizeNodeInstanceOverrides, type SceneGraph } from '@open-pencil/scene-graph'
import { siblingOrderKeys } from '@open-pencil/scene-graph/order-keys'

import {
  collabNodeShareBytes,
  decodeNodeFromYjs,
  isLegacyEmptyOverrideRecord,
  syncEncodedNodeToYMap,
  type EncodeNodeOptions
} from '@/app/collab/node-codec'
import {
  claimRoot,
  markTreeFormat,
  readParentEntries,
  writeOrderKey,
  writePage,
  writeParentEntry,
  writeRootEntries,
  type YNodes
} from '@/app/collab/shared-tree/fields'
import { migrateLegacyLayers, TREE_MIGRATION_ORIGIN } from '@/app/collab/shared-tree/migration'
import {
  applySharedTree,
  createLocalEdit,
  createSharedTree,
  isLocalEditEmpty,
  keepSharedLayers,
  pageOf,
  recordLocalLayers,
  writeLocalPlacement,
  type LocalEdit,
  type SharedTree
} from '@/app/collab/shared-tree/sync'
import {
  imageHashesChanged,
  imageHashesInGraph,
  imageHashesOf,
  type CollabImageBytes
} from '@/app/collab/room/images'
import type { EditorStore } from '@/app/editor/active-store'

type YImages = Y.Map<Uint8Array>

type GraphBindingOptions = {
  store: EditorStore
  getYdoc: () => Y.Doc | null
  getYnodes: () => YNodes | null
  getSuppressGraphSync: () => boolean
  syncLocalEdit: (edit: LocalEdit) => void
}

type YjsObserverOptions = {
  store: EditorStore
  ynodes: YNodes
  yimages: YImages
  getSuppressYjsEvents: () => boolean
  setSuppressGraphSync: (value: boolean) => void
  applyYjsToGraph: (events: Y.YEvent<Y.Map<unknown>>[]) => void
  /** Keeps a reference to bytes that arrived in the shared map, without copying them. */
  rememberSharedImage?: (hash: string, bytes: Uint8Array) => void
  /** Runs once per remote change that added image bytes, after the saved copy is in use. */
  onSharedImagesAdded?: () => void
}

type YjsGraphSyncOptions = {
  getStore: () => EditorStore
  getYdoc: () => Y.Doc | null
  getYnodes: () => YNodes | null
  setSuppressYjsEvents: (value: boolean) => void
  /** Room image bytes. They are not written into the Y.Doc. */
  images?: CollabImageBytes
}

function logCollabSyncError(context: string, error: unknown) {
  console.error(`[Collab] ${context}:`, error)
}

/**
 * Above this many layers the open file stays on the canvas and out of the room. Copying it into
 * Yjs, or applying a previously copied room back onto the graph, walks every layer on the main
 * thread. aska-app is about 100k layers. The room then carries presence and edits made after
 * joining. The fig is the document.
 */
export const SYNC_ALL_NODES_SYNC_LIMIT = 800
/**
 * A remote update larger than this, on a file already over the sync limit, is a historical copy
 * of the document rather than a live edit. Applying it is one transaction of every layer.
 */
export const REMOTE_DUMP_UPDATE_BYTES = 1024 * 1024

export function remoteUpdateIsHistoricalDump(graphNodes: number, updateBytes: number): boolean {
  return graphNodes > SYNC_ALL_NODES_SYNC_LIMIT && updateBytes > REMOTE_DUMP_UPDATE_BYTES
}

const HISTORICAL_SNAPSHOT_WARNING =
  '[Collab] Skipped a historical room snapshot; the open file stays as it is.'
/**
 * Marks the chunked share of a file this tab already has. Those updates are not written to
 * IndexedDB: y-indexeddb would apply every saved update in one transaction the next time the
 * room opens.
 */
export const BULK_SHARE_ORIGIN = Symbol('collab-bulk-share')
/** Layers written into one Yjs transaction while a large document is shared. */
const SYNC_CHUNK_NODES = 40
/**
 * Bytes of editable fields written into one transaction. A chunk of 40 layers is still one long
 * task when those layers carry Figma geometry, so the cap is the clone size, not the layer count.
 */
const SYNC_CHUNK_BYTES = 64 * 1024
/** One field larger than this stays on the local graph instead of being cloned into the chunk. */
const SYNC_FIELD_BYTES = 512 * 1024
const LARGE_SHARE_FIELDS: EncodeNodeOptions = {
  omitLocalGeometry: true,
  maxFieldBytes: SYNC_FIELD_BYTES
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** Parents of an edited layer, up to the root. A live edit places against this spine, not every sibling. */
function ancestorSpine(graph: SceneGraph, ids: Iterable<string>): string[] {
  const spine: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    let parent = graph.getNode(id)?.parentId ?? null
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      spine.push(parent)
      parent = graph.getNode(parent)?.parentId ?? null
    }
  }
  return spine
}

/** Records where a spine layer already sits, without reading its siblings. */
function seedSharedPlace(graph: SceneGraph, ynodes: YNodes, nodeId: string): void {
  const node = graph.getNode(nodeId)
  const ynode = ynodes.get(nodeId)
  if (!node || !ynode) return
  if (node.parentId === null) {
    writeRootEntries(ynode)
    return
  }
  if (!readParentEntries(ynode)?.has(node.parentId)) writeParentEntry(ynode, node.parentId, 0)
  const pageId = pageOf(graph, nodeId)
  if (pageId !== undefined) writePage(ynode, pageId)
}

/**
 * Collects the graph events of one edit and syncs them once, after the edit, in one Yjs
 * transaction, so a move writes its parent entry and order key against the final layer order.
 */
export function bindCollabGraphEvents({
  store,
  getYdoc,
  getYnodes,
  getSuppressGraphSync,
  syncLocalEdit
}: GraphBindingOptions) {
  let edit = createLocalEdit()
  let bound = true

  function record(update: (pending: LocalEdit) => void) {
    if (getSuppressGraphSync() || !getYdoc() || !getYnodes()) return
    if (store.graph.isApplyingImportedState) edit.bulk = true
    if (isLocalEditEmpty(edit)) queueMicrotask(flush)
    update(edit)
  }

  function flush() {
    const pending = edit
    edit = createLocalEdit()
    if (bound && getYdoc() && getYnodes()) syncLocalEdit(pending)
  }

  const unbinds = [
    store.onEditorEvent('node:updated', (id, changes) =>
      record((pending) => {
        // A direct parentId write, as a checkpoint restore makes, syncs as a move when it
        // differs from the shared tree; a childIds write re-keys the children out of order.
        pending.changed.add(id)
        if ('childIds' in changes) pending.reordered.add(id)
      })
    ),
    store.onEditorEvent('node:created', (node) =>
      record((pending) => {
        pending.changed.add(node.id)
        pending.placed.add(node.id)
      })
    ),
    store.onEditorEvent('node:reparented', (nodeId, oldParentId) =>
      record((pending) => {
        pending.changed.add(nodeId)
        pending.placed.add(nodeId)
        if (oldParentId) pending.previousParents.add(oldParentId)
      })
    ),
    store.onEditorEvent('node:reordered', (nodeId, _parentId, _index, previousParentId) =>
      record((pending) => {
        pending.placed.add(nodeId)
        if (previousParentId) pending.previousParents.add(previousParentId)
      })
    ),
    store.onEditorEvent('node:deleted', (id) => record((pending) => pending.deleted.add(id)))
  ]
  return () => {
    // An edit made just before leaving still reaches the room.
    if (!isLocalEditEmpty(edit)) flush()
    bound = false
    for (const unbind of unbinds) unbind()
  }
}

export function registerYjsObservers({
  store,
  ynodes,
  yimages,
  getSuppressYjsEvents,
  setSuppressGraphSync,
  applyYjsToGraph,
  rememberSharedImage,
  onSharedImagesAdded
}: YjsObserverOptions): () => void {
  function onNodes(events: Y.YEvent<Y.Map<unknown>>[], transaction: Y.Transaction) {
    // A migration this peer wrote was applied by the change that triggered it.
    if (getSuppressYjsEvents() || transaction.origin === TREE_MIGRATION_ORIGIN) return
    setSuppressGraphSync(true)
    try {
      applyYjsToGraph(events)
      store.requestRender()
    } catch (error) {
      logCollabSyncError('Failed to apply remote graph changes', error)
    } finally {
      setSuppressGraphSync(false)
    }
  }

  function onImages(event: Y.YMapEvent<Uint8Array>) {
    if (getSuppressYjsEvents()) return
    try {
      // A delete of a shared image key is the migration that strips bytes from the room
      // snapshot. It must not drop bytes the canvas, or a peer, already holds.
      let added = false
      for (const [key, change] of event.changes.keys) {
        if (change.action === 'delete') continue
        const data = yimages.get(key)
        if (!data) continue
        rememberSharedImage?.(key, data)
        added = true
      }
      if (added) onSharedImagesAdded?.()
    } catch (error) {
      logCollabSyncError('Failed to apply remote image changes', error)
    }
  }

  ynodes.observeDeep(onNodes)
  yimages.observe(onImages)
  return () => {
    ynodes.unobserveDeep(onNodes)
    yimages.unobserve(onImages)
  }
}

export function createYjsGraphSync({
  getStore,
  getYdoc,
  getYnodes,
  setSuppressYjsEvents,
  images
}: YjsGraphSyncOptions) {
  let pendingPageSwitch: { store: EditorStore; pageId: string } | undefined
  let shared: SharedTree | null = null
  const layerHashes = new Map<string, Set<string>>()
  let bulkEdits: Promise<void> = Promise.resolve()
  let bulkQueued = 0

  function sharedTreeOf(ydoc: Y.Doc): SharedTree {
    if (shared?.ydoc !== ydoc) {
      shared = createSharedTree(ydoc, () => getStore().graph, getYnodes)
    }
    return shared
  }

  function writeNode(
    graph: SceneGraph,
    ynodes: YNodes,
    nodeId: string,
    options?: EncodeNodeOptions
  ): void {
    const node = graph.getNode(nodeId)
    if (!node) return
    let ynode = ynodes.get(nodeId)
    if (!ynode) {
      ynode = new Y.Map()
      ynodes.set(nodeId, ynode)
    }
    syncEncodedNodeToYMap(node, ynode, options)
  }

  /**
   * Image bytes stay in the room's side store. The layer keeps `imageHash`, which is already
   * written with the node, and the canvas paints `graph.images`.
   */
  function publishImages(
    graph: SceneGraph,
    nodeIds: Iterable<string>,
    deletedIds: Iterable<string>,
    releaseUnusedHashes = true
  ): void {
    if (!images) return
    const deleted = new Set(deletedIds)
    let paintsChanged = false
    const retained: Array<[string, Uint8Array]> = []
    const seen = new Set<string>()
    for (const id of nodeIds) {
      if (deleted.has(id) && !graph.getNode(id)) continue
      const next = imageHashesOf(graph.getNode(id))
      const previous = layerHashes.get(id)
      if (imageHashesChanged(previous, next)) paintsChanged = true
      if (next.size > 0) layerHashes.set(id, next)
      else layerHashes.delete(id)
      for (const hash of next) {
        if (seen.has(hash)) continue
        seen.add(hash)
        const data = graph.images.get(hash)
        if (data) retained.push([hash, data])
      }
    }
    for (const id of deleted) {
      if (graph.getNode(id)) continue
      layerHashes.delete(id)
      paintsChanged = true
    }
    if (retained.length > 0) images.retain(retained)
    // A bulk share must not walk every layer once per chunk. The caller releases once, at the end.
    if (
      releaseUnusedHashes &&
      paintsChanged &&
      graph.nodes.size <= SYNC_ALL_NODES_SYNC_LIMIT
    ) {
      images.releaseUnused(imageHashesInGraph(graph))
    }
  }

  /**
   * A page load creates thousands of layers in one edit. Writing them in one transaction clones
   * every field on the main thread. Large edits are copied in the same slices as the first share.
   */
  async function syncEditInChunks(edit: LocalEdit): Promise<void> {
    await yieldToMainThread()
    const graph = getStore().graph
    const ydoc = getYdoc()
    const ynodes = getYnodes()
    if (!ydoc || !ynodes) return
    const orderKeys = new Map<string, Map<string, string>>()
    const tree = sharedTreeOf(ydoc)
    const deleted: string[] = []
    for (const id of edit.deleted) {
      if (graph.getNode(id)) {
        edit.changed.add(id)
        edit.placed.add(id)
        continue
      }
      deleted.push(id)
    }
    const ids = [...new Set([...edit.changed, ...edit.placed])]

    async function writeSlice(slice: string[], deleteIds: string[]): Promise<void> {
      setSuppressYjsEvents(true)
      try {
        ydoc.transact(() => {
          for (const id of deleteIds) {
            ynodes.delete(id)
            tree.tree.deleteLayer(id)
          }
          if (slice.length === 0) return
          claimRoot(ydoc.getMap('meta'), graph.rootId)
          markTreeFormat(ydoc.getMap('meta'))
          for (const id of slice) writeNode(graph, ynodes, id, LARGE_SHARE_FIELDS)
          for (const id of slice) placeSharedNode(graph, ynodes, id, orderKeys)
        }, BULK_SHARE_ORIGIN)
        if (slice.length > 0) {
          recordLocalLayers(tree, ynodes, ydoc.getMap('meta'), slice)
          publishImages(graph, slice, deleteIds, false)
        }
      } catch (error) {
        logCollabSyncError('Failed to sync local edit', error)
      } finally {
        setSuppressYjsEvents(false)
      }
    }

    if (deleted.length > 0) {
      await writeSlice([], deleted)
      await yieldToMainThread()
    }
    const pending: string[] = []
    let pendingBytes = 0
    for (const id of ids) {
      const node = graph.getNode(id)
      const weight = node ? collabNodeShareBytes(node, LARGE_SHARE_FIELDS) : 1
      const chunkFull =
        pending.length >= SYNC_CHUNK_NODES ||
        (pending.length > 0 && pendingBytes + weight > SYNC_CHUNK_BYTES)
      if (chunkFull) {
        await writeSlice(pending.splice(0, pending.length), [])
        pendingBytes = 0
        await yieldToMainThread()
      }
      pending.push(id)
      pendingBytes += weight
    }
    if (pending.length > 0) await writeSlice(pending, [])
  }

  /**
   * A delete of a layer the room has never met has to be introduced before it can be removed,
   * and those two steps cannot share a transaction or the peer never observes the removal.
   */
  function scheduleUnseenDeletes(ids: readonly string[]) {
    const pending = [...ids]
    queueMicrotask(() => {
      const ydoc = getYdoc()
      const ynodes = getYnodes()
      if (!ydoc || !ynodes || pending.length === 0) return
      const tree = sharedTreeOf(ydoc)
      setSuppressYjsEvents(true)
      try {
        ydoc.transact(() => {
          for (const id of pending) {
            ynodes.delete(id)
            tree.tree.deleteLayer(id)
          }
        })
      } catch (error) {
        console.warn('[Collab] Failed to sync a deletion', error)
      } finally {
        setSuppressYjsEvents(false)
      }
    })
  }

  /** Writes one local edit: changed layers' fields, deletions, and where layers now sit. */
  function syncLocalEdit(edit: LocalEdit) {
    const count = edit.deleted.size + edit.changed.size + edit.placed.size
    const graph = getStore().graph
    // The existing graph of a large file is not an edit. A later change of a few layers is.
    if (graph.nodes.size > SYNC_ALL_NODES_SYNC_LIMIT) {
      if (count > SYNC_ALL_NODES_SYNC_LIMIT) {
        console.warn(
          '[Collab] Skipped sharing an existing large document; later edits still sync.'
        )
        return
      }
      syncSmallEdit(edit)
      return
    }
    if (edit.bulk || count > SYNC_CHUNK_NODES || bulkQueued > 0) {
      bulkQueued++
      bulkEdits = bulkEdits
        .catch(() => undefined)
        .then(() => syncEditInChunks(edit))
        .finally(() => {
          bulkQueued--
        })
      return
    }
    syncSmallEdit(edit)
  }

  function syncSmallEdit(edit: LocalEdit) {
    const graph = getStore().graph
    const ydoc = getYdoc()
    const ynodes = getYnodes()
    if (!ydoc || !ynodes) return
    const tree = sharedTreeOf(ydoc)
    const largeFile = graph.nodes.size > SYNC_ALL_NODES_SYNC_LIMIT
    const unseenDeletes: string[] = []
    let spine: string[] = []
    setSuppressYjsEvents(true)
    try {
      ydoc.transact(() => {
        for (const id of edit.deleted) {
          if (graph.getNode(id)) {
            // Deleted and restored within the edit, as an undo can.
            edit.changed.add(id)
            edit.placed.add(id)
            continue
          }
          if (largeFile && !ynodes.has(id)) {
            ynodes.set(id, new Y.Map())
            unseenDeletes.push(id)
            continue
          }
          ynodes.delete(id)
          tree.tree.deleteLayer(id)
        }
        keepSharedLayers(tree, graph, edit)
        if (largeFile) {
          spine = ancestorSpine(graph, [...edit.changed, ...edit.placed])
          for (const id of spine) {
            if (!ynodes.has(id)) writeNode(graph, ynodes, id, LARGE_SHARE_FIELDS)
            seedSharedPlace(graph, ynodes, id)
          }
        }
        const fieldOptions = largeFile ? LARGE_SHARE_FIELDS : undefined
        for (const id of edit.changed) writeNode(graph, ynodes, id, fieldOptions)
        for (const id of edit.placed) {
          if (!ynodes.has(id)) writeNode(graph, ynodes, id, fieldOptions)
        }
        writeLocalPlacement(tree, graph, ynodes, ydoc.getMap('meta'), edit)
      })
      if (spine.length > 0) recordLocalLayers(tree, ynodes, ydoc.getMap('meta'), spine)
      if (unseenDeletes.length > 0) scheduleUnseenDeletes(unseenDeletes)
      publishImages(graph, [...edit.changed, ...edit.placed], edit.deleted)
    } catch (error) {
      logCollabSyncError('Failed to sync local edit', error)
    } finally {
      setSuppressYjsEvents(false)
    }
  }

  function syncNodeToYjs(nodeId: string) {
    const edit = createLocalEdit()
    edit.changed.add(nodeId)
    syncLocalEdit(edit)
  }

  /**
   * Records the document root without copying layers. A large file stays on screen; the room
   * hears presence and the edits that happen after this claim.
   */
  function claimSharedDocument() {
    const graph = getStore().graph
    const ydoc = getYdoc()
    if (!ydoc) return
    setSuppressYjsEvents(true)
    try {
      ydoc.transact(() => {
        claimRoot(ydoc.getMap('meta'), graph.rootId)
        markTreeFormat(ydoc.getMap('meta'))
      })
      sharedTreeOf(ydoc).setRoot(graph.rootId)
    } catch (error) {
      console.warn('[Collab] Failed to claim shared document', error)
    } finally {
      setSuppressYjsEvents(false)
    }
  }

  function orderKeyFor(
    graph: SceneGraph,
    parentId: string,
    nodeId: string,
    cache: Map<string, Map<string, string>>
  ): string | undefined {
    let keys = cache.get(parentId)
    if (!keys) {
      const parent = graph.getNode(parentId)
      const children = parent
        ? parent.childIds.filter((id) => graph.getNode(id)?.parentId === parentId)
        : []
      const assigned = siblingOrderKeys(children.map(() => undefined))
      keys = new Map(children.map((id, index) => [id, assigned[index] ?? '']))
      cache.set(parentId, keys)
    }
    return keys.get(nodeId)
  }

  function placeSharedNode(
    graph: SceneGraph,
    ynodes: YNodes,
    nodeId: string,
    orderKeys: Map<string, Map<string, string>>
  ) {
    const node = graph.getNode(nodeId)
    const ynode = ynodes.get(nodeId)
    if (!node || !ynode) return
    if (node.parentId === null) {
      writeRootEntries(ynode)
      return
    }
    const pageId = pageOf(graph, nodeId)
    if (pageId !== undefined) writePage(ynode, pageId)
    writeParentEntry(ynode, node.parentId, 0)
    const orderKey = orderKeyFor(graph, node.parentId, nodeId, orderKeys)
    if (orderKey) writeOrderKey(ynode, orderKey)
  }

  function usedImageHashes(): Set<string> {
    const used = new Set<string>()
    for (const hashes of layerHashes.values()) {
      for (const hash of hashes) used.add(hash)
    }
    return used
  }

  /**
   * Shares a document the canvas already holds, a few layers at a time. A file over
   * `SYNC_ALL_NODES_SYNC_LIMIT` is not copied: the open fig is the document, and walking every
   * layer after paint freezes the tab. Callers share later edits through `syncLocalEdit`.
   */
  async function syncAllNodesInChunks(isActive: () => boolean = () => true): Promise<void> {
    if (getStore().graph.nodes.size > SYNC_ALL_NODES_SYNC_LIMIT) {
      console.warn('[Collab] Left a large document out of the room; later edits still sync.')
      return
    }
    await yieldToMainThread()
    if (!isActive()) return
    const ids = [...getStore().graph.nodes.keys()]
    const orderKeys = new Map<string, Map<string, string>>()
    const pending: string[] = []
    let pendingBytes = 0

    async function flush(): Promise<void> {
      if (pending.length === 0 || !isActive()) return
      const slice = pending.splice(0, pending.length)
      pendingBytes = 0
      const graph = getStore().graph
      const ydoc = getYdoc()
      const ynodes = getYnodes()
      if (!ydoc || !ynodes) return
      setSuppressYjsEvents(true)
      try {
        ydoc.transact(() => {
          claimRoot(ydoc.getMap('meta'), graph.rootId)
          markTreeFormat(ydoc.getMap('meta'))
          for (const id of slice) writeNode(graph, ynodes, id, LARGE_SHARE_FIELDS)
          for (const id of slice) placeSharedNode(graph, ynodes, id, orderKeys)
        }, BULK_SHARE_ORIGIN)
        recordLocalLayers(sharedTreeOf(ydoc), ynodes, ydoc.getMap('meta'), slice)
        publishImages(graph, slice, [], false)
      } catch (error) {
        logCollabSyncError('Failed to sync document', error)
      } finally {
        setSuppressYjsEvents(false)
      }
    }

    for (const id of ids) {
      if (!isActive()) return
      const node = getStore().graph.getNode(id)
      const weight = node ? collabNodeShareBytes(node, LARGE_SHARE_FIELDS) : 1
      const chunkFull =
        pending.length >= SYNC_CHUNK_NODES ||
        (pending.length > 0 && pendingBytes + weight > SYNC_CHUNK_BYTES)
      if (chunkFull) {
        await flush()
        if (!isActive()) return
        await yieldToMainThread()
        if (!isActive()) return
      }
      pending.push(id)
      pendingBytes += weight
    }
    await flush()
    if (!isActive()) return
    const roomImages = images
    if (roomImages) roomImages.releaseUnused(usedImageHashes())
  }

  /**
   * Shares this peer's whole document, as Share does: every layer, its parent with counter 0, its
   * order, and its page, with its root as the room's.
   */
  function syncAllNodesToYjs() {
    const graph = getStore().graph
    const ydoc = getYdoc()
    const ynodes = getYnodes()
    if (!ydoc || !ynodes) return
    // One transaction of every layer is one Yjs update of the whole file. Callers above the
    // limit share in chunks instead; this must not build that buffer.
    if (graph.nodes.size > SYNC_ALL_NODES_SYNC_LIMIT) return
    setSuppressYjsEvents(true)
    try {
      ydoc.transact(() => {
        for (const node of graph.getAllNodes()) writeNode(graph, ynodes, node.id)
        for (const node of graph.getAllNodes()) {
          const ynode = ynodes.get(node.id)
          if (!ynode) continue
          if (node.parentId === null) writeRootEntries(ynode)
          const pageId = pageOf(graph, node.id)
          if (pageId !== undefined) writePage(ynode, pageId)
          const children = node.childIds.filter((id) => graph.getNode(id)?.parentId === node.id)
          const keys = siblingOrderKeys(children.map(() => undefined))
          children.forEach((childId, index) => {
            const child = ynodes.get(childId)
            if (!child) return
            writeParentEntry(child, node.id, 0)
            writeOrderKey(child, keys[index])
          })
        }
        claimRoot(ydoc.getMap('meta'), graph.rootId)
        markTreeFormat(ydoc.getMap('meta'))
      })
      recordLocalLayers(sharedTreeOf(ydoc), ynodes, ydoc.getMap('meta'), ynodes.keys())
      const nodeIds: string[] = []
      for (const node of graph.getAllNodes()) nodeIds.push(node.id)
      publishImages(graph, nodeIds, [])
    } catch (error) {
      logCollabSyncError('Failed to sync document', error)
    } finally {
      setSuppressYjsEvents(false)
    }
  }

  function incomingNodeMapIsFullDocument(events: Y.YEvent<Y.Map<unknown>>[]): boolean {
    const ynodes = getYnodes()
    if (!ynodes) return false
    for (const event of events) {
      if (event.target === ynodes && event.changes.keys.size > SYNC_ALL_NODES_SYNC_LIMIT) {
        return true
      }
    }
    return false
  }

  function applyYjsToGraph(events: Y.YEvent<Y.Map<unknown>>[]) {
    const store = getStore()
    const ydoc = getYdoc()
    const ynodes = getYnodes()
    if (!ydoc || !ynodes) return
    // One transaction that names every layer is a leftover room snapshot. Replaying it onto
    // the graph is the pause that follows first paint. The open file stays as it is.
    if (incomingNodeMapIsFullDocument(events)) {
      console.warn(HISTORICAL_SNAPSHOT_WARNING)
      return
    }
    const changed = new Set<string>()
    const deleted = new Set<string>()
    for (const event of events) {
      if (event.target === ynodes) {
        for (const [key, change] of event.changes.keys) {
          if (change.action === 'delete') deleted.add(key)
          else changed.add(key)
        }
        continue
      }
      // The path from the nodes map starts with the layer's id, whether its own field changed
      // or an entry of its nested parents map did.
      const [nodeId] = event.path
      if (typeof nodeId === 'string') changed.add(nodeId)
    }

    migrateLegacyLayers(ydoc, ynodes, ydoc.getMap('meta'), changed)
    for (const nodeId of changed) {
      const ynode = ynodes.get(nodeId)
      if (ynode) applyYnodeToGraph(store.graph, nodeId, ynode)
    }
    const gone = [...deleted].filter((nodeId) => !ynodes.has(nodeId))
    // Moves go first, so a layer moved out of a deleted parent survives the deletion.
    applySharedTree(
      sharedTreeOf(ydoc),
      store.graph,
      ynodes,
      ydoc.getMap('meta'),
      changed,
      gone,
      store.graph.nodes.size > SYNC_ALL_NODES_SYNC_LIMIT
    )
    for (const nodeId of gone) store.graph.deleteNode(nodeId)
    ensureCurrentPageExists(store)
  }

  /** Applies a layer's own fields; `applySharedTree` places it in the tree afterwards. */
  function applyYnodeToGraph(graph: SceneGraph, nodeId: string, ynode: Y.Map<unknown>) {
    const props = decodeNodeFromYjs(ynode)
    const existing = graph.getNode(nodeId)
    if (existing) {
      if (isLegacyEmptyOverrideRecord(ynode.get('instanceOverrides'))) {
        const overrides = normalizeNodeInstanceOverrides(existing)
        if (overrides.self.size > 0 || overrides.descendants.size > 0) {
          delete props.instanceOverrides
        }
      }
      // The room carries editable fields, not the fig blobs this tab already loaded.
      // Replacing `source` would drop those blobs from a file that is open locally.
      if (existing.source.format === 'fig') delete props.source
      if (existing.fillGeometry.length > 0) delete props.fillGeometry
      if (existing.strokeGeometry.length > 0) delete props.strokeGeometry
      graph.updateNode(nodeId, props)
      return
    }
    const type = props.type
    if (type) graph.createNodeWithId(nodeId, type, null, { ...props, childIds: [] })
  }

  function ensureCurrentPageExists(store: EditorStore) {
    const pages = store.graph.getPages()
    if (pages.some((page) => page.id === store.state.currentPageId)) return
    if (pages.length === 0) return
    const pageId = pages[0].id
    if (pendingPageSwitch?.store === store && pendingPageSwitch.pageId === pageId) return
    const pending = { store, pageId }
    pendingPageSwitch = pending
    void store
      .switchPage(pageId)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        logCollabSyncError('Failed to switch to a synced page', error)
      })
      .finally(() => {
        if (pendingPageSwitch === pending) pendingPageSwitch = undefined
      })
  }

  return {
    syncNodeToYjs,
    syncLocalEdit,
    syncAllNodesToYjs,
    claimSharedDocument,
    syncAllNodesInChunks,
    applyYjsToGraph
  }
}
