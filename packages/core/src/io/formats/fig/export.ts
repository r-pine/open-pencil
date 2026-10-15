import type { CanvasKit } from 'canvaskit-wasm'

import { compressFigDataSync } from '@open-pencil/fig'
import {
  nameImagesForFigma,
  placeSlotContent,
  type FigNodeChangeExportRuntime
} from '@open-pencil/fig/node-change'
import { initCodec } from '@open-pencil/kiwi/fig/codec'
import type { NodeChange } from '@open-pencil/kiwi/fig/codec'
import type { SceneGraph } from '@open-pencil/scene-graph'
import { fractionalPosition } from '@open-pencil/scene-graph/order-keys'
import type { GUID } from '@open-pencil/scene-graph/primitives'

import type { SkiaRenderer } from '#core/canvas'
import { withFigExportRuntime } from '#core/canvas/text/shape'
import { IS_BROWSER, IS_TAURI } from '#core/constants'
import {
  exportSchema,
  figExportRecordOptions,
  figFileExtras,
  prepareFigExport,
  type FigExportSetup,
  type KiwiNodeChange
} from '#core/io/formats/fig/export-setup'
import { archiveImagesNamedForFigma, writePatchedFigFile } from '#core/io/formats/fig/patch/export'
import { sceneNodeToKiwi } from '#core/kiwi/fig/node-change/serialize'
import { cloneSceneGraphForFigExport } from '#core/kiwi/fig/parse/transfer'
import {
  hasPendingReaderPages,
  populateFigInternalPages,
  populateReaderExport
} from '#core/kiwi/fig/session/document-state'
import { isPortCloneFailure } from '#core/kiwi/fig/session/archive'
import { originalFigArchive } from '#core/kiwi/fig/session/original-archive'

import {
  appendVariableNodeChanges,
  sequentialPositions,
  assignSharedStyleGuids
} from './variable-export'

type InternalResourceContext = FigExportSetup & { nodeChanges: KiwiNodeChange[] }

/**
 * Children already written under a canvas. Shared styles, variables and the canvas's own
 * layers all append to the internal canvas from separate passes, so each continues this
 * count rather than numbering from zero and handing siblings the same order key.
 */
function countCanvasChildren(changes: readonly NodeChange[], canvas: GUID): number {
  let count = 0
  for (const change of changes) {
    const parent = change.parentIndex?.guid
    if (parent?.sessionID === canvas.sessionID && parent.localID === canvas.localID) count++
  }
  return count
}

function appendInternalResources(context: InternalResourceContext): void {
  const { graph, internalCanvasGuid, nodeChanges } = context
  if (!internalCanvasGuid) return
  const written = countCanvasChildren(nodeChanges, internalCanvasGuid)
  const sharedStyleNodes = [...graph.nodes.values()].filter((node) => node.sharedStyleType !== null)
  assignSharedStyleGuids(
    sharedStyleNodes,
    context.localIdCounter,
    context.nodeIdToGuid,
    context.assignedGuidValues
  )
  for (let index = 0; index < sharedStyleNodes.length; index++) {
    nodeChanges.push(
      ...sceneNodeToKiwi(
        sharedStyleNodes[index],
        internalCanvasGuid,
        written + index,
        context.localIdCounter,
        graph,
        context.blobs,
        {
          nodeIdToGuid: context.nodeIdToGuid,
          fontDigestMap: context.fontDigestMap,
          varIdToGuid: context.varIdToGuid,
          glyphBlobMap: context.glyphBlobMap,
          blobIndexByHex: context.blobIndexByHex,
          assignedGuidValues: context.assignedGuidValues,
          componentPropertyDefinitionsById: context.componentPropertyDefinitionsById,
          modeIdToGuid: context.modeIdToGuid,
          propertyIdToGuid: context.propertyIdToGuid,
          pluginDataOverrides: context.pluginDataOverrides,
          runtime: context.runtime
        }
      )
    )
  }
  if (graph.variableCollections.size > 0) {
    appendVariableNodeChanges(
      graph,
      nodeChanges,
      internalCanvasGuid,
      context.varIdToGuid,
      context.modeIdToGuid,
      sequentialPositions(written + sharedStyleNodes.length)
    )
  }
}

