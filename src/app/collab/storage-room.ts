import { roomIdForStorageDocument } from '@/app/collab/room/storage-id'
import { roomForStore, shareDocument } from '@/app/collab/rooms'
import type { EditorStore } from '@/app/editor/active-store'
import { readStoragePreferences } from '@/app/integrations/storage'
import type { StorageDocumentBinding } from '@/app/integrations/storage'

/**
 * Puts a storage-backed document tab into the deterministic collab room for that
 * object, so peers who open the same S3 document meet without pasting a link.
 *
 * Does nothing when this tab is already in any room (including an explicit Share /
 * `/share/:roomId` session), so auto-join never overrides a manual room.
 * When the target room is already open in another tab, `shareDocument` switches
 * there instead of attaching a second session to the same room id.
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

  shareDocument(store, roomId, { archiveBytes })
}
