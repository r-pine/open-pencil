export { readFigFile, parseFigFile, type ParseFigFileOptions } from './read'
export { exportFigFile, compressFigData, compressFigDataSync } from './write'
export { findFigThumbnailPageId, findTopmostThumbnailChild } from './thumbnail-page'
export { figThumbnailIsExpensive } from './thumbnail-budget'
export {
  isReaderPagePending as isFigPagePending,
  populateFigPage,
  populateAllFigPages,
  readerDiagnostics
} from '#core/kiwi/fig/session/document-state'
