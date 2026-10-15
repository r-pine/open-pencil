import { describe, expect, test } from 'bun:test'

import {
  normalizeStorageEndpoint,
  roomIdForStorageDocument,
  storageCollabFingerprint
} from '@/app/collab/room/storage-id'
import { isRoomId } from '@/app/collab/room/id'

describe('storage collab room ids', () => {
  test('normalizes endpoints so trailing slashes and missing schemes still match', () => {
    expect(normalizeStorageEndpoint('https://pencil-s3.rpine.xyz/')).toBe(
      'https://pencil-s3.rpine.xyz'
    )
    expect(normalizeStorageEndpoint('pencil-s3.rpine.xyz')).toBe('https://pencil-s3.rpine.xyz')
    expect(normalizeStorageEndpoint('HTTPS://Pencil-S3.rpine.xyz')).toBe(
      'https://pencil-s3.rpine.xyz'
    )
  })

  test('fingerprint is stable for the same storage identity', () => {
    const parts = {
      providerId: 's3-compatible',
      endpoint: 'https://pencil-s3.rpine.xyz/',
      bucket: 'open-pencil',
      documentId: '11111111-2222-4333-8444-555555555555'
    }
    expect(storageCollabFingerprint(parts)).toBe(
      storageCollabFingerprint({
        ...parts,
        endpoint: 'pencil-s3.rpine.xyz'
      })
    )
  })

  test('derives a valid deterministic room id from storage identity', async () => {
    const parts = {
      providerId: 's3-compatible',
      endpoint: 'https://pencil-s3.rpine.xyz',
      bucket: 'open-pencil',
      documentId: '11111111-2222-4333-8444-555555555555'
    }
    const a = await roomIdForStorageDocument(parts)
    const b = await roomIdForStorageDocument({
      ...parts,
      endpoint: 'https://pencil-s3.rpine.xyz/'
    })
    expect(isRoomId(a)).toBe(true)
    expect(a).toBe(b)
    expect(a).not.toBe(
      await roomIdForStorageDocument({ ...parts, documentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    )
    expect(a).not.toBe(await roomIdForStorageDocument({ ...parts, bucket: 'other-bucket' }))
  })
})
