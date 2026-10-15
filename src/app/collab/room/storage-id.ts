import { ROOM_ID_CHARS, ROOM_ID_LENGTH } from '@/constants'

/**
 * Stable fingerprint for a storage-backed document's collaboration room.
 *
 * Tradeoff: the room id is a SHA-256 digest of this fingerprint, encoded into the
 * public room-id alphabet. Anyone who knows provider + endpoint + bucket + documentId
 * (typical for collaborators who already share the same S3 config) can derive the room
 * id. It is not a secret invitation; it is a shared rendezvous for that storage object.
 * Random `/share/` room ids remain the bearer-credential path for invite-only rooms.
 */
export function storageCollabFingerprint(parts: {
  providerId: string
  endpoint: string
  bucket: string
  documentId: string
}): string {
  return [
    'openpencil-storage-room:v1',
    parts.providerId.trim(),
    normalizeStorageEndpoint(parts.endpoint),
    parts.bucket.trim(),
    parts.documentId.trim()
  ].join('\0')
}

/** Endpoint shape that matches how S3 clients connect (scheme + no trailing slash). */
export function normalizeStorageEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const withScheme =
    trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    url.hash = ''
    url.search = ''
    // Hostnames are case-insensitive; keep path casing as typed.
    url.hostname = url.hostname.toLowerCase()
    return url.toString().replace(/\/+$/, '')
  } catch {
    return withScheme.toLowerCase()
  }
}

/**
 * Deterministic room id for a storage document: SHA-256 → 32 chars of [a-z0-9].
 * Same storage identity always yields the same room across sessions and browsers.
 */
export async function roomIdForStorageDocument(parts: {
  providerId: string
  endpoint: string
  bucket: string
  documentId: string
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(storageCollabFingerprint(parts))
  )
  const bytes = new Uint8Array(digest)
  let roomId = ''
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    roomId += ROOM_ID_CHARS[bytes[i]! % ROOM_ID_CHARS.length]
  }
  return roomId
}
