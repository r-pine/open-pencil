import { isRoomId } from '@/app/collab/room/id'
import { matchingStorageDocument, roomIdForStorageDocument } from '@/app/collab/room/storage-id'
import { roomById, roomForStore, shareDocument } from '@/app/collab/rooms'
import type { EditorStore } from '@/app/editor/active-store'
import {
  activeStorageProviderID,
  createActiveStorageAdapter,
  isStorageConfigured,
  readStoragePreferences
} from '@/app/integrations/storage'
import type { StorageDocument, StorageDocumentBinding } from '@/app/integrations/storage'
import { getLocalCanvasStore } from '@/app/storage/local-store'

/**
 * Puts a storage-backed document tab into the deterministic collab room for that
 * object, so peers who open the same S3 document meet without pasting a link.
 *
 * Does nothing when this tab is already in any room, so auto-join never overrides a
 * manual room. A room already open on another tab keeps that tab when it is this same
 * file. A room that only holds an older saved copy is closed so this file becomes the room.
 */
export async function ensureStorageCollabRoom(
  store: EditorStore,
  binding: StorageDocumentBinding,
  archiveBytes?: number
): Promise<void> {
  if (roomForStore(store)) return

  const preferences = readStoragePreferences(binding.providerId)
  const roomId = await roomIdForStorageDocument({
    providerId: binding.providerId,
    endpoint: preferences.endpoint ?? '',
    bucket: preferences.bucket ?? '',
    documentId: binding.documentId
  })

  // A share link joins first and replays the room's old saved copy. That tab must not
  // stay in front of the stored file, or the open looks like the edits never reached S3.
  const existing = roomById(roomId)
  if (existing && existing.store !== store) {
    const bound = existing.store.getStorageBinding()
    const sameFile =
      bound?.providerId === binding.providerId && bound.documentId === binding.documentId
    if (!sameFile) {
      const { closeTab, getTabForStore } = await import('@/app/tabs')
      const tab = getTabForStore(existing.store)
      if (tab) await closeTab(tab.id, 'discard')
    }
  }
  if (roomForStore(store)) return

  shareDocument(store, roomId, { archiveBytes })
}

/**
 * The stored file this share room belongs to. Opening the link then loads that file
 * (local pending bytes included) instead of the room's older saved copy.
 */
export async function storageDocumentForShareRoom(roomId: string): Promise<StorageDocument | null> {
  if (!isRoomId(roomId)) return null
  const providerId = activeStorageProviderID.value
  const preferences = readStoragePreferences(providerId)
  const endpoint = preferences.endpoint ?? ''
  const bucket = preferences.bucket ?? ''
  if (!endpoint || !bucket) return null

  const documents = new Map<string, StorageDocument>()
  const local = await getLocalCanvasStore().listMetas(true)
  for (const meta of local) {
    if (meta.providerId !== providerId || meta.tombstoned) continue
    documents.set(meta.id, {
      id: meta.id,
      name: meta.name,
      updatedAt: meta.updatedAt,
      metadataAuthoritative: meta.syncStatus === 'synced'
    })
  }
  if (await isStorageConfigured(providerId)) {
    try {
      const remote = await createActiveStorageAdapter(providerId).listDocuments()
      for (const document of remote) {
        const pending = documents.get(document.id)
        documents.set(document.id, pending ? { ...document, ...pending } : document)
      }
    } catch (error) {
      console.warn('[Collab] Could not list stored documents for this room', error)
    }
  }
  return matchingStorageDocument(roomId, [...documents.values()], {
    providerId,
    endpoint,
    bucket
  })
}