export async function exportFigFile(
  sourceGraph: SceneGraph,
  ck?: CanvasKit,
  renderer?: SkiaRenderer,
  pageId?: string,
  renderHeadlessThumbnail = false
): Promise<Uint8Array> {
  // An archive whose images Figma cannot read is written whole rather than reused.
  const reuseArchive = await archiveImagesNamedForFigma(sourceGraph)
  const originalArchive = reuseArchive ? await originalFigArchive(sourceGraph) : null
  if (originalArchive) return originalArchive.slice()
  return withFigExportRuntime(
    sourceGraph,
    ck,
    async (runtime) =>
      (reuseArchive
        ? await writePatchedFigFile(sourceGraph, runtime, {
            ck,
            renderer,
            pageId,
            renderHeadlessThumbnail
          })
        : null) ?? writeFigFile(sourceGraph, runtime, ck, renderer, pageId, renderHeadlessThumbnail)
  )
}

async function writeFigFile(
  sourceGraph: SceneGraph,
  runtime: FigNodeChangeExportRuntime,
  ck: CanvasKit | undefined,
  renderer: SkiaRenderer | undefined,
  pageId: string | undefined,
  renderHeadlessThumbnail: boolean
): Promise<Uint8Array> {
  await initCodec()
  populateFigInternalPages(sourceGraph)
  // The export reads the document itself and writes nothing to it. Only pages still in the
  // archive need a copy, which they load into instead of the document.
  let graph = sourceGraph
  if (hasPendingReaderPages(sourceGraph)) {
    graph = cloneSceneGraphForFigExport(sourceGraph)
    populateReaderExport(sourceGraph, graph)
  }
  const setup = await prepareFigExport(graph, runtime)
  const { compiled, schemaDeflated } = exportSchema(graph)
  const { canvasEntries, internalCanvasGuid, localIdCounter, blobs } = setup
  const nodeChanges: KiwiNodeChange[] = [setup.documentNc]
  for (const entry of canvasEntries) nodeChanges.push(entry.canvasNc)

  appendInternalResources({ ...setup, nodeChanges })

  const orderedCanvasEntries = [
    ...canvasEntries.filter((entry) => entry.page.internalOnly),
    ...canvasEntries.filter((entry) => !entry.page.internalOnly)
  ]
  const slotContentRecords: KiwiNodeChange[] = []
  const recordOptions = { ...figExportRecordOptions(setup), slotContentRecords }
  for (const { page, canvasGuid } of orderedCanvasEntries) {
    const children = graph
      .getChildren(page.id)
      .filter((child) => !child.internalOnly && child.sharedStyleType === null)
    const base = countCanvasChildren(nodeChanges, canvasGuid)
    for (let i = 0; i < children.length; i++) {
      nodeChanges.push(
        ...sceneNodeToKiwi(
          children[i],
          canvasGuid,
          base + i,
          localIdCounter,
          graph,
          blobs,
          recordOptions
        )
      )
    }
  }
  if (internalCanvasGuid) {
    const first = countCanvasChildren(nodeChanges, internalCanvasGuid)
    placeSlotContent(slotContentRecords, internalCanvasGuid, first, fractionalPosition)
    nodeChanges.push(...slotContentRecords)
  }

  const msg: Record<string, unknown> = {
    type: 'NODE_CHANGES',
    sessionID: 0,
    ackID: 0,
    nodeChanges
  }

  if (blobs.length > 0) {
    msg.blobs = blobs.map((bytes) => ({ bytes }))
  }

  const imageNames = nameImagesForFigma(nodeChanges, graph.images)
  const kiwiData = compiled.encodeMessage(msg)
  const extras = await figFileExtras(
    graph,
    imageNames,
    pageId,
    ck,
    renderer,
    renderHeadlessThumbnail
  )

  const version = graph.figKiwiVersion ?? undefined

  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core')
    return new Uint8Array(
      await invoke<ArrayBuffer>('build_fig_file', {
        schemaDeflated: Array.from(schemaDeflated),
        kiwiData: Array.from(kiwiData),
        thumbnailPng: Array.from(extras.thumbnailPNG),
        metaJson: extras.metaJSON,
        images: extras.images.map((e) => ({ name: e.name, data: Array.from(e.data) })),
        figKiwiVersion: version
      })
    )
  }

  return compressFigData(
    schemaDeflated,
    kiwiData,
    extras.thumbnailPNG,
    extras.metaJSON,
    extras.images,
    version
  )
}

