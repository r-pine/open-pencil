import {
  encodeFigPatchFields,
  encodeFigPatchRecords,
  figArchiveComponentUsePages,
  patchFigArchive,
  type FigArchiveRecordInfo,
  type FigFieldPatchMeta,
  type FigPatchedArchiveInput,
  type FigRecordPatch
} from '@open-pencil/fig'
import type { SceneGraph } from '@open-pencil/scene-graph'
import { randomHex } from '@open-pencil/scene-graph/random'

import type { FigSessionRequest, FigSessionResponse } from '#core/kiwi/fig/session/protocol'

/**
 * The `.fig` archive a document was opened from, for writing the document back as that archive
 * with only its changed records replaced. In the browser the reader's worker holds the archive
 * and does this work; elsewhere, or once that worker is gone, it runs where it is asked.
 */
export interface FigArchiveAccess {
  original(): Promise<Uint8Array>
  info(): Promise<FigArchiveRecordInfo>
  /** Archive GUIDs of the pages whose instances use these components. */
  componentPages(componentIds: string[]): Promise<string[]>
  patch(patch: FigRecordPatch, input: FigPatchedArchiveInput): Promise<Uint8Array>
  /** The document closed: release whatever holds the archive. */
  close(): void
}

const archives = new WeakMap<SceneGraph, FigArchiveAccess>()

export function registerFigArchive(graph: SceneGraph, archive: FigArchiveAccess): void {
  archives.set(graph, archive)
}

export function figArchive(graph: SceneGraph): FigArchiveAccess | undefined {
  return archives.get(graph)
}

export function releaseFigArchive(graph: SceneGraph): void {
  archives.get(graph)?.close()
  archives.delete(graph)
}

/**
 * The archive operations themselves, over bytes nothing else writes to. They read the archive
 * as bytes, so they outlive the reader session that opened it; only the record info comes from
 * that session, taken while its records are decoded.
 */
export function createFigArchiveOperations(bytes: ArrayBuffer, info: () => FigArchiveRecordInfo) {
  return {
    original: () => new Uint8Array(bytes.slice(0)),
    info,
    componentPages: (componentIds: string[]) => figArchiveComponentUsePages(bytes, componentIds),
    patch: (patch: FigRecordPatch, input: FigPatchedArchiveInput) =>
      patchFigArchive(bytes, patch, input)
  }
}

export function localFigArchive(
  bytes: ArrayBuffer,
  info: () => FigArchiveRecordInfo
): FigArchiveAccess {
  const operations = createFigArchiveOperations(bytes, info)
  return {
    original: async () => operations.original(),
    info: async () => operations.info(),
    componentPages: async (componentIds) => operations.componentPages(componentIds),
    patch: async (patch, input) => operations.patch(patch, input),
    close: () => undefined
  }
}

type ArchiveResponse = Extract<
  FigSessionResponse,
  {
    type:
      | 'original-archive-result'
      | 'archive-info-result'
      | 'component-pages-result'
      | 'patch-archive-result'
      | 'archive-error'
  }
>

const ARCHIVE_RESPONSES = new Set<FigSessionResponse['type']>([
  'original-archive-result',
  'archive-info-result',
  'component-pages-result',
  'patch-archive-result',
  'archive-error'
])

type ArchivePort = Pick<MessagePort, 'postMessage' | 'addEventListener' | 'close'>
type ArchiveWorker = Pick<Worker, 'terminate' | 'addEventListener'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** True when the session port could not take the patch, so the caller writes it instead. */
export function isPortCloneFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'DataCloneError') return true
  const message = error.message.toLowerCase()
  return (
    message.includes('could not be cloned') ||
    message.includes('cannot be cloned') ||
    message.includes('data cannot be cloned') ||
    message.includes('out of memory') ||
    message.includes('allocation failed') ||
    message.includes('invalid message') ||
    message.includes('archive schema') ||
    message.includes('patch records')
  )
}

function ownedBytes(bytes: Uint8Array, transfer: ArrayBuffer[]): Uint8Array {
  if (bytes.byteLength === 0) return bytes
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  transfer.push(copy.buffer)
  return copy
}

interface PortableArchivePatch {
  records: Uint8Array
  fieldSets: Uint8Array
  fieldMeta: FigFieldPatchMeta[]
  blobs: Uint8Array[]
  removed: FigRecordPatch['removed']
  replaceVariables: boolean
  input: FigPatchedArchiveInput
  transfer: ArrayBuffer[]
}

/**
 * Records travel as Kiwi bytes the worker decodes with the schema it already holds.
 * New blob and image bytes are copies: transferring them must not detach live `graph.images`
 * buffers, the same reason a fig export does not transfer views it still holds.
 */
