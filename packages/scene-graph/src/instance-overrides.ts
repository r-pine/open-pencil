export type InstanceOverrideField = string

export interface InstanceOverrideState {
  self: Map<InstanceOverrideField, unknown>
  descendants: Map<string, Map<InstanceOverrideField, unknown>>
}

export function createInstanceOverrideState(): InstanceOverrideState {
  return { self: new Map(), descendants: new Map() }
}

export interface SerializedOverrideValue {
  defined: boolean
  value?: unknown
}

export interface SerializedInstanceOverrideState {
  self: Array<[InstanceOverrideField, SerializedOverrideValue]>
  descendants: Array<[string, Array<[InstanceOverrideField, SerializedOverrideValue]>]>
}

function serializeOverrideValue(value: unknown): SerializedOverrideValue {
  return value === undefined ? { defined: false } : { defined: true, value }
}

function deserializeOverrideValue(value: unknown): { valid: boolean; value: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, value: undefined }
  }
  if (!('defined' in value) || typeof value.defined !== 'boolean') {
    return { valid: false, value: undefined }
  }
  if (value.defined) {
    return 'value' in value
      ? { valid: true, value: value['value'] }
      : { valid: false, value: undefined }
  }
  return { valid: true, value: undefined }
}

function deserializeEntries(value: unknown): Map<InstanceOverrideField, unknown> {
  const result = new Map<InstanceOverrideField, unknown>()
  if (!Array.isArray(value)) return result
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
    const decoded = deserializeOverrideValue(entry[1])
    if (decoded.valid) result.set(entry[0], decoded.value)
  }
  return result
}

export function serializeInstanceOverrideState(
  state: InstanceOverrideState
): SerializedInstanceOverrideState {
  return {
    self: [...state.self].map(([field, value]) => [field, serializeOverrideValue(value)]),
    descendants: [...state.descendants].map(([nodeId, fields]) => [
      nodeId,
      [...fields].map(([field, value]) => [field, serializeOverrideValue(value)])
    ])
  }
}

export function deserializeInstanceOverrideState(state: unknown): InstanceOverrideState {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return createInstanceOverrideState()
  }
  const self =
    'self' in state ? deserializeEntries(state.self) : new Map<InstanceOverrideField, unknown>()
  const descendants = new Map<string, Map<InstanceOverrideField, unknown>>()
  if ('descendants' in state && Array.isArray(state.descendants)) {
    for (const entry of state.descendants) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
      descendants.set(entry[0], deserializeEntries(entry[1]))
    }
  }
  return { self, descendants }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map)
  )
}

/** A field map stored as a Map, as serialized entries, or as a plain object. */
function coerceFieldMap(value: unknown): Map<InstanceOverrideField, unknown> {
  if (value instanceof Map) {
    const fields = new Map<InstanceOverrideField, unknown>()
    for (const [field, entry] of value) {
      if (typeof field === 'string') fields.set(field, entry)
    }
    return fields
  }
  if (Array.isArray(value)) return deserializeEntries(value)
  if (isPlainRecord(value)) return new Map(Object.entries(value))
  return new Map()
}

function coerceDescendants(value: unknown): Map<string, Map<InstanceOverrideField, unknown>> {
  const descendants = new Map<string, Map<InstanceOverrideField, unknown>>()
  if (value instanceof Map) {
    for (const [id, fields] of value) {
      if (typeof id !== 'string') continue
      descendants.set(id, coerceFieldMap(fields))
    }
    return descendants
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
      descendants.set(entry[0], coerceFieldMap(entry[1]))
    }
    return descendants
  }
  if (isPlainRecord(value)) {
    for (const [id, fields] of Object.entries(value)) descendants.set(id, coerceFieldMap(fields))
  }
  return descendants
}

function isReadyInstanceOverrideState(state: unknown): state is InstanceOverrideState {
  if (
    !isPlainRecord(state) ||
    !(state.self instanceof Map) ||
    !(state.descendants instanceof Map)
  ) {
    return false
  }
  for (const fields of state.descendants.values()) {
    if (!(fields instanceof Map)) return false
  }
  return true
}

/**
 * Runtime override maps, the JSON entry form, or plain objects left behind when a Map was
 * copied through a channel that only keeps enumerable fields. Already-valid state is returned
 * unchanged.
 */