export { compressFigDataSync } from '@open-pencil/fig'

function canUseWorker(): boolean {
  return typeof Worker !== 'undefined' && IS_BROWSER
}

/** Past this, cloning the encoded file into the compress worker runs out of memory. */
const MAX_COMPRESS_WORKER_BYTES = 8 * 1024 * 1024

function compressPayloadBytes(
  schemaDeflated: Uint8Array,
  kiwiData: Uint8Array,
  thumbnailPNG: Uint8Array,
  metaJSON: string,
  imageEntries: Array<{ name: string; data: Uint8Array }>
): number {
  let bytes =
    schemaDeflated.byteLength + kiwiData.byteLength + thumbnailPNG.byteLength + metaJSON.length
  for (const image of imageEntries) bytes += image.data.byteLength
  return bytes
}

function ownedBuffer(bytes: Uint8Array, transfer: ArrayBuffer[]): Uint8Array {
  if (bytes.byteLength === 0) return bytes
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  transfer.push(copy.buffer)
  return copy
}

function compressViaWorker(
  schemaDeflated: Uint8Array,
  kiwiData: Uint8Array,
  thumbnailPNG: Uint8Array,
  metaJSON: string,
  imageEntries: Array<{ name: string; data: Uint8Array }>,
  figKiwiVersion?: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export-worker.ts', import.meta.url), {
      type: 'module'
    })

    worker.onmessage = (e: MessageEvent<Uint8Array>) => {
      resolve(e.data)
      worker.terminate()
    }
    worker.onerror = (err) => {
      reject(new Error(err.message))
      worker.terminate()
    }

    // Copy first. ByteBuffer views share a backing store, and transferring that store would
    // detach every other view. The copies are transferred so the worker does not clone them.
    const transfer: ArrayBuffer[] = []
    const images = imageEntries.map((image) => ({
      name: image.name,
      data: ownedBuffer(image.data, transfer)
    }))
    worker.postMessage(
      {
        schemaDeflated: ownedBuffer(schemaDeflated, transfer),
        kiwiData: ownedBuffer(kiwiData, transfer),
        thumbnailPNG: ownedBuffer(thumbnailPNG, transfer),
        metaJSON,
        images,
        figKiwiVersion
      },
      transfer
    )
  })
}

export function compressFigData(
  schemaDeflated: Uint8Array,
  kiwiData: Uint8Array,
  thumbnailPNG: Uint8Array,
  metaJSON: string,
  imageEntries: Array<{ name: string; data: Uint8Array }>,
  figKiwiVersion?: number
): Promise<Uint8Array> {
  if (
    canUseWorker() &&
    compressPayloadBytes(schemaDeflated, kiwiData, thumbnailPNG, metaJSON, imageEntries) <=
      MAX_COMPRESS_WORKER_BYTES
  ) {
    return compressViaWorker(
      schemaDeflated,
      kiwiData,
      thumbnailPNG,
      metaJSON,
      imageEntries,
      figKiwiVersion
    ).catch((error: unknown) => {
      if (!isPortCloneFailure(error)) throw error
      return compressFigDataSync(
        schemaDeflated,
        kiwiData,
        thumbnailPNG,
        metaJSON,
        imageEntries,
        figKiwiVersion
      )
    })
  }
  return Promise.resolve(
    compressFigDataSync(
      schemaDeflated,
      kiwiData,
      thumbnailPNG,
      metaJSON,
      imageEntries,
      figKiwiVersion
    )
  )
}
