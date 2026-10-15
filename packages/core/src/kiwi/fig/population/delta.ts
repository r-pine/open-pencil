import { isEqual } from 'es-toolkit/predicate'

import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import { yieldToMainThread } from '#core/editor/main-thread'

export interface FigPopulationDelta {
  created: Array<[string, SceneNode]>
  updated: Array<[string, Partial<SceneNode>]>
  deleted: string[]
  instanceIndex: Array<[string, string[]]>
  populatedRootIds: string[]
}

export interface FigMutationJournal {
  before: Map<string, Partial<SceneNode>>
  created: Set<string>
  deleted: Set<string>
  stop: () => void
}

export function installFigMutationJournal(graph: SceneGraph): FigMutationJournal {
  const existingAtStart = new Set(graph.nodes.keys())
  const before = new Map<string, Partial<SceneNode>>()
  const created = new Set<string>()
  const deleted = new Set<string>()
  const original = {
    createNode: graph.createNode.bind(graph),
    createNodeWithId: graph.createNodeWithId.bind(graph),
    updateNode: graph.updateNode.bind(graph),
    deleteNode: graph.deleteNode.bind(graph)
  }
  function touch(id: string | null | undefined, fields: Iterable<keyof SceneNode>): void {
    if (!id || created.has(id)) return
    const node = graph.getNode(id)
    if (!node) return
    const snapshot = before.get(id) ?? {}
    before.set(id, snapshot)
    for (const field of fields) {
      if (!(field in snapshot)) Object.assign(snapshot, { [field]: structuredClone(node[field]) })
    }
  }
  graph.createNode = ((type, parentId, overrides) => {
    touch(parentId, ['childIds'])
    const node = original.createNode(type, parentId, overrides)
    created.add(node.id)
    return node
  }) as SceneGraph['createNode']
  graph.createNodeWithId = ((id, type, parentId, overrides) => {
    touch(parentId, ['childIds'])
    const node = original.createNodeWithId(id, type, parentId, overrides)
    created.add(node.id)
    return node
  }) as SceneGraph['createNodeWithId']
  graph.updateNode = ((id, changes) => {
    const node = graph.getNode(id)
    if (node) {
      const fields = (Object.keys(changes) as (keyof SceneNode)[]).filter(
        (field) => !isEqual(node[field], changes[field])
      )
      if (fields.length > 0) fields.push('source')
      if ('componentId' in changes) fields.push('componentId')
      if ('fills' in changes || 'strokes' in changes) fields.push('boundVariables')
      touch(id, fields)
    }
    original.updateNode(id, changes)
  }) as SceneGraph['updateNode']
  graph.deleteNode = ((id) => {
    const node = graph.getNode(id)
    touch(node?.parentId, ['childIds'])
    const pending = node ? [id] : []
    while (pending.length > 0) {
      const currentId = pending.pop()
      if (!currentId) continue
      const current = graph.getNode(currentId)
      if (current) pending.push(...current.childIds)
      if (!existingAtStart.has(currentId)) {
        created.delete(currentId)
        before.delete(currentId)
      } else deleted.add(currentId)
    }
    original.deleteNode(id)
  }) as SceneGraph['deleteNode']
  return {
    before,
    created,
    deleted,
    stop() {
      graph.createNode = original.createNode
      graph.createNodeWithId = original.createNodeWithId
      graph.updateNode = original.updateNode
      graph.deleteNode = original.deleteNode
    }
  }
}

export function buildFigPopulationDelta(
  graph: SceneGraph,
  journal: FigMutationJournal,
  populatedRootIds: Iterable<string>
): FigPopulationDelta {
  const updated: Array<[string, Partial<SceneNode>]> = []
  for (const [id, previous] of journal.before) {
    const current = graph.getNode(id)
    if (!current || journal.deleted.has(id)) continue
    const changes: Partial<SceneNode> = {}
    for (const key of Object.keys(previous) as (keyof SceneNode)[]) {
      if (!isEqual(previous[key], current[key]))
        Object.assign(changes, { [key]: structuredClone(current[key]) })
    }
    if (Object.keys(changes).length > 0) updated.push([id, changes])
  }
  const created = [...journal.created]
    .map((id) => graph.getNode(id))
    .filter((node) => node !== undefined)
    .map((node) => [node.id, structuredClone(node)] as [string, SceneNode])
  return {
    created,
    updated,
    deleted: [...journal.deleted],
    instanceIndex: [...graph.instanceIndex].map(([id, ids]) => [id, [...ids]]),
    populatedRootIds: [...populatedRootIds]
  }
}

