import { describe, expect, test } from 'bun:test'

import {
  matchingStorageDocument,
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

  test('finds the stored document a share room was derived from', async () => {
    const identity = {
      providerId: 's3-compatible',
      endpoint: 'https://pencil-s3.rpine.xyz',
      bucket: 'open-pencil'
    }
    const aska = {
      id: '0bfe8bc5-ae3c-4ef9-8848-b886a94cc7d9',
      name: 'aska-app'
    }
    const roomId = await roomIdForStorageDocument({ ...identity, documentId: aska.id })
    expect(roomId).toBe('pnwttwlabdqwnv7quvklzx16s8jzqwza')
    expect(await matchingStorageDocument(roomId, [aska], identity)).toEqual(aska)
    expect(
      await matchingStorageDocument(roomId, [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }], identity)
    ).toBeNull()
  })
})
