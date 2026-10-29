import { DataUtils } from 'three'
import { describe, expect, it } from 'vitest'

import { table } from '../../../test/helpers/cpuTwin'
import {
  atlasCascadeLayerCount,
  atlasReadFormat,
  readAtlasLayersGL,
  type AtlasGLReader
} from './shadowAtlasReadback'

// side A's atlas had no readback lane at all, so every comparison of
// the two raw atlases was impossible and the 2x512 ground-shadow excess had no
// tie-breaker. These guard the arithmetic that lane depends on

const GL = {
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  RGBA: 0x1908,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b50,
  IMPLEMENTATION_COLOR_READ_TYPE: 0x8b51,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  NO_ERROR: 0,
  UNSIGNED_BYTE: 0x1401
}

interface FakeOptions {
  readType?: number
  framebufferStatus?: number
  /** GL errors already pending when the read starts */
  preexistingErrors?: number[]
  /** errors the read itself raises, consumed one per getError call */
  readErrors?: number[]
}

function fakeGL(options: FakeOptions): AtlasGLReader & {
  calls: string[]
  boundLayers: number[]
} {
  const {
    readType = GL.FLOAT,
    framebufferStatus = GL.FRAMEBUFFER_COMPLETE,
    preexistingErrors = [],
    readErrors = []
  } = options
  const calls: string[] = []
  const boundLayers: number[] = []
  // Pending BEFORE the read: drainErrors consumes these, and a real driver
  // raises them from earlier GL work rather than from this readPixels
  const pending = [...preexistingErrors]
  // Raised BY readPixels. Held back until a readPixels has run, because the
  // drain that precedes the read must not see them
  const queuedReadErrors = [...readErrors]
  let readPixelsSeen = 0
  let boundReadFramebuffer: unknown = null
  // The layer most recently attached. Stamped into the values, not counted,
  // so a re-attach does not shift the stamp
  let boundLayer = 0

  // The spec ties IMPLEMENTATION_COLOR_READ_* to the BOUND read framebuffer, and
  // unbound this answers UNSIGNED_BYTE as a real driver does for the default one,
  // while a bound RGBA16F framebuffer answers the requested type
  function answer(name: number): unknown {
    if (name === GL.IMPLEMENTATION_COLOR_READ_FORMAT) return GL.RGBA
    if (name === GL.IMPLEMENTATION_COLOR_READ_TYPE) {
      return boundReadFramebuffer === null ? GL.UNSIGNED_BYTE : readType
    }
    if (name === GL.READ_FRAMEBUFFER_BINDING) return { id: 'previous-read' }
    return { id: 'previous-draw' }
  }

  return {
    ...GL,
    calls,
    boundLayers,
    createFramebuffer: () => ({ id: 'fb' }),
    deleteFramebuffer: () => calls.push('deleteFramebuffer'),
    bindFramebuffer: (target, framebuffer) => {
      if (target === GL.READ_FRAMEBUFFER) boundReadFramebuffer = framebuffer
      calls.push(
        `bind:${target}:${framebuffer === null ? 'null' : String((framebuffer as { id: string }).id)}`
      )
    },
    checkFramebufferStatus: () => framebufferStatus,
    framebufferTextureLayer: (
      _target,
      _attachment,
      _texture,
      _level,
      layer
    ) => {
      boundLayers.push(layer)
      calls.push(`attach:${layer}`)
      boundLayer = layer
    },
    readBuffer: () => calls.push('readBuffer'),
    getParameter: name => answer(name),
    getError: () => {
      if (readPixelsSeen > 0) {
        const fromRead = queuedReadErrors.shift()
        if (fromRead != null) return fromRead
      }
      return pending.shift() ?? GL.NO_ERROR
    },
    readPixels: (_x, _y, w, h, _format, _type, pixels) => {
      calls.push(`readPixels:${w}x${h}:${pixels.constructor.name}`)
      ++readPixelsSeen
      // A recognisable per-texel stamp: the ATTACHED layer in every channel,
      // so a stride or a layer-offset error is visible in the values themselves
      const layer = boundLayer
      if (pixels instanceof Float32Array) {
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = layer + 0.25
          pixels[i + 1] = layer + 0.5
          pixels[i + 2] = layer + 0.75
          pixels[i + 3] = 1
        }
      } else {
        const codes = pixels as Uint16Array
        for (let i = 0; i < codes.length; i += 4) {
          codes[i] = DataUtils.toHalfFloat(layer + 0.25)
          codes[i + 1] = DataUtils.toHalfFloat(layer + 0.5)
          codes[i + 2] = DataUtils.toHalfFloat(layer + 0.75)
          codes[i + 3] = DataUtils.toHalfFloat(1)
        }
      }
    }
  }
}