function portableArchivePatch(
  schemaDeflated: Uint8Array,
  patch: FigRecordPatch,
  input: FigPatchedArchiveInput
): PortableArchivePatch {
  const transfer: ArrayBuffer[] = []
  const records = encodeFigPatchRecords(schemaDeflated, patch.records)
  transfer.push(records.buffer)
  let encodedFields: ReturnType<typeof encodeFigPatchFields>
  try {
    encodedFields = encodeFigPatchFields(schemaDeflated, patch.fields ?? [])
  } catch (error) {
    // The caller patches on this thread when the worker cannot take the records.
    throw new Error('patch records', { cause: error })
  }
  if (encodedFields.sets.byteLength > 0) transfer.push(encodedFields.sets.buffer)
  const thumbnailPNG = input.thumbnailPNG ? ownedBytes(input.thumbnailPNG, transfer) : undefined
  return {
    records,
    fieldSets: encodedFields.sets,
    fieldMeta: encodedFields.meta,
    blobs: patch.blobs.map((blob) => ownedBytes(blob, transfer)),
    removed: patch.removed,
    replaceVariables: patch.replaceVariables,
    input: {
      metaJSON: input.metaJSON,
      ...(thumbnailPNG ? { thumbnailPNG } : {}),
      images: input.images.map((image) => ({
        name: image.name,
        data: ownedBytes(image.data, transfer)
      }))
    },
    transfer
  }
}

export interface WorkerFigArchiveAccess extends FigArchiveAccess {
  /** Stop the worker now, as an abandoned page load does; requests continue on the fallback. */
  dropWorker(): void
}

interface WaitingRequest {
  retry: (access: FigArchiveAccess) => void
  resolve: (response: ArchiveResponse) => void
  reject: (error: Error) => void
}

/**
 * Archive operations answered by the reader's worker over its session port. The worker serves
 * the archive until the document closes, even after it stops loading pages. If it fails or is
 * stopped, requests, those waiting included, run on the fallback instead.
 */
export function workerFigArchive(
  port: ArchivePort,
  worker: ArchiveWorker,
  fallback: () => FigArchiveAccess,
  schemaDeflated: Uint8Array | null
): WorkerFigArchiveAccess {
  const schema =
    schemaDeflated && schemaDeflated.byteLength > 0
      ? Uint8Array.from(schemaDeflated)
      : null
  const pending = new Map<string, WaitingRequest>()
  let local: FigArchiveAccess | undefined
  let closed = false
  const toFallback = (): FigArchiveAccess => {
    if (local) return local
    const access = fallback()
    local = access
    worker.terminate()
    for (const waiting of pending.values()) waiting.retry(access)
    pending.clear()
    return access
  }
  worker.addEventListener('error', () => toFallback())
  port.addEventListener('message', (event: MessageEvent<FigSessionResponse>) => {
    if (!ARCHIVE_RESPONSES.has(event.data.type)) return
    const response = event.data as ArchiveResponse
    const waiting = pending.get(response.requestId)
    if (!waiting) return
    pending.delete(response.requestId)
    if (response.type === 'archive-error') waiting.reject(new Error(response.error))
    else waiting.resolve(response)
  })
  const ask = <T extends ArchiveResponse['type'], Result>(
    message: DistributiveOmit<FigSessionRequest, 'requestId'>,
    type: T,
    read: (response: Extract<ArchiveResponse, { type: T }>) => Result,
    onFallback: (access: FigArchiveAccess) => Promise<Result>,
    transfer: ArrayBuffer[] = []
  ): Promise<Result> => {
    if (closed) return Promise.reject(new Error('The document closed'))
    if (local) return onFallback(local)
    return new Promise<Result>((resolve, reject) => {
      const requestId = randomHex()
      pending.set(requestId, {
        retry: (access) => void onFallback(access).then(resolve, reject),
        resolve: (response) => {
          if (response.type === type)
            resolve(read(response as Extract<ArchiveResponse, { type: T }>))
          else reject(new Error(`Unexpected ${response.type} for ${message.type}`))
        },
        reject
      })
      try {
        port.postMessage({ ...message, requestId }, transfer)
      } catch (error) {
        pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  return {
    original: () =>
      ask(
        { type: 'original-archive' },
        'original-archive-result',
        (response) => response.bytes,
        (access) => access.original()
      ),
    info: () =>
      ask(
        { type: 'archive-info' },
        'archive-info-result',
        (response) => response.info,
        (access) => access.info()
      ),
    componentPages: (componentIds) =>
      ask(
        { type: 'component-pages', componentIds },
        'component-pages-result',
        (response) => response.pageIds,
        (access) => access.componentPages(componentIds)
      ),
    patch: (patch, input) => {
      // Keep the reader's worker. Page loads and collab still use it. This write never posts
      // the NodeChange tree: records are Kiwi bytes, and a failed transfer patches here.
      const onMainThread = () => fallback().patch(patch, input)
      if (!schema) return onMainThread()
      let portable: PortableArchivePatch
      try {
        portable = portableArchivePatch(schema, patch, input)
      } catch (error) {
        if (!isPortCloneFailure(error)) throw error
        return onMainThread()
      }
      return ask(
        {
          type: 'patch-archive',
          records: portable.records,
          fieldSets: portable.fieldSets,
          fieldMeta: portable.fieldMeta,
          blobs: portable.blobs,
          removed: portable.removed,
          replaceVariables: portable.replaceVariables,
          input: portable.input
        },
        'patch-archive-result',
        (response) => response.bytes,
        (access) => access.patch(patch, input),
        portable.transfer
      ).catch((error: unknown) => {
        if (!isPortCloneFailure(error)) throw error
        return onMainThread()
      })
    },
    dropWorker: () => void toFallback(),
    close() {
      if (closed) return
      closed = true
      for (const waiting of pending.values()) waiting.reject(new Error('The document closed'))
      pending.clear()
      if (local) return
      port.postMessage({ type: 'dispose' })
      port.close()
      worker.terminate()
    }
  }
}
