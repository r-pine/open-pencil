import {
  collectSceneMutation,
  mutationLayoutScopeIds,
  type SceneGraph,
  type SceneMutationImpact
} from '@open-pencil/scene-graph'

import { yieldToMainThread } from '#core/editor/main-thread'
import {
  computeAllLayouts,
  computeAllLayoutsCooperatively,
  COOPERATIVE_LAYOUT_THRESHOLD,
  subtreeExceeds,
  computeLayout
} from '#core/layout'

const layoutGeneration = new WeakMap<SceneGraph, number>()

export function createLayoutRunner(getGraph: () => SceneGraph) {
  function layoutAncestors(graph: SceneGraph, id: string) {
    const node = graph.getNode(id)
    if (!node) return
    let parent = node.parentId ? graph.getNode(node.parentId) : undefined
    while (parent) {
      if (parent.layoutMode !== 'NONE') computeLayout(graph, parent.id)
      parent = parent.parentId ? graph.getNode(parent.parentId) : undefined
    }
  }

  function layoutNodeNow(graph: SceneGraph, id: string) {
    computeAllLayouts(graph, id)
    layoutAncestors(graph, id)
  }

  /**
   * A large subtree is laid out after this turn. The walk used to run inside the edit, so the
   * tab could not pan until every frame on the page had been through Yoga.
   */
  async function layoutNodeAcrossTurns(graph: SceneGraph, id: string, generation: number) {
    await yieldToMainThread()
    const current = () =>
      getGraph() === graph && layoutGeneration.get(graph) === generation && graph.getNode(id) !== undefined
    if (!current()) return
    const laidOut = await computeAllLayoutsCooperatively(graph, id, current)
    if (!laidOut || !current()) return
    layoutAncestors(graph, id)
  }

  function runLayoutForNode(id: string) {
    const graph = getGraph()
    const node = graph.getNode(id)
    if (!node) return
    const generation = (layoutGeneration.get(graph) ?? 0) + 1
    layoutGeneration.set(graph, generation)
    if (subtreeExceeds(graph, id, COOPERATIVE_LAYOUT_THRESHOLD)) {
      void layoutNodeAcrossTurns(graph, id, generation)
      return
    }
    layoutNodeNow(graph, id)
  }

  function compactLayoutScope(impact: SceneMutationImpact): string[] {
    const graph = getGraph()
    const candidates = new Set(mutationLayoutScopeIds(impact).filter((id) => graph.getNode(id)))
    return [...candidates].filter((id) => {
      let parentId = graph.getNode(id)?.parentId ?? null
      while (parentId) {
        if (candidates.has(parentId)) return false
        parentId = graph.getNode(parentId)?.parentId ?? null
      }
      return true
    })
  }

  async function runMutationWithLayout<T>(
    operation: () => T | Promise<T>,
    fallbackId?: string,
    beforeLayout?: (result: T) => Promise<void> | void
  ): Promise<T> {
    const graph = getGraph()
    const { result, impact } = await collectSceneMutation(graph, operation)
    await beforeLayout?.(result)
    if (!runLayoutForImpact(impact) && fallbackId) computeAllLayouts(graph, fallbackId)
    return result
  }

  /** Lays out what an edit touched; returns whether there was anything to lay out. */
  function runLayoutForImpact(impact: SceneMutationImpact): boolean {
    const scopeIds = compactLayoutScope(impact)
    for (const id of scopeIds) runLayoutForNode(id)
    return scopeIds.length > 0
  }

  return { runLayoutForNode, runLayoutForImpact, runMutationWithLayout }
}