describe('atlasCascadeLayerCount', () => {
  it('is the cascade depth in every combination, raw included', () => {
    const rows = []
    for (const temporalPass of [true, false]) {
      for (const raw of [true, false]) {
        const count = atlasCascadeLayerCount({ depth: 2, temporalPass, raw })
        rows.push({
          temporalPass: temporalPass,
          raw,
          layerCount: count,
          expected: 2
        })
        expect(count).toBe(2)
      }
    }
    table('atlas-cascade-layer-count', rows)
  })

  // Reading depth*2 layers would take cascade 1's velocity for cascade 2's data
  it('does not double for the velocity attachment the raw target carries', () => {
    expect(
      atlasCascadeLayerCount({ depth: 4, temporalPass: true, raw: true })
    ).toBe(4)
  })

  it('refuses a depth that is not a positive integer', () => {
    for (const depth of [0, -1, 2.5, Number.NaN]) {
      expect(() =>
        atlasCascadeLayerCount({ depth, temporalPass: true, raw: false })
      ).toThrow(/not a positive integer/)
    }
  })
})

describe('atlasReadFormat', () => {
  it('takes the driver answer for FLOAT and HALF_FLOAT', () => {
    expect(atlasReadFormat(GL.RGBA, GL.FLOAT, GL)).toEqual({
      format: GL.RGBA,
      type: GL.FLOAT,
      element: 'float'
    })
    expect(atlasReadFormat(GL.RGBA, GL.HALF_FLOAT, GL)).toEqual({
      format: GL.RGBA,
      type: GL.HALF_FLOAT,
      element: 'uint16'
    })
  })

  // Guessing FLOAT on an RGBA16F attachment is an INVALID_OPERATION on some
  // drivers, and readPixels then leaves the destination UNCHANGED, which reads
  // back as a valid-looking all-zero atlas
  it('refuses anything other than RGBA / FLOAT / HALF_FLOAT', () => {
    expect(() => atlasReadFormat(0x8058, GL.FLOAT, GL)).toThrow(/not RGBA/)
    expect(() => atlasReadFormat(GL.RGBA, 0x1401, GL)).toThrow(
      /neither FLOAT nor HALF_FLOAT/
    )
  })
})

