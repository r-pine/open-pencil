import { ref, shallowRef } from 'vue'

import { computeAllLayouts } from '@open-pencil/core/layout'
import {
  documentFontStatusWhenIdle,
  fontManager,
  fontResolver,
  type DocumentFontStatus
} from '@open-pencil/core/text'
import { useEditorEvent } from '@open-pencil/vue'

import { useEditorStore } from '@/app/editor/active-store'
import { loadFont, requestLocalFontAccess } from '@/app/editor/fonts'

const EMPTY_FONT_STATUS: DocumentFontStatus = { faithful: true, faces: [], issues: [] }

/** Wait until an edit burst settles before scanning the page for missing fonts. */
const FONT_STATUS_QUIET_MS = 200

export function useDocumentFontStatus() {
  const editor = useEditorStore()
  const retrying = ref(false)
  const status = shallowRef<DocumentFontStatus>(EMPTY_FONT_STATUS)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /**
   * The banner used to walk every layer of the current page inside the edit. On a file this
   * size that walk ran before the browser could take a pan. The scan now waits out the edit
   * and yields between slices.
   */
  function schedule() {
    const scan = ++generation
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void run(scan)
    }, FONT_STATUS_QUIET_MS)
  }

  async function run(scan: number) {
    const pageId = editor.state.currentPageId
    const next = await documentFontStatusWhenIdle(
      editor.graph,
      pageId,
      () => scan === generation && editor.state.currentPageId === pageId
    )
    if (!next || scan !== generation) return
    status.value = next
  }

  useEditorEvent('font:resolution-changed', schedule)
  useEditorEvent('graph:replaced', schedule)
  useEditorEvent('page:changed', schedule)
  useEditorEvent('node:created', schedule)
  useEditorEvent('node:updated', schedule)
  useEditorEvent('node:deleted', schedule)
  schedule()

  async function retry() {
    if (retrying.value) return
    retrying.value = true
    const preparation = editor.preparationController.begin({ kind: 'font-retry' })
    let succeeded = false
    try {
      if (fontManager.localAccessState() === 'prompt') {
        await requestLocalFontAccess().catch(() => [])
      }
      const issues = status.value.issues
      await Promise.all(
        issues.map(async ({ family, style }) => {
          fontManager.resetWebFontFailures(family, style)
          fontResolver.reset(
            `face:${family.trim().toLocaleLowerCase()}:${style.toLocaleLowerCase()}`
          )
          await loadFont(family, style, '', preparation.signal)
        })
      )
      editor.renderer?.invalidateAllPictures()
      editor.graph.applyDerivedLayoutDuring(() =>
        computeAllLayouts(editor.graph, editor.state.currentPageId)
      )
      preparation.update({ phase: 'preparing-render' })
      editor.requestRender()
      if (editor.renderer) {
        await editor.preparationController.waitForPresentation(
          preparation.id,
          editor.state.sceneVersion
        )
      }
      schedule()
      succeeded = true
    } catch (error) {
      if (!preparation.signal.aborted) {
        preparation.fail({
          code: 'font-failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: true
        })
      }
    } finally {
      if (succeeded) preparation.complete()
      retrying.value = false
    }
  }

  function selectAffectedNodes() {
    editor.select(status.value.issues.flatMap((issue) => issue.nodeIds))
  }

  return { status, retrying, retry, selectAffectedNodes }
}
