import { afterAll, expect, test } from 'bun:test'

import { SkiaRenderer } from '@open-pencil/core'
import { initCanvasKit, renderNodesToImage } from '@open-pencil/core/io'
import { SceneGraph, type VectorNetwork } from '@open-pencil/scene-graph'
import { IDENTITY_GRADIENT_TRANSFORM } from '@open-pencil/scene-graph/gradient'

import { expectDefined } from '../helpers/assert'

const ck = await initCanvasKit()
const renderer = new SkiaRenderer(ck, expectDefined(ck.MakeSurface(1, 1)))
afterAll(() => renderer.destroy())

const zero = { x: 0, y: 0 }

/** RGBA at a point of an 80×20 frame holding a horizontal gradient stroke of height 0. */
function pixelAt(x: number, y: number): number[] {
  const graph = new SceneGraph()
  const page = graph.getPages()[0].id
  const frame = graph.createNode('FRAME', page, {
    width: 80,
    height: 20,
    fills: [],
    clipsContent: false
  })
  const network: VectorNetwork = {
    vertices: [
      { x: 0, y: 0 },
      { x: 60, y: 0 }
    ],
    segments: [{ start: 0, end: 1, tangentStart: zero, tangentEnd: zero }],
    regions: []
  }
  graph.createNode('VECTOR', frame.id, {
    x: 10,
    y: 10,
    width: 60,
    height: 0,
    vectorNetwork: network,
    fills: [],
    strokes: [
      {
        type: 'GRADIENT_LINEAR',
        color: { r: 0, g: 0, b: 0, a: 1 },
        opacity: 1,
        visible: true,
        blendMode: 'NORMAL',
        weight: 8,
        align: 'CENTER',
        cap: 'NONE',
        join: 'MITER',
        gradientStops: [
          { color: { r: 1, g: 0, b: 0, a: 0 }, position: 0 },
          { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0.5 },
          { color: { r: 1, g: 0, b: 0, a: 0 }, position: 1 }
        ],
        gradientTransform: IDENTITY_GRADIENT_TRANSFORM
      }
    ]
  })
  const png = expectDefined(
    renderNodesToImage(ck, renderer, graph, page, [frame.id], {
      scale: 1,
      format: 'PNG',
      trimTransparent: false
    })
  )
  const image = expectDefined(ck.MakeImageFromEncoded(png))
  try {
    const pixels = expectDefined(
      image.readPixels(0, 0, {
        width: image.width(),
        height: image.height(),
        alphaType: ck.AlphaType.Unpremul,
        colorType: ck.ColorType.RGBA_8888,
        colorSpace: ck.ColorSpace.SRGB
      })
    )
    const offsetX = (image.width() - 80) / 2
    const offsetY = (image.height() - 20) / 2
    const index = ((y + offsetY) * image.width() + x + offsetX) * 4
    return [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]]
  } finally {
    image.delete()
  }
}

test('a flat gradient stroke still draws when the line has no height', () => {
  const middle = pixelAt(40, 10)
  const end = pixelAt(12, 10)
  expect(middle[0]).toBeGreaterThan(200)
  expect(middle[3]).toBeGreaterThan(200)
  expect(end[3]).toBeLessThan(middle[3])
})
