import { isEqual } from 'es-toolkit/predicate'

import {
  ensureInstanceOverrideState,
  serializeInstanceOverrideState,
  type Fill,
  type FillType,
  type GeometryPath,
  type SceneNode,
  type SourceMetadata
} from '@open-pencil/scene-graph'
import { copyFills } from '@open-pencil/scene-graph/copy'
import { createDefaultSourceMetadata } from '@open-pencil/scene-graph/node-defaults'
import type { Matrix, Vector } from '@open-pencil/scene-graph/primitives'

import { ORDER_KEY_FIELD, PAGE_FIELD, PARENTS_FIELD } from '@/app/collab/shared-tree/fields'

const DERIVED_NODE_FIELDS = new Set<keyof SceneNode>(['textPicture'])
/**
 * Outlines the local graph already owns. `commandsBlob` is the baked path; peers edit
 * `vectorNetwork`, fills, size, and text. Copying the blobs into the room is what freezes a
 * file the size of aska-app.
 */
const LAYER_GEOMETRY_FIELDS = new Set<string>([
  'fillGeometry',
  'strokeGeometry',
  'derivedTextGlyphs'
])
/** Figma payload keys whose values are geometry blobs, or indexes that were inlined as blobs. */
const FIG_BLOB_FIELD_KEYS = new Set([
  'vectorData',
  'fillGeometry',
  'strokeGeometry',
  'commandsBlob',
  'vectorNetworkBlob',
  'derivedTextGlyphs'
])
/**
 * The layer tree syncs as parent entries, order keys and pages (`src/app/collab/shared-tree/fields.ts`), so a
 * layer's own fields leave out its place in the tree, and decoding skips the tree's fields.
 */
const TREE_FIELDS = new Set<string>([
  'parentId',
  'childIds',
  PARENTS_FIELD,
  ORDER_KEY_FIELD,
  PAGE_FIELD
])
const FILL_TYPES = new Set<FillType>([
  'SOLID',
  'GRADIENT_LINEAR',
  'GRADIENT_RADIAL',
  'GRADIENT_ANGULAR',
  'GRADIENT_DIAMOND',
  'IMAGE',
  'VIDEO',
  'PATTERN',
  'NOISE',
  'CUSTOM'
])

type YjsNodeLike = {
  entries(): IterableIterator<[string, unknown]>
}

export interface EncodeNodeOptions {
  /**
   * Kept for callers that share a file the canvas already painted. Geometry blobs are omitted
   * for every encode; this flag only skips a single oversized editable field.
   */
  omitLocalGeometry?: boolean
  /** Skip one field larger than this instead of cloning it into the room. */
  maxFieldBytes?: number
}

function isTreeOrDerivedField(key: string): boolean {
  return DERIVED_NODE_FIELDS.has(key as keyof SceneNode) || TREE_FIELDS.has(key)
}

function isFigmaBlob(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, '__openPencilFigmaBlob')
}

function skipCollabField(key: string, value: unknown, options?: EncodeNodeOptions): boolean {
  if (isTreeOrDerivedField(key) || LAYER_GEOMETRY_FIELDS.has(key)) return true
  if (key === 'source') return false
  return (
    options?.maxFieldBytes !== undefined && slimValueBytes(value) > options.maxFieldBytes
  )
}

/**
 * Copies a Figma payload without its geometry blobs and without cloning the source object.
 * Blob keys and `{ __openPencilFigmaBlob }` values are dropped. Uint8Array bytes are not read.
 */
function copyWithoutFigBlobs(
  value: unknown,
  seen?: WeakSet<object>,
  budget?: { left: number }
): unknown {
  if (budget && budget.left <= 0) return undefined
  if (value instanceof Uint8Array || isFigmaBlob(value)) return undefined
  if (typeof value !== 'object' || value === null) return value
  const objects = seen ?? new WeakSet<object>()
  if (objects.has(value)) return undefined
  objects.add(value)
  if (Array.isArray(value)) {
    // A long list of numbers inside a Figma payload is baked geometry. Omit that list and keep
    // the editable fields beside it. Do not spend the whole budget, or a later stroke weight
    // would be dropped too.
    if (
      value.length > 256 &&
      value.every((item) => typeof item === 'number')
    ) {
      return undefined
    }
    const copy: unknown[] = []
    for (const item of value) {
      const next = copyWithoutFigBlobs(item, objects, budget)
      if (next !== undefined) copy.push(next)
      if (budget) {
        budget.left -= 8
        if (budget.left <= 0) break
      }
    }
    return copy
  }
  if (value instanceof Map || value instanceof Set) return undefined
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (FIG_BLOB_FIELD_KEYS.has(key)) continue
    const next = copyWithoutFigBlobs(child, objects, budget)
    if (next !== undefined) copy[key] = next
    if (budget) {
      budget.left -= key.length
      if (budget.left <= 0) break
    }
  }
  return copy
}

