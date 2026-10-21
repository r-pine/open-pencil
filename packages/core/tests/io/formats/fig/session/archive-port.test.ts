import { expect, test } from 'bun:test'
import { deflateSync } from 'fflate'

import {
  decodeFigPatchRecords,
  type FigPatchedArchiveInput,
  type FigRecordPatch
} from '@open-pencil/fig'
import { getSchemaBytes, type NodeChange } from '@open-pencil/kiwi/fig/codec'

import { workerFigArchive } from '#core/kiwi/fig/session/archive'
import type { FigSessionRequest, FigSessionResponse } from '#core/kiwi/fig/session/protocol'

const schema = deflateSync(getSchemaBytes())

const emptyPatch = {
  records: [],
  blobs: [],
  removed: [],
  replaceVariables: false
} satisfies FigRecordPatch

function input(image?: Uint8Array): FigPatchedArchiveInput {
  return {
    thumbnailPNG: new Uint8Array([1, 2, 3]),
    metaJSON: '{}',
    images: image ? [{ name: 'images/a.png', data: image }] : []
  }
}

const idleWorker = { terminate: () => undefined, addEventListener: () => undefined }

test('a patch transfers encoded records and copies of new bytes', async () => {
  const image = new Uint8Array([4, 5, 6, 7])
  const records = [
    {
      guid: { sessionID: 0, localID: 4 },
      parentIndex: { guid: { sessionID: 0, localID: 2 }, position: '4' },
      type: 'FRAME',
      name: 'Renamed'
    }
  ] as NodeChange[]
  let handler: ((event: MessageEvent<FigSessionResponse>) => void) | undefined
  const access = workerFigArchive(
    {
      postMessage: (message, transfer) => {
        const request = message as FigSessionRequest
        expect(request.type).toBe('patch-archive')
        if (request.type !== 'patch-archive') return
        expect(request).not.toHaveProperty('patch')
        expect(request.records).toBeInstanceOf(Uint8Array)
        expect(request.fieldMeta).toEqual([])
        expect(request.fieldSets.byteLength).toBe(0)
        expect(decodeFigPatchRecords(schema, request.records)).toEqual(records)
        const buffers = (transfer as ArrayBuffer[] | undefined) ?? []
        expect(buffers.includes(image.buffer)).toBe(false)
        expect(buffers).toContain(request.records.buffer)
        const copied = request.input.images[0]?.data
        expect(copied?.buffer).not.toBe(image.buffer)
        expect(buffers).toContain(copied?.buffer)
        expect(image[0]).toBe(4)
        structuredClone(message, { transfer: buffers })
        expect(image[0]).toBe(4)
        handler?.({
          data: {
            type: 'patch-archive-result',
            requestId: request.requestId,
            bytes: new Uint8Array([9])
          }
        } as MessageEvent<FigSessionResponse>)
      },
      addEventListener: (_type, listener) => {
        handler = listener as (event: MessageEvent<FigSessionResponse>) => void
      },
      close: () => undefined
    },
    idleWorker,
    () => {
      throw new Error('encoded patches stay on the worker')
    },
    schema
  )
  expect(await access.patch({ ...emptyPatch, records }, input(image))).toEqual(new Uint8Array([9]))
})

test('a large bitmap is transferred as a copy and does not stop the worker', async () => {
  const image = new Uint8Array(8 * 1024 * 1024 + 1)
  image[0] = 3
  let posted = false
  let terminated = false
  let handler: ((event: MessageEvent<FigSessionResponse>) => void) | undefined
  const access = workerFigArchive(
    {
      postMessage: (message, transfer) => {
        posted = true
        const request = message as FigSessionRequest
        if (request.type !== 'patch-archive') return
        const buffers = (transfer as ArrayBuffer[] | undefined) ?? []
        expect(buffers.includes(image.buffer)).toBe(false)
        expect(buffers).toContain(request.input.images[0]?.data.buffer)
        expect(request.records).toBeInstanceOf(Uint8Array)
        handler?.({
          data: {
            type: 'patch-archive-result',
            requestId: request.requestId,
            bytes: new Uint8Array([3])
          }
        } as MessageEvent<FigSessionResponse>)
      },
      addEventListener: (_type, listener) => {
        handler = listener as (event: MessageEvent<FigSessionResponse>) => void
      },
      close: () => undefined
    },
    {
      terminate: () => {
        terminated = true
      },
      addEventListener: () => undefined
    },
    () => {
      throw new Error('a transferred bitmap stays on the worker')
    },
    schema
  )
  expect(await access.patch(emptyPatch, input(image))).toEqual(new Uint8Array([3]))
  expect(posted).toBe(true)
  expect(terminated).toBe(false)
  expect(image[0]).toBe(3)
})

test('a DataCloneError while posting still saves on the calling thread', async () => {
  let terminated = false
  const access = workerFigArchive(
    {
      postMessage: () => {
        throw new DOMException(
          "Failed to execute 'postMessage' on 'MessagePort': Data cannot be cloned, out of memory.",
          'DataCloneError'
        )
      },
      addEventListener: () => undefined,
      close: () => undefined
    },
    {
      terminate: () => {
        terminated = true
      },
      addEventListener: () => undefined
    },
    () => ({
      original: () => Promise.resolve(new Uint8Array()),
      info: () => Promise.reject(new Error('unused')),
      componentPages: () => Promise.resolve([]),
      patch: () => Promise.resolve(new Uint8Array([5])),
      close: () => undefined
    }),
    schema
  )
  expect(await access.patch(emptyPatch, input(new Uint8Array([8])))).toEqual(new Uint8Array([5]))
  expect(terminated).toBe(false)
  expect(await access.patch(emptyPatch, input(new Uint8Array([8])))).toEqual(new Uint8Array([5]))
})

test('without an archive schema the patch runs on the calling thread', async () => {
  let posted = false
  const access = workerFigArchive(
    {
      postMessage: () => {
        posted = true
      },
      addEventListener: () => undefined,
      close: () => undefined
    },
    idleWorker,
    () => ({
      original: () => Promise.resolve(new Uint8Array()),
      info: () => Promise.reject(new Error('unused')),
      componentPages: () => Promise.resolve([]),
      patch: () => Promise.resolve(new Uint8Array([6])),
      close: () => undefined
    }),
    null
  )
  expect(await access.patch(emptyPatch, input())).toEqual(new Uint8Array([6]))
  expect(posted).toBe(false)
})