export function ensureInstanceOverrideState(state: unknown): InstanceOverrideState {
  if (isReadyInstanceOverrideState(state)) return state
  if (!isPlainRecord(state)) return createInstanceOverrideState()
  const self = 'self' in state ? state.self : undefined
  const descendants = 'descendants' in state ? state.descendants : undefined
  if (Array.isArray(self) || Array.isArray(descendants))
    return deserializeInstanceOverrideState(state)
  return { self: coerceFieldMap(self), descendants: coerceDescendants(descendants) }
}

/** Replace a node's override state when it is not already maps. */
export function normalizeNodeInstanceOverrides(node: {
  instanceOverrides: InstanceOverrideState
}): InstanceOverrideState {
  const ready = ensureInstanceOverrideState(node.instanceOverrides)
  if (ready !== node.instanceOverrides) node.instanceOverrides = ready
  return ready
}

export function cloneInstanceOverrideState(state: InstanceOverrideState): InstanceOverrideState {
  return {
    self: new Map([...state.self].map(([field, value]) => [field, structuredClone(value)])),
    descendants: new Map(
      [...state.descendants].map(([id, fields]) => [
        id,
        new Map([...fields].map(([field, value]) => [field, structuredClone(value)]))
      ])
    )
  }
}

export interface InstanceOverrideReferenceMapper {
  node: (id: string) => string
  variable: (id: string) => string
}

/** Remap runtime identities only; ordinary strings and source-format payloads stay opaque. */
export function remapInstanceOverrideState(
  state: InstanceOverrideState,
  references: InstanceOverrideReferenceMapper
): InstanceOverrideState {
  const remapValue = (field: string, value: unknown): unknown => {
    if (typeof value !== 'string') return structuredClone(value)
    if (field === 'componentId' || field === 'sourceComponentId') return references.node(value)
    if (field.startsWith('boundVariables/')) return references.variable(value)
    return value
  }
  const fields = (entries: ReadonlyMap<string, unknown>) =>
    new Map([...entries].map(([field, value]) => [field, remapValue(field, value)]))
  const descendants = new Map<string, Map<string, unknown>>()
  for (const [id, entries] of state.descendants) {
    const mapped = references.node(id)
    if (descendants.has(mapped)) throw new Error(`Duplicate remapped override target ${mapped}`)
    descendants.set(mapped, fields(entries))
  }
  return { self: fields(state.self), descendants }
}

export function getInstanceOverride(
  state: InstanceOverrideState,
  instanceId: string,
  nodeId: string,
  field: InstanceOverrideField
): unknown {
  return nodeId === instanceId ? state.self.get(field) : state.descendants.get(nodeId)?.get(field)
}

export function hasInstanceOverride(
  state: InstanceOverrideState,
  instanceId: string,
  nodeId: string,
  field: InstanceOverrideField
): boolean {
  const fields = nodeId === instanceId ? state.self : state.descendants.get(nodeId)
  return fields?.has(field) ?? false
}

export function setInstanceOverride(
  state: InstanceOverrideState,
  instanceId: string,
  nodeId: string,
  field: InstanceOverrideField,
  value: unknown = true
): void {
  if (nodeId === instanceId) {
    state.self.set(field, value)
    return
  }
  const fields = state.descendants.get(nodeId) ?? new Map<string, unknown>()
  fields.set(field, value)
  state.descendants.set(nodeId, fields)
}

export function deleteInstanceOverride(
  state: InstanceOverrideState,
  instanceId: string,
  nodeId: string,
  field: InstanceOverrideField
): boolean {
  const fields = nodeId === instanceId ? state.self : state.descendants.get(nodeId)
  if (!fields?.delete(field)) return false
  if (nodeId !== instanceId && fields.size === 0) state.descendants.delete(nodeId)
  return true
}

export function clearInstanceOverrides(state: InstanceOverrideState): void {
  state.self.clear()
  state.descendants.clear()
}

export function forEachInstanceOverride(
  state: InstanceOverrideState,
  callback: (nodeId: string, field: InstanceOverrideField, value: unknown) => void
): void {
  for (const [field, value] of state.self) callback('', field, value)
  for (const [nodeId, fields] of state.descendants) {
    for (const [field, value] of fields) callback(nodeId, field, value)
  }
}
