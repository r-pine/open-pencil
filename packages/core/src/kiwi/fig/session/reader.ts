import { createFigDocumentSession } from '@open-pencil/fig'
import type { FigPageManifestEntry } from '@open-pencil/kiwi/fig'

import { buildFigPopulationDelta, installFigMutationJournal } from '#core/kiwi/fig/population/delta'
import { readerSessionOptions, type FigReaderDiagnostic } from '#core/kiwi/fig/session/options'

/** Worker and main-thread transport for the .fig reader session for the FIG reader session. */
export function openReaderSession(
  bytes: ArrayBuffer,
  populate: 'all' | 'first-page' | 'none' = 'all'
) {
  const diagnostics: FigReaderDiagnostic[] = []
  const session = createFigDocumentSession(bytes, readerSessionOptions(diagnostics))
  const pages: FigPageManifestEntry[] = session.pages.map((page) => ({
    sourceId: page.id,
    name: page.name,
    position: page.position,
    internalOnly: page.internalOnly
  }))
  const sourceByGraph = new Map<string, string>()
  for (const page of session.pages) {
    const id = session.graphPageId(page.id)
    if (id) sourceByGraph.set(id, page.id)
  }
  const loadedGraphIds = () =>
    [...session.loadedPageIds].flatMap((id) => {
      const graphId = session.graphPageId(id)
      return graphId ? [graphId] : []
    })
  if (populate === 'all') {
    for (const page of pages) if (!page.internalOnly) session.loadPage(page.sourceId)
  } else if (populate === 'first-page') {
    const page = pages.find((page) => !page.internalOnly)
    if (page) session.loadPage(page.sourceId)
  }
  // A cancelled apply never reached the main graph, but this session already loaded the page.
  // The next ask has to send that subtree again; `loadPage` will not record it a second time.
  const sent = new Map<string, PagePopulation>()
  return {
    session,
    /** Records skipped so far, including those of pages loaded later. */
    diagnostics,
    checkpoint: () => session.checkpoint(),
    graph: session.graph,
    pages,
    populate(pageId: string): PagePopulation {
      const sourceId = sourceByGraph.get(pageId)
      if (!sourceId) throw new Error(`Unknown graph page ${pageId}`)
      const again = sent.get(pageId)
      if (again) return structuredClone(again)
      const populated = !session.loadedPageIds.has(sourceId)
      const journal = installFigMutationJournal(session.graph)
      try {
        session.loadPage(sourceId)
        const result = {
          checkpoint: session.checkpoint(),
          populated,
          delta: buildFigPopulationDelta(session.graph, journal, loadedGraphIds())
        }
        sent.set(pageId, structuredClone(result))
        return result
      } finally {
        journal.stop()
      }
    }
  }
}

interface PagePopulation {
  checkpoint: ReturnType<ReturnType<typeof createFigDocumentSession>['checkpoint']>
  populated: boolean
  delta: ReturnType<typeof buildFigPopulationDelta>
}