/** Creates applied in one turn. More than this, and the tab cannot take a click until the page lands. */
const POPULATION_SLICE_NODES = 40

export function applyFigPopulationDelta(graph: SceneGraph, delta: FigPopulationDelta): void {
  graph.applyImportedStateDuring(() => {
    applyPopulationSlice(graph, delta, 0, delta.created.length, 0, delta.updated.length, 0, delta.deleted.length)
  })
}

/**
 * Applies a page in short turns. `createNode` already indexes instances, so this does not walk
 * the rest of the file to rebuild `instanceIndex` — that walk is the whole document after the
 * second page of a 100k-layer file has loaded.
 */
export async function applyFigPopulationDeltaCooperatively(
  graph: SceneGraph,
  delta: FigPopulationDelta
): Promise<void> {
  await applyPhase(graph, delta.created.length, (from, to) => {
    applyPopulationSlice(graph, delta, from, to, 0, 0, 0, 0)
  })
  await applyPhase(graph, delta.updated.length, (from, to) => {
    applyPopulationSlice(graph, delta, 0, 0, from, to, 0, 0)
  })
  await applyPhase(graph, delta.deleted.length, (from, to) => {
    applyPopulationSlice(graph, delta, 0, 0, 0, 0, from, to)
  })
}

async function applyPhase(
  graph: SceneGraph,
  total: number,
  apply: (from: number, to: number) => void
): Promise<void> {
  for (let from = 0; from < total; from += POPULATION_SLICE_NODES) {
    const to = Math.min(total, from + POPULATION_SLICE_NODES)
    graph.applyImportedStateDuring(() => apply(from, to))
    if (to < total) await yieldToMainThread()
  }
}

function applyPopulationSlice(
  graph: SceneGraph,
  delta: FigPopulationDelta,
  createdFrom: number,
  createdTo: number,
  updatedFrom: number,
  updatedTo: number,
  deletedFrom: number,
  deletedTo: number
): void {
  for (let index = createdFrom; index < createdTo; index++) {
    const node = delta.created[index]?.[1]
    if (node) graph.createNodeWithId(node.id, node.type, node.parentId, node)
  }
  for (let index = updatedFrom; index < updatedTo; index++) {
    const change = delta.updated[index]
    if (change) graph.updateNode(change[0], change[1])
  }
  for (let index = deletedFrom; index < deletedTo; index++) {
    const id = delta.deleted[index]
    if (id) graph.deleteNode(id)
  }
  // Instances copied onto the graph without `createNode` are not in the index yet. Touching
  // them in this delta is what a later sync looks up. This does not walk the rest of the file.
  for (let index = createdFrom; index < createdTo; index++) {
    rememberInstance(graph, graph.getNode(delta.created[index]?.[1].id ?? ''))
  }
  for (let index = updatedFrom; index < updatedTo; index++) {
    const id = delta.updated[index]?.[0]
    if (id) rememberInstance(graph, graph.getNode(id))
  }
}

function rememberInstance(graph: SceneGraph, node: SceneNode | undefined): void {
  if (node?.type !== 'INSTANCE' || !node.componentId) return
  const ids = graph.instanceIndex.get(node.componentId) ?? new Set<string>()
  ids.add(node.id)
  graph.instanceIndex.set(node.componentId, ids)
}

export function populationDeltaNeedsCooperativeApply(delta: FigPopulationDelta): boolean {
  return (
    delta.created.length + delta.updated.length + delta.deleted.length > POPULATION_SLICE_NODES
  )
}
