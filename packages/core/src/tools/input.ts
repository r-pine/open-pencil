import * as v from 'valibot'

export const nodeIdInput = v.pipe(v.string(), v.description('Node ID'))

/**
 * Keys models send for a node's id besides the documented `id`.
 * Figma-style calls use `nodeId` / `node_id`; some emit `ID`.
 */
const NODE_ID_ALIAS_KEYS = ['nodeId', 'node_id', 'nodeID', 'ID', 'Id'] as const

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Copy a node id from an alias onto `id` and drop the alias.
 * A call that already has a non-blank `id` keeps it. An object with no id at all is unchanged,
 * so validation still fails instead of guessing a node.
 */
export function coerceNodeIdArgs(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = { ...(value as Record<string, unknown>) }
  if (!nonBlankString(record.id)) {
    for (const key of NODE_ID_ALIAS_KEYS) {
      const candidate = nonBlankString(record[key])
      if (candidate !== undefined) {
        record.id = candidate
        break
      }
    }
  }
  if (nonBlankString(record.id)) {
    for (const key of NODE_ID_ALIAS_KEYS) delete record[key]
  }
  return record
}

export function toolInputExpectsId(schema: { entries?: object }): boolean {
  return schema.entries !== undefined && 'id' in schema.entries
}
export const nodeInput = v.strictObject({ id: nodeIdInput })
export const nodeComparisonInput = v.strictObject({
  from: v.pipe(v.string(), v.description('Source node ID')),
  to: v.pipe(v.string(), v.description('Target node ID'))
})

export function nodeTraversalInput(depthDescription: string) {
  return v.strictObject({
    id: nodeIdInput,
    depth: v.optional(toolNumber(v.pipe(v.number(), v.description(depthDescription))))
  })
}
export const positionInputs = {
  x: toolNumber(v.pipe(v.number(), v.description('X position in the parent, or on the page'))),
  y: toolNumber(v.pipe(v.number(), v.description('Y position in the parent, or on the page')))
}

/** Reuse a native number schema for both numeric and numeric-string agent inputs. */
export function toolNumber(schema: v.GenericSchema<number, number> = v.number()) {
  // JSON Schema numbers are finite. Express that with representable bounds as well as at runtime.
  const finite = v.pipe(schema, v.minValue(-Number.MAX_VALUE), v.maxValue(Number.MAX_VALUE))
  return v.union([
    finite,
    v.pipe(
      v.string(),
      v.regex(/\S/, 'Expected a nonblank numeric string'),
      v.description(v.getDescription(schema) ?? 'Numeric value'),
      v.transform(Number),
      finite
    )
  ])
}
