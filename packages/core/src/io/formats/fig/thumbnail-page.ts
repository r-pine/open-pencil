type ThumbnailPage = {
  id: string
  name: string
}

type ThumbnailChild = {
  id: string
  x: number
  y: number
  width: number
  height: number
  visible?: boolean
}

/** The uppermost layer of a cover page: the block a file card should show. */
export function findTopmostThumbnailChild(children: readonly ThumbnailChild[]): string | undefined {
  let top: ThumbnailChild | undefined
  for (const child of children) {
    if (child.visible === false || child.width <= 0 || child.height <= 0) continue
    if (!top || child.y < top.y || (child.y === top.y && child.x < top.x)) top = child
  }
  return top?.id
}

const COVER_PAGE_NAMES = ['cover', 'обложка']

function isCoverName(name: string, exact: boolean): boolean {
  return COVER_PAGE_NAMES.some((cover) => (exact ? name === cover : name.includes(cover)))
}

/** Resolve the conventional cover page without falling back to unrelated content. */
export function findFigThumbnailPageId(pages: readonly ThumbnailPage[]): string | undefined {
  const normalizedNames = pages.map((page) => ({
    page,
    name: page.name.trim().toLocaleLowerCase()
  }))
  return (
    normalizedNames.find(({ name }) => isCoverName(name, true))?.page.id ??
    normalizedNames.find(({ name }) => isCoverName(name, false))?.page.id
  )
}