function arrayWithoutFigBlobs(value: unknown, budget?: { left: number }): unknown[] {
  const copied = copyWithoutFigBlobs(Array.isArray(value) ? value : [], undefined, budget)
  return Array.isArray(copied) ? copied : []
}

/**
 * A copy of an editable field. Fig geometry never goes through `structuredClone`: byte blobs,
 * `{ __openPencilFigmaBlob }` wrappers, and blob keys are dropped without reading their bytes.
 * Plain values — text, fills, size, `vectorNetwork` — are copied.
 */
function cloneEditable(value: unknown, seen?: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Uint8Array || isFigmaBlob(value)) return undefined
  if (value instanceof Date) return new Date(value.getTime())
  const objects = seen ?? new WeakSet<object>()
  if (objects.has(value)) return undefined
  objects.add(value)
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    for (const item of value) {
      const next = cloneEditable(item, objects)
      if (next !== undefined) copy.push(next)
    }
    return copy
  }
  if (value instanceof Map || value instanceof Set) return undefined
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (FIG_BLOB_FIELD_KEYS.has(key)) continue
    const next = cloneEditable(child, objects)
    if (next !== undefined) copy[key] = next
  }
  return copy
}

function encodeSourceForYjs(source: unknown, options?: EncodeNodeOptions): SourceMetadata {
  const budget =
    options?.maxFieldBytes !== undefined ? { left: options.maxFieldBytes } : undefined
  return normalizeSourceMetadata(source, budget)
}

/** Bytes a slim field adds. Geometry blobs and inlined Figma blobs count as nothing. */
function slimValueBytes(value: unknown, seen?: WeakSet<object>): number {
  if (value == null) return 1
  const kind = typeof value
  if (kind === 'string') return (value as string).length
  if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return 8
  if (kind !== 'object') return 8
  if (value instanceof Uint8Array || isFigmaBlob(value)) return 0
  const objects = seen ?? new WeakSet<object>()
  if (objects.has(value)) return 0
  objects.add(value)
  if (value instanceof Map) {
    let total = 8
    for (const [key, entry] of value) {
      total += slimValueBytes(key, objects) + slimValueBytes(entry, objects)
    }
    return total
  }
  if (value instanceof Set) {
    let total = 8
    for (const entry of value) total += slimValueBytes(entry, objects)
    return total
  }
  if (Array.isArray(value)) {
    if (value.length > 256) return value.length * 8
    let total = 8
    for (const entry of value) total += slimValueBytes(entry, objects)
    return total
  }
  let total = 8
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FIG_BLOB_FIELD_KEYS.has(key)) continue
    total += key.length + slimValueBytes(child, objects)
  }
  return total
}

/** Size of the fields a share would write for `node`, matching `encodeNodeForYjs`. */
export function collabNodeShareBytes(node: SceneNode, options?: EncodeNodeOptions): number {
  const seen = new WeakSet<object>()
  let total = 0
  for (const [key, value] of Object.entries(node)) {
    if (skipCollabField(key, value, options)) continue
    total += slimValueBytes(value, seen)
  }
  return Math.max(total, 1)
}

export function encodeNodeForYjs(
  node: SceneNode,
  options?: EncodeNodeOptions
): Record<string, unknown> {
  const encoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (skipCollabField(key, value, options)) continue
    // Yjs stores objects by enumerable keys. A Map has none, so override maps would come
    // back as empty objects. The entry form round-trips through that encoding.
    if (key === 'source') {
      encoded.source = encodeSourceForYjs(value, options)
      continue
    }
    const editable =
      key === 'instanceOverrides'
        ? serializeInstanceOverrideState(ensureInstanceOverrideState(value))
        : value
    const copied = cloneEditable(editable)
    if (copied !== undefined) encoded[key] = copied
  }
  return encoded
}

export function syncEncodedNodeToYMap(
  node: SceneNode,
  ynode: {
    delete(key: string): void
    get(key: string): unknown
    has(key: string): boolean
    set(key: string, value: unknown): void
  },
  options?: EncodeNodeOptions
): void {
  for (const key of DERIVED_NODE_FIELDS) {
    if (ynode.has(key)) ynode.delete(key)
  }
  for (const key of LAYER_GEOMETRY_FIELDS) {
    if (ynode.has(key)) ynode.delete(key)
  }
  for (const [key, value] of Object.entries(encodeNodeForYjs(node, options))) {
    if (!isEqual(ynode.get(key), value)) ynode.set(key, value)
  }
}

