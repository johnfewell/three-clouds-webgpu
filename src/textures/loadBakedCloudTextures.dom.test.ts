// @vitest-environment jsdom
import {
  LinearFilter,
  LinearMipMapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { loadBakedCloudTextures } from './loadBakedCloudTextures'

vi.mock('three', async importOriginal => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('three')>()

  class MockTextureLoader {
    load(
      _url: string,
      onLoad?: (t: InstanceType<typeof actual.Texture>) => void
    ) {
      const t = new actual.Texture()
      onLoad?.(t)
    }
  }

  return { ...actual, TextureLoader: MockTextureLoader }
})

const SHAPE_SIZE = 128
const SHAPE_DETAIL_SIZE = 32

describe('loadBakedCloudTextures', () => {
  setCurrentSpec('loadBakedCloudTextures')

  const urls = {
    localWeather: 'http://test/local_weather.png',
    turbulence: 'http://test/turbulence.png',
    shape: 'http://test/shape.bin',
    shapeDetail: 'http://test/shape_detail.bin'
  }

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const size = url.includes('shape_detail')
          ? SHAPE_DETAIL_SIZE
          : SHAPE_SIZE
        return Promise.resolve({
          ok: true,
          arrayBuffer: () =>
            Promise.resolve(new ArrayBuffer(size * size * size))
        })
      })
    )
  })

  it('loads all four textures', async () => {
    const result = await loadBakedCloudTextures(urls)
    expect(result.localWeatherTexture).toBeDefined()
    expect(result.turbulenceTexture).toBeDefined()
    expect(result.shapeTexture).toBeDefined()
    expect(result.shapeDetailTexture).toBeDefined()
  })

  it('2D textures have correct sampler settings', async () => {
    const result = await loadBakedCloudTextures(urls)

    const samplerTable: unknown[] = []

    for (const [name, tex] of [
      ['localWeatherTexture', result.localWeatherTexture],
      ['turbulenceTexture', result.turbulenceTexture]
    ] as const) {
      expect(tex.minFilter).toBe(LinearMipMapLinearFilter)
      expect(tex.magFilter).toBe(LinearFilter)
      expect(tex.wrapS).toBe(RepeatWrapping)
      expect(tex.wrapT).toBe(RepeatWrapping)
      expect(tex.colorSpace).toBe(NoColorSpace)
      samplerTable.push({
        name,
        minFilter: tex.minFilter,
        magFilter: tex.magFilter,
        wrapS: tex.wrapS,
        wrapT: tex.wrapT,
        colorSpace: tex.colorSpace
      })
    }

    log('loadBakedCloudTextures', samplerTable)
  })

  it('3D shape texture has correct settings', async () => {
    const result = await loadBakedCloudTextures(urls)
    const tex = result.shapeTexture

    expect(tex.image.width).toBe(SHAPE_SIZE)
    expect(tex.image.height).toBe(SHAPE_SIZE)
    expect(tex.image.depth).toBe(SHAPE_SIZE)
    expect(tex.format).toBe(RedFormat)
    expect(tex.minFilter).toBe(LinearFilter)
    expect(tex.magFilter).toBe(LinearFilter)
    expect(tex.wrapS).toBe(RepeatWrapping)
    expect(tex.wrapT).toBe(RepeatWrapping)
    expect(tex.wrapR).toBe(RepeatWrapping)
    expect(tex.colorSpace).toBe(NoColorSpace)

    log('loadBakedCloudTextures', {
      name: 'shapeTexture',
      width: tex.image.width,
      height: tex.image.height,
      depth: tex.image.depth,
      format: tex.format,
      minFilter: tex.minFilter,
      magFilter: tex.magFilter
    })
  })

  it('3D shape detail texture has correct settings', async () => {
    const result = await loadBakedCloudTextures(urls)
    const tex = result.shapeDetailTexture

    expect(tex.image.width).toBe(SHAPE_DETAIL_SIZE)
    expect(tex.image.height).toBe(SHAPE_DETAIL_SIZE)
    expect(tex.image.depth).toBe(SHAPE_DETAIL_SIZE)
    expect(tex.format).toBe(RedFormat)
    expect(tex.minFilter).toBe(LinearFilter)
    expect(tex.magFilter).toBe(LinearFilter)
    expect(tex.wrapS).toBe(RepeatWrapping)
    expect(tex.wrapT).toBe(RepeatWrapping)
    expect(tex.wrapR).toBe(RepeatWrapping)
    expect(tex.colorSpace).toBe(NoColorSpace)

    log('loadBakedCloudTextures', {
      name: 'shapeDetailTexture',
      width: tex.image.width,
      height: tex.image.height,
      depth: tex.image.depth
    })
  })

  it('fetch rejection propagates with URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 })
    )

    await expect(loadBakedCloudTextures(urls)).rejects.toThrow('shape.bin')
  })
})