describe('readAtlasLayersGL', () => {
  it('reads one layer per cascade, from layer 0, and restores the bindings', () => {
    const gl = fakeGL({})
    const { layers } = readAtlasLayersGL({
      gl,
      texture: 'tex',
      width: 4,
      height: 2,
      layerCount: 2
    })
    expect(layers).toHaveLength(2)
    // Cascade 0 begins at layer 0. A stride error would start at layer 2, and the
    // extra layer-0 attach before the loop is what makes the driver's read
    // format answerable
    expect(gl.boundLayers).toEqual([0, 0, 1])
    expect(Array.from(layers[0]!.slice(0, 4))).toEqual([0.25, 0.5, 0.75, 1])
    expect(Array.from(layers[1]!.slice(0, 4))).toEqual([1.25, 1.5, 1.75, 1])
    // READ bound to the scratch framebuffer, then both restored to exactly what
    // they were. A restore that touched FRAMEBUFFER instead would leave the
    // draw target clobbered for the rest of the frame
    expect(gl.calls.filter(call => call.startsWith('bind:'))).toEqual([
      `bind:${GL.READ_FRAMEBUFFER}:fb`,
      `bind:${GL.READ_FRAMEBUFFER}:previous-read`,
      `bind:${GL.DRAW_FRAMEBUFFER}:previous-draw`
    ])
    expect(gl.calls.at(-1)).toBe('deleteFramebuffer')
  })

  // IMPLEMENTATION_COLOR_READ_TYPE describes the BOUND read framebuffer, so it
  // cannot be asked before the bind. Asked first, this driver answers
  // UNSIGNED_BYTE and the read refuses, which is what the first run did
  it('asks the driver for its read format only after binding its framebuffer', () => {
    const gl = fakeGL({})
    const { layers } = readAtlasLayersGL({
      gl,
      texture: 'tex',
      width: 4,
      height: 2,
      layerCount: 2
    })
    // Layers 0 twice: once to make the framebuffer's answer meaningful, once as
    // the real read. Two layers out, so the probe above did not eat one
    expect(gl.boundLayers).toEqual([0, 0, 1])
    expect(layers).toHaveLength(2)
    expect(Array.from(layers[0]!.slice(0, 4))).toEqual([0.25, 0.5, 0.75, 1])
    expect(Array.from(layers[1]!.slice(0, 4))).toEqual([1.25, 1.5, 1.75, 1])
    const firstBind = gl.calls.findIndex(call => call.startsWith('bind:'))
    // The driver's own answer arrived with a framebuffer already bound
    expect(firstBind).toBeGreaterThanOrEqual(0)
  })

  it('decodes a HALF_FLOAT attachment to the same values as FLOAT', () => {
    const { layers: asFloat } = readAtlasLayersGL({
      gl: fakeGL({}),
      texture: 'tex',
      width: 4,
      height: 2,
      layerCount: 2
    })
    const { layers: asHalf } = readAtlasLayersGL({
      gl: fakeGL({ readType: GL.HALF_FLOAT }),
      texture: 'tex',
      width: 4,
      height: 2,
      layerCount: 2
    })
    for (let layer = 0; layer < 2; layer++) {
      expect(Array.from(asHalf[layer]!)).toEqual(Array.from(asFloat[layer]!))
    }
  })

  it('refuses an incomplete framebuffer rather than reading zeros', () => {
    const gl = fakeGL({ framebufferStatus: 0x8cdd })
    expect(() =>
      readAtlasLayersGL({
        gl,
        texture: 'tex',
        width: 4,
        height: 2,
        layerCount: 2
      })
    ).toThrow(/framebuffer incomplete/)
  })

  it('refuses a read the driver rejected', () => {
    // 0x0500 INVALID_ENUM
    const gl = fakeGL({ readErrors: [0x0500] })
    expect(() =>
      readAtlasLayersGL({
        gl,
        texture: 'tex',
        width: 4,
        height: 2,
        layerCount: 2
      })
    ).toThrow(/GL error 0x500/)
  })

  // 0x506 is INVALID_FRAMEBUFFER_OPERATION. Side A's render leaves exactly
  // one of these pending, and the texels after the drain are the atlas
  it('reports a pending 0x506 and still returns the texels', () => {
    const gl = fakeGL({ preexistingErrors: [0x0506] })
    const read = readAtlasLayersGL({
      gl,
      texture: 'tex',
      width: 4,
      height: 2,
      layerCount: 1
    })
    table('atlas-pending-0x506', [
      {
        field: 'preexisting',
        expected: '0x506',
        actual: read.preexistingErrors
          .map(code => '0x' + code.toString(16))
          .join(',')
      },
      {
        field: 'texel0',
        expected: '0.25,0.5,0.75,1',
        actual: Array.from(read.layers[0]!.slice(0, 4)).join(',')
      }
    ])
    expect(read.preexistingErrors).toEqual([0x0506])
    expect(Array.from(read.layers[0]!.slice(0, 4))).toEqual([
      0.25, 0.5, 0.75, 1
    ])
    expect(gl.calls.at(-1)).toBe('deleteFramebuffer')
  })

  // A pending error before the read would otherwise be charged to it, and the
  // bindings would still be restored: the throw has to come from the read
  it('refuses to run with errors already pending, and still restores', () => {
    const gl = fakeGL({ preexistingErrors: [0x0500] })
    expect(() =>
      readAtlasLayersGL({
        gl,
        texture: 'tex',
        width: 4,
        height: 2,
        layerCount: 1
      })
    ).toThrow(/pending GL error\(s\): 0x500/)
    expect(gl.calls.at(-1)).toBe('deleteFramebuffer')
    expect(gl.calls.filter(call => call.startsWith('bind:')).length).toBe(3)
  })

  it('refuses a size or layer count that is not a positive integer pair', () => {
    const gl = fakeGL({})
    expect(() =>
      readAtlasLayersGL({
        gl,
        texture: 'tex',
        width: 0,
        height: 2,
        layerCount: 1
      })
    ).toThrow(/not a positive integer pair/)
    expect(() =>
      readAtlasLayersGL({
        gl,
        texture: 'tex',
        width: 4,
        height: 2,
        layerCount: 0
      })
    ).toThrow(/layer count 0 is not positive/)
  })
})
