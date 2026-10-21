import { describe, expect, test } from 'bun:test'

import {
  findFigThumbnailPageId,
  findTopmostThumbnailChild
} from '#core/io/formats/fig/thumbnail-page'

describe('FIG thumbnail page selection', () => {
  test('prefers an exact Cover page case-insensitively', () => {
    expect(
      findFigThumbnailPageId([
        { id: 'first', name: 'Cover archive' },
        { id: 'exact', name: '  COVER  ' },
        { id: 'last', name: 'Cover v2' }
      ])
    ).toBe('exact')
  })

  test('uses the first page containing Cover when no exact match exists', () => {
    expect(
      findFigThumbnailPageId([
        { id: 'unrelated', name: 'Homepage' },
        { id: 'first-cover', name: '✨ Project cover' },
        { id: 'second-cover', name: 'Cover archive' }
      ])
    ).toBe('first-cover')
  })

  test('does not fall back to an unrelated page', () => {
    expect(findFigThumbnailPageId([{ id: 'first', name: 'Homepage' }])).toBeUndefined()
  })

  test('the card shows the uppermost block on the cover', () => {
    expect(
      findTopmostThumbnailChild([
        { id: 'contents', x: 1320, y: 560, width: 1160, height: 2283 },
        { id: 'hero', x: 0, y: 0, width: 2400, height: 400 },
        { id: 'hidden', x: 0, y: -10, width: 100, height: 100, visible: false },
        { id: 'how', x: 0, y: 560, width: 1160, height: 839 }
      ])
    ).toBe('hero')
  })

  test('uses a page named Обложка as the cover', () => {
    expect(
      findFigThumbnailPageId([
        { id: 'icons', name: '02 Иконки' },
        { id: 'cover', name: '00 Обложка' },
        { id: 'basics', name: '01 Основы' }
      ])
    ).toBe('cover')
  })
})