export function decodeNodeFromYjs(ynode: YjsNodeLike): Partial<SceneNode> {
  const props: Record<string, unknown> = {}
  for (const [key, value] of ynode.entries()) {
    if (DERIVED_NODE_FIELDS.has(key as keyof SceneNode) || TREE_FIELDS.has(key)) continue
    props[key] = structuredClone(value)
  }

  props.source = normalizeSourceMetadata(props.source)
  if ('fillGeometry' in props) props.fillGeometry = normalizeGeometryPaths(props.fillGeometry)
  if ('strokeGeometry' in props) props.strokeGeometry = normalizeGeometryPaths(props.strokeGeometry)
  if ('instanceOverrides' in props) {
    props.instanceOverrides = ensureInstanceOverrideState(props.instanceOverrides)
  }
  props.textPicture = null
  return props as Partial<SceneNode>
}

/**
 * Older rooms stored override maps as empty objects: Yjs keeps only enumerable keys, and a Map
 * has none. That shape is not an authored clear (those are entry lists) and must not wipe
 * overrides a file just loaded.
 */
export function isLegacyEmptyOverrideRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isEmptyRecord(value.self) && isEmptyRecord(value.descendants)
}

export function normalizeSourceMetadata(
  source: unknown,
  budget?: { left: number }
): SourceMetadata {
  const defaults = createDefaultSourceMetadata()
  if (!isRecord(source)) return defaults

  const fig = isRecord(source.fig) ? source.fig : {}
  return {
    format: source.format === 'fig' ? 'fig' : null,
    id: stringOrNull(source.id),
    orderKey: stringOrNull(source.orderKey),
    editedFields: stringArray(source.editedFields),
    fig: {
      rawSize: normalizeVector(fig.rawSize),
      rawTransform: normalizeMatrix(fig.rawTransform),
      rawNodeFields: isRecord(fig.rawNodeFields)
        ? (copyWithoutFigBlobs(fig.rawNodeFields, undefined, budget) as Record<string, unknown>)
        : {},
      layout: isRecord(fig.layout)
        ? (copyWithoutFigBlobs(fig.layout, undefined, budget) as SourceMetadata['fig']['layout'])
        : null,
      symbolOverrides: arrayWithoutFigBlobs(fig.symbolOverrides, budget),
      componentPropAssignments: arrayWithoutFigBlobs(fig.componentPropAssignments, budget),
      derivedSymbolData: arrayWithoutFigBlobs(fig.derivedSymbolData, budget),
      derivedSymbolDataLayoutVersion: numberOrNull(fig.derivedSymbolDataLayoutVersion),
      uniformScaleFactor: numberOrNull(fig.uniformScaleFactor)
    }
  }
}

function normalizeGeometryPaths(value: unknown): GeometryPath[] {
  if (!Array.isArray(value)) return []
  const paths: GeometryPath[] = []
  for (const item of value) {
    if (!isRecord(item) || !(item.commandsBlob instanceof Uint8Array)) continue
    const path: GeometryPath = {
      windingRule: item.windingRule === 'EVENODD' ? 'EVENODD' : 'NONZERO',
      commandsBlob: new Uint8Array(item.commandsBlob)
    }
    const fills = normalizeFills(item.fills)
    if (fills.length > 0) path.fills = copyFills(fills)
    if (typeof item.fillStyleId === 'string') path.fillStyleId = item.fillStyleId
    paths.push(path)
  }
  return paths
}

function normalizeVector(value: unknown): Vector | null {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null
  return { x: value.x, y: value.y }
}

function normalizeMatrix(value: unknown): Matrix | null {
  if (!isRecord(value)) return null
  const entries = [value.m00, value.m01, value.m02, value.m10, value.m11, value.m12]
  if (!entries.every((item) => isFiniteNumber(item))) return null
  return {
    m00: value.m00 as number,
    m01: value.m01 as number,
    m02: value.m02 as number,
    m10: value.m10 as number,
    m11: value.m11 as number,
    m12: value.m12 as number
  }
}

function normalizeFills(value: unknown): Fill[] {
  return Array.isArray(value) ? value.filter(isFill) : []
}

function isFill(value: unknown): value is Fill {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    FILL_TYPES.has(value.type as FillType) &&
    isColor(value.color) &&
    isFiniteNumber(value.opacity) &&
    typeof value.visible === 'boolean' &&
    isOptionalGradientStops(value.gradientStops) &&
    isOptionalMatrix(value.gradientTransform) &&
    isOptionalMatrix(value.imageTransform) &&
    isOptionalVector(value.patternSpacing) &&
    isOptionalVector(value.noiseSize)
  )
}

function isOptionalGradientStops(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((stop) => isRecord(stop) && isFiniteNumber(stop.position) && isColor(stop.color)))
  )
}

function isOptionalMatrix(value: unknown): boolean {
  return value === undefined || normalizeMatrix(value) !== null
}

function isOptionalVector(value: unknown): boolean {
  return value === undefined || normalizeVector(value) !== null
}

function isColor(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.r) &&
    isFiniteNumber(value.g) &&
    isFiniteNumber(value.b) &&
    isFiniteNumber(value.a)
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && !(value instanceof Map) && Object.keys(value).length === 0
}
