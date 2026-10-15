import { limitAsync } from 'es-toolkit/promise'

import { instanceMainComponent, type SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import type { Color } from '@open-pencil/scene-graph/primitives'

import {
  getPageColor,
  setDefaultPageBackground,
  setPageBackgrounds
} from '#core/figma-api/page-backgrounds'
import {
  canUseFigPopulationWorker,
  createFigPopulationWorker
} from '#core/kiwi/fig/population/client'
import { isReaderPagePending, recoverReaderPage } from '#core/kiwi/fig/session/document-state'
import { yieldToMainThread } from '#core/editor/main-thread'
import { computeAllLayouts, computeAllLayoutsCooperatively } from '#core/layout'
import { fontManager } from '#core/text/fonts'
import {
  collectGraphFontRequirements,
  collectGraphFontRequirementsCooperatively
} from '#core/text/requirements'
import { missingGraphFontScripts } from '#core/text/resolved-requirements'

import { createPageViewportStore } from './page-viewports'
import type { EditorContext } from './types'

export interface PageSwitchProgress {
  phase:
    | 'populating-page'
    | 'resolving-fonts'
    | 'resolving-fallbacks'
    | 'layout'
    | 'drawing-shaders'
  detail?: string
  completed?: number
  total?: number
}

export interface PreparePageOptions {
  onProgress?: (progress: PageSwitchProgress) => void
  signal?: AbortSignal
}

export interface PreparedPage {
  pageId: string
  generation: number
}

export type SwitchPageOptions = PreparePageOptions

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

const MAX_CONCURRENT_FONT_LOADS = 4
/** Above this, font scans and layout return to the event loop. Smaller pages stay synchronous. */
const COOPERATIVE_PAGE_NODES = 1_500

function pageExceeds(graph: SceneGraph, pageId: string, limit: number): boolean {
  let count = 0
  const stack = [pageId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (!id) continue
    const node = graph.getNode(id)
    if (!node) continue
    count++
    if (count > limit) return true
    for (const childId of node.childIds) stack.push(childId)
  }
  return false
}
/** What preparing a page needs drawn once it is laid out, such as its shaders' frames. */
interface PageDrawing {
  drawPageShaderFrames(
    pageId: string,
    options: { signal?: AbortSignal; onProgress?: (progress: PageSwitchProgress) => void }
  ): Promise<void>
}

/**
 * The other pages that hold the component sets instances on `pageId` show a variant of,
 * nested instances included. A set on Figma's internal canvas is a copy of a library's, kept
 * with only what the file uses, so its page is left out.
 */
export function componentSetPages(graph: SceneGraph, pageId: string): string[] {
  const pages = new Set<string>()
  const visit = (id: string): void => {
    for (const node of graph.getChildren(id)) {
      if (node.type === 'INSTANCE') {
        const component = instanceMainComponent(graph, node)
        const set = component?.parentId ? graph.getNode(component.parentId) : undefined
        const setPageId = set?.type === 'COMPONENT_SET' ? graph.pageOf(set.id) : null
        const setPage = setPageId ? graph.getNode(setPageId) : undefined
        if (setPage && setPage.id !== pageId && !setPage.internalOnly) pages.add(setPage.id)
      }
      visit(node.id)
    }
  }
  visit(pageId)
  return [...pages]
}

export function createPageActions(ctx: EditorContext, drawing?: PageDrawing) {
  const pageViewportStore = createPageViewportStore(ctx)
  function syncPageColor() {
    ctx.state.pageColor = getPageColor(ctx.graph.getNode(ctx.state.currentPageId))
  }
  syncPageColor()
  ctx.onEditorEvent('graph:replaced', syncPageColor)
  ctx.onEditorEvent('node:updated', (id, changes) => {
    if (id === ctx.state.currentPageId && changes.source) syncPageColor()
  })
  let populationWorkerInstance: ReturnType<typeof createFigPopulationWorker> | undefined
  let populationWorkerGeneration = 0
  let pageSwitchGeneration = 0
  // Off-screen preparations per document, shared by concurrent callers and kept once they
  // succeed. Later edits lay out their own scope, as they do on the page on screen.
  const offscreenPreparations = new WeakMap<SceneGraph, Map<string, Promise<boolean>>>()
  // The component-library pass queued by the latest page switch, before it starts. A second
  // switch replaces it so two switches do not each lay the library out from scratch.
  let referencedSetsTimer: ReturnType<typeof setTimeout> | undefined
  let referencedSetsFrame: number | undefined

  function populationWorker() {
    if (!canUseFigPopulationWorker(ctx.graph)) return null
    populationWorkerInstance ??= createFigPopulationWorker(ctx.graph)
    return populationWorkerInstance
  }

  /** `switchGeneration` is null for a lookup, which no page switch can supersede. */
  async function populatePage(
    pageId: string,
    switchGeneration: number | null,
    signal?: AbortSignal
  ): Promise<boolean | null> {
    throwIfAborted(signal)
    const worker = populationWorker()
    const workerGeneration = populationWorkerGeneration
    const workerResult = worker ? await worker.populate(pageId, signal) : null
    throwIfAborted(signal)
    if (
      workerGeneration !== populationWorkerGeneration ||
      (switchGeneration !== null && switchGeneration !== pageSwitchGeneration)
    ) {
      return null
    }
    if (workerResult !== null) return workerResult
    worker?.terminate()
    populationWorkerInstance = undefined
    if (isReaderPagePending(ctx.graph, pageId)) {
      return recoverReaderPage(ctx.graph, pageId)
    }
    return false
  }

  async function resolvePageFonts(
    pageId: string,
    pageName: string,
    options: PreparePageOptions,
    shouldContinue: () => boolean = () => true,
    cooperative = false
  ): Promise<boolean> {
    const childIds = ctx.graph.getChildren(pageId).map((node) => node.id)
    // Off-screen pages always scan cooperatively. `pageExceeds` itself stops early, but the
    // synchronous font walk that follows it is the whole component library in one turn.
    const large = cooperative || pageExceeds(ctx.graph, pageId, COOPERATIVE_PAGE_NODES)
    const requirements = large
      ? await collectGraphFontRequirementsCooperatively(ctx.graph, childIds, shouldContinue)
      : {
          ...collectGraphFontRequirements(ctx.graph, childIds),
          fontKeys: fontManager.collectFontKeys(ctx.graph, childIds)
        }
    if (!requirements || !shouldContinue()) return false
    const toLoad = requirements.fontKeys
    options.onProgress?.({
      phase: 'resolving-fonts',
      detail: pageName,
      completed: 0,
      total: toLoad.length
    })
    fontManager.blockNodesUntilFontsResolve(childIds)
    try {
      let completedFaces = 0
      const loadFace = limitAsync(async ([family, style]: [string, string]) => {
        throwIfAborted(options.signal)
        const result = await ctx.loadFont(family, style, requirements.characters, options.signal)
        throwIfAborted(options.signal)
        completedFaces++
        options.onProgress?.({
          phase: 'resolving-fonts',
          detail: `${family} ${style}`,
          completed: completedFaces,
          total: toLoad.length
        })
        return result
      }, MAX_CONCURRENT_FONT_LOADS)
      const results = await Promise.all(toLoad.map(loadFace))
      throwIfAborted(options.signal)
      const requiredFallbacks = missingGraphFontScripts(requirements)
      options.onProgress?.({
        phase: 'resolving-fallbacks',
        detail: pageName,
        completed: 0,
        total: requiredFallbacks.length
      })
      const fallbacks = await fontManager.ensureFallbackPack(
        requiredFallbacks,
        requirements.characters,
        options.signal
      )
      throwIfAborted(options.signal)
      options.onProgress?.({
        phase: 'resolving-fallbacks',
        detail: pageName,
        completed: requiredFallbacks.length,
        total: requiredFallbacks.length
      })
      const facesReady = results.every((result) => result !== null)
      const fallbacksReady = requiredFallbacks.every(
        (script) => (fallbacks[script]?.length ?? 0) > 0
      )
      if (facesReady && fallbacksReady) {
        for (let index = 0; index < requirements.nodes.length; index++) {
          const node = requirements.nodes[index]
          if (node?.type === 'TEXT') node.textPicture = null
          // A count bound, not only a clock: clearing every text picture on a library page
          // is one turn otherwise, and a stalled timestamp would never come back to input.
          if (large && index > 0 && index % 400 === 0) {
            if (!shouldContinue()) return false
            await yieldToMainThread()
            if (!shouldContinue()) return false
          }
        }
      }
      return shouldContinue()
    } finally {
      fontManager.unblockNodes(childIds)
      ctx.getRenderer()?.invalidateAllPictures()
    }
  }

  async function preparePage(
    pageId: string,
    options: PreparePageOptions = {}
  ): Promise<PreparedPage | null> {
    const page = ctx.graph.getNode(pageId)
    if (page?.type !== 'CANVAS') return null
    const generation = ++pageSwitchGeneration
    // Drop a component-library pass that has not started, so this switch can commit and take
    // clicks before that library is laid out. A pass already running yields between slices.
    cancelScheduledReferencedSets()
    throwIfAborted(options.signal)

    options.onProgress?.({ phase: 'populating-page', detail: page.name })
    const populated = await populatePage(pageId, generation, options.signal)
    if (populated === null || generation !== pageSwitchGeneration) return null
    // Variant sets live on other pages. Their layers have to be loaded before this page can
    // paint an instance, but laying out every set first freezes a large file: aska-app pulls
    // in its whole component library. Fonts and layout of those pages run after the first paint,
    // and the walk that finds them yields so a 100k-layer page cannot freeze the tab.
    const seen = new Set([pageId])
    const referencedSets: string[] = []
    const visibleIsLarge = pageExceeds(ctx.graph, pageId, COOPERATIVE_PAGE_NODES)
    const pending = visibleIsLarge
      ? await collectComponentSetPages(pageId, generation)
      : componentSetPages(ctx.graph, pageId)
    if (!pending) return null
    for (let setPageId = pending.shift(); setPageId !== undefined; setPageId = pending.shift()) {
      if (generation !== pageSwitchGeneration) return null
      if (seen.has(setPageId)) continue
      seen.add(setPageId)
      referencedSets.push(setPageId)
      const populatedSet = await populatePage(setPageId, generation, options.signal)
      throwIfAborted(options.signal)
      if (populatedSet === null || generation !== pageSwitchGeneration) return null
      const nested = pageExceeds(ctx.graph, setPageId, COOPERATIVE_PAGE_NODES)
        ? await collectComponentSetPages(setPageId, generation)
        : componentSetPages(ctx.graph, setPageId)
      if (!nested) return null
      pending.push(...nested)
    }

    const fontsReady = await resolvePageFonts(pageId, page.name, options, () => {
      return generation === pageSwitchGeneration
    })
    if (!fontsReady) return null
    throwIfAborted(options.signal)
    if (generation !== pageSwitchGeneration) return null
    if (ctx.getRenderer() || populated) {
      options.onProgress?.({ phase: 'layout', detail: page.name })
      if (visibleIsLarge) {
        const laidOut = await layoutPage(pageId, generation)
        if (!laidOut) return null
      } else {
        ctx.graph.applyDerivedLayoutDuring(() => computeAllLayouts(ctx.graph, pageId))
      }
    }
    throwIfAborted(options.signal)
    if (generation !== pageSwitchGeneration) return null
    // Frames are drawn at the size layout gives each layer.
    await drawing?.drawPageShaderFrames(pageId, options)
    throwIfAborted(options.signal)
    if (generation !== pageSwitchGeneration) return null
    scheduleReferencedSets(referencedSets, generation)
    return { pageId, generation }
  }

  /**
   * Pages holding component sets used by instances under `pageId`. Yields during the walk: a
   * component library is the whole file, and scanning it in one turn freezes the tab.
   */
  async function collectComponentSetPages(
    pageId: string,
    generation: number | null
  ): Promise<string[] | null> {
    const pages = new Set<string>()
    const stack = [...(ctx.graph.getNode(pageId)?.childIds ?? [])].reverse()
    let scanned = 0
    while (stack.length > 0) {
      if (generation !== null && generation !== pageSwitchGeneration) return null
      const id = stack.pop()
      if (!id) continue
      const node = ctx.graph.getNode(id)
      if (!node) continue
      scanned++
      if (node.type === 'INSTANCE') {
        const component = instanceMainComponent(ctx.graph, node)
        const set = component?.parentId ? ctx.graph.getNode(component.parentId) : undefined
        const setPageId = set?.type === 'COMPONENT_SET' ? ctx.graph.pageOf(set.id) : null
        const setPage = setPageId ? ctx.graph.getNode(setPageId) : undefined
        if (setPage && setPage.id !== pageId && !setPage.internalOnly) pages.add(setPage.id)
      }
      for (let index = node.childIds.length - 1; index >= 0; index--) {
        const childId = node.childIds[index]
        if (childId) stack.push(childId)
        if (node.childIds.length > 500 && index % 500 === 0) {
          if (generation !== null && generation !== pageSwitchGeneration) return null
          await yieldToMainThread()
        }
      }
      if (scanned % 500 === 0) await yieldToMainThread()
    }
    return [...pages]
  }

  async function layoutPage(pageId: string, generation: number | null): Promise<boolean> {
    return computeAllLayoutsCooperatively(
      ctx.graph,
      pageId,
      () => generation === null || generation === pageSwitchGeneration
    )
  }

  /**
   * Lays out component-set pages after the page on screen can paint. A newer page switch
   * abandons the walk. Each page's fonts and layout yield, so one library page cannot freeze
   * the tab.
   */
  function cancelScheduledReferencedSets() {
    if (referencedSetsTimer !== undefined) {
      clearTimeout(referencedSetsTimer)
      referencedSetsTimer = undefined
    }
    if (referencedSetsFrame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(referencedSetsFrame)
      referencedSetsFrame = undefined
    }
  }

  function scheduleReferencedSets(pageIds: readonly string[], generation: number) {
    if (pageIds.length === 0) return
    // Replace a pass that has not started. Two page switches would otherwise each run the
    // component library as its own long task, and the second click never reaches the page.
    cancelScheduledReferencedSets()
    const run = () => {
      referencedSetsTimer = undefined
      if (generation !== pageSwitchGeneration) return
      void prepareReferencedSets(pageIds, generation).catch((error: unknown) => {
        console.warn('Could not prepare component pages in the background', error)
      })
    }
    const arm = () => {
      referencedSetsFrame = undefined
      if (generation !== pageSwitchGeneration) return
      referencedSetsTimer = setTimeout(run, 0)
    }
    if (typeof requestAnimationFrame === 'function') referencedSetsFrame = requestAnimationFrame(arm)
    else arm()
  }

  async function prepareReferencedSets(pageIds: readonly string[], generation: number) {
    const seen = new Set<string>([ctx.state.currentPageId])
    const pending = [...pageIds]
    for (let setPageId = pending.shift(); setPageId !== undefined; setPageId = pending.shift()) {
      if (generation !== pageSwitchGeneration) return
      if (seen.has(setPageId)) continue
      seen.add(setPageId)
      const ready = await preparePageNodes(setPageId)
      if (!ready || generation !== pageSwitchGeneration) return
      const nested = await collectComponentSetPages(setPageId, generation)
      if (!nested || generation !== pageSwitchGeneration) return
      pending.push(...nested)
      await yieldToMainThread()
    }
    if (generation === pageSwitchGeneration) ctx.requestRender()
  }

  function commitPageSwitch(prepared: PreparedPage): boolean {
    if (prepared.generation !== pageSwitchGeneration) return false
    const page = ctx.graph.getNode(prepared.pageId)
    if (page?.type !== 'CANVAS') return false

    pageViewportStore.saveCurrentPageViewport()
    const previousPageId = ctx.state.currentPageId
    ctx.state.currentPageId = prepared.pageId
    ctx.state.enteredContainerId = null
    ctx.setSelectedIds(new Set())
    pageViewportStore.restorePageViewport(prepared.pageId)
    if (previousPageId !== prepared.pageId) {
      ctx.emitEditorEvent('page:changed', prepared.pageId, previousPageId)
    }
    ctx.requestRender()
    return true
  }

  /**
   * Loads a page's layers so they can be searched, without fonts, layout, or switching to
   * it — and without superseding a page switch the user has in progress.
   */
  async function loadPageNodes(pageId: string): Promise<void> {
    if (ctx.graph.getNode(pageId)?.type === 'CANVAS') await populatePage(pageId, null)
  }

  async function prepareOffscreenPage(graph: SceneGraph, page: SceneNode): Promise<boolean> {
    const populated = await populatePage(page.id, null)
    if (populated === null || graph !== ctx.graph) return false
    const fontsReady = await resolvePageFonts(
      page.id,
      page.name,
      {},
      () => graph === ctx.graph,
      true
    )
    if (!fontsReady || graph !== ctx.graph) return false
    // Fonts and layout are separate turns. A component-set page never runs `computeAllLayouts`
    // as one chunk: the page on screen has already been asked to commit, and this yields
    // between bounded slices so that page can take a click.
    await yieldToMainThread()
    if (graph !== ctx.graph) return false
    return computeAllLayoutsCooperatively(graph, page.id, () => graph === ctx.graph)
  }

  /**
   * Loads a page's layers with their fonts and layout, ready to render, without switching to
   * it or superseding a page switch in progress. False when the document was closed or
   * replaced first. The page on screen already was prepared, when it was shown.
   */
  function preparePageNodes(pageId: string): Promise<boolean> {
    const graph = ctx.graph
    const page = graph.getNode(pageId)
    if (page?.type !== 'CANVAS') return Promise.resolve(false)
    if (pageId === ctx.state.currentPageId) return Promise.resolve(true)
    let preparations = offscreenPreparations.get(graph)
    if (!preparations) {
      preparations = new Map()
      offscreenPreparations.set(graph, preparations)
    }
    const pending = preparations.get(pageId)
    if (pending) return pending
    // A failed or superseded preparation is retried by the next caller.
    const forget = () => preparations.delete(pageId)
    const preparation = prepareOffscreenPage(graph, page).then(
      (ready) => {
        if (!ready) forget()
        return ready
      },
      (error: unknown) => {
        forget()
        throw error
      }
    )
    preparations.set(pageId, preparation)
    return preparation
  }

  async function switchPage(pageId: string, options: SwitchPageOptions = {}): Promise<void> {
    const prepared = await preparePage(pageId, options)
    if (prepared) commitPageSwitch(prepared)
  }

  /** Opens the page before or after the current one in the pages panel, stopping at the ends. */
  async function switchToAdjacentPage(step: 1 | -1): Promise<void> {
    const pages = ctx.graph.getPages()
    const index = pages.findIndex((page) => page.id === ctx.state.currentPageId)
    const next = index + step
    if (index === -1 || next < 0 || next >= pages.length) return
    await switchPage(pages[next].id)
  }

  function clearPageViewports() {
    cancelScheduledReferencedSets()
    populationWorkerGeneration++
    pageSwitchGeneration++
    populationWorkerInstance?.terminate()
    populationWorkerInstance = undefined
    pageViewportStore.clearPageViewports()
  }

  function addPage(name?: string) {
    const pages = ctx.graph.getPages()
    const pageName = name ?? `Page ${pages.length + 1}`
    const page = ctx.graph.addPage(pageName)
    setDefaultPageBackground(ctx.graph, page, ctx.state.theme)
    void switchPage(page.id)
    return page.id
  }

  function deletePage(pageId: string) {
    const pages = ctx.graph.getPages()
    if (pages.length <= 1) return
    const idx = pages.findIndex((p) => p.id === pageId)
    ctx.graph.deleteNode(pageId)
    pageViewportStore.deletePageViewport(pageId)
    if (ctx.state.currentPageId === pageId) {
      const newIdx = Math.min(idx, pages.length - 2)
      const remaining = ctx.graph.getPages()
      void switchPage(remaining[newIdx].id)
    }
  }

  function movePage(pageId: string, index: number) {
    const pages = ctx.graph.getPages()
    const currentIndex = pages.findIndex((page) => page.id === pageId)
    if (currentIndex === -1) return

    const nextIndex = Math.max(0, Math.min(index, pages.length - 1))
    if (nextIndex === currentIndex) return

    ctx.graph.insertChildAt(pageId, ctx.graph.rootId, nextIndex)
  }

  function renamePage(pageId: string, name: string) {
    ctx.graph.updateNode(pageId, { name })
  }

  function setPageColor(color: Color) {
    const page = ctx.graph.getNode(ctx.state.currentPageId)
    if (!page) return
    setPageBackgrounds(ctx.graph, page, [
      { type: 'SOLID', color: { ...color }, opacity: 1, visible: true, blendMode: 'NORMAL' }
    ])
    syncPageColor()
    ctx.requestRender()
  }

  /** Advances whenever a page switch starts, so a caller can tell it was overtaken. */
  function pageSwitchCount(): number {
    return pageSwitchGeneration
  }

  return {
    loadPageNodes,
    preparePageNodes,
    pageSwitchCount,
    preparePage,
    commitPageSwitch,
    switchPage,
    switchToNextPage: () => switchToAdjacentPage(1),
    switchToPreviousPage: () => switchToAdjacentPage(-1),
    addPage,
    deletePage,
    movePage,
    renamePage,
    setPageColor,
    clearPageViewports
  }
}
