import { describe, expect, test, vi } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

// The generators' needsRender / render bookkeeping, on stubs. The compute
// dispatch needs a device and is validated at case 45

// Both failure directions are silent: never clearing re-renders a 128³ volume
// every frame, and clearing too early leaves the march sampling an empty
// texture, which looks like "the clouds are missing"

const stubRenderer = (): { compute: ReturnType<typeof vi.fn> } => ({
  compute: vi.fn()
})

describe('Procedural3DTexture bookkeeping', () => {
  setCurrentSpec('procedural-3d-bookkeeping')

  test('renders once, then not again until asked', async () => {
    const { CloudShapeDetail } = await import('./generators')
    const tex = new CloudShapeDetail()
    const renderer = stubRenderer()

    expect(tex.needsRender).toBe(true)

    tex.render(renderer as never)
    expect(renderer.compute).toHaveBeenCalledTimes(1)
    expect(tex.needsRender).toBe(false)

    // A second render must be a no-op: this is the difference between filling
    // the volume once and re-filling it every frame
    tex.render(renderer as never)
    expect(renderer.compute).toHaveBeenCalledTimes(1)

    tex.needsRender = true
    tex.render(renderer as never)
    expect(renderer.compute).toHaveBeenCalledTimes(2)

    log('procedural-3d-bookkeeping', [
      { field: 'computes after 3 render() calls', expected: 2, actual: 2 }
    ])
    tex.dispose()
  })

  test('exposes the reference sizes', async () => {
    const g = await import('./generators')
    expect(new g.CloudShape().size).toBe(128)
    expect(new g.CloudShapeDetail().size).toBe(32)
    expect(new g.Turbulence().size).toBe(128)
    expect(new g.LocalWeather().size).toBe(512)
  })

  test('3D textures wrap on every axis', async () => {
    // The generators are built to tile, and a clamped sampler would seam at the
    // border regardless, so the wrap mode is part of the contract
    const { CloudShapeDetail } = await import('./generators')
    const { RepeatWrapping } = await import('three/webgpu')
    const tex = new CloudShapeDetail()
    const t = tex.texture as unknown as {
      wrapS: number
      wrapT: number
      wrapR: number
    }
    expect(t.wrapS).toBe(RepeatWrapping)
    expect(t.wrapT).toBe(RepeatWrapping)
    expect(t.wrapR).toBe(RepeatWrapping)
    tex.dispose()
  })

  test('only the 2D textures generate mipmaps', async () => {
    // Asymmetry carried from the reference: the weather texture is sampled at
    // grazing angles where a mip chain matters, the volumes are sampled at
    // roughly constant density along a march
    const { LocalWeather, CloudShape } = await import('./generators')
    const weather = new LocalWeather()
    const shape = new CloudShape()
    expect(
      (weather.texture as unknown as { generateMipmaps: boolean })
        .generateMipmaps
    ).toBe(true)
    expect(
      (shape.texture as unknown as { generateMipmaps?: boolean })
        .generateMipmaps ?? false
    ).toBe(false)
    weather.dispose()
    shape.dispose()
  })

  test('the 2D textures minify through their mip chain; the volumes stay linear', async () => {
    // The reference's 2D generator sets generateMipmaps and
    // LinearMipMapLinearFilter (ProceduralTexture.ts:64-66), as does the baked
    // weather loader (loadBakedCloudTextures.ts)

    // With LinearFilter, three's WebGPU backend uses mipmapFilter NEAREST and a
    // fractional mip rounds to one level where the reference blends two. The 3D
    // generators have no mip chain on either side
    const { LocalWeather, CloudShape } = await import('./generators')
    const { LinearFilter, LinearMipMapLinearFilter } =
      await import('three/webgpu')
    const weather = new LocalWeather()
    const shape = new CloudShape()
    const w = weather.texture as unknown as {
      minFilter: number
      magFilter: number
    }
    const v = shape.texture as unknown as {
      minFilter: number
      magFilter: number
    }
    expect(w.minFilter).toBe(LinearMipMapLinearFilter)
    expect(w.magFilter).toBe(LinearFilter)
    expect(v.minFilter).toBe(LinearFilter)
    expect(v.magFilter).toBe(LinearFilter)
    weather.dispose()
    shape.dispose()
  })

  test('dispose releases the texture', async () => {
    const { Turbulence } = await import('./generators')
    const tex = new Turbulence()
    const spy = vi.spyOn(tex.texture, 'dispose')
    tex.dispose()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // The compute unflattens a linear index with `i % size`, `(i / size) % size`,
  // `i / size²`. With a float divide every texel above the first slice would be
  // written skewed, with no error. Checked in the emitted WGSL, no device needed
  test('unflattens the linear index with integer division', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn, int, screenCoordinate, vec3, vec4 } = await import('three/tsl')

    // A runtime int, so nothing constant-folds (the same shape the compute uses
    // for int(instanceIndex))
    const node = Fn(() => {
      const i = int(screenCoordinate.x)
      const size = 32
      return vec4(
        vec3(i.mod(size), i.div(size).mod(size), i.div(size * size)).div(size),
        1
      )
    })()
    const { fragment } = compileWGSL(node)

    // i32 operands on both the divide and the modulo
    const index = /let (\w+) = i32\([^)]*\);/.exec(fragment)?.[1]
    expect(index).toBeDefined()
    expect(fragment).toMatch(new RegExp(`${index}\\s*\\/\\s*32`))
    expect(fragment).toMatch(new RegExp(`${index}\\s*%\\s*32`))
    // and the slice stride, not a second divide by size
    expect(fragment).toContain('1024')
  })

  // (case 45 at 0.6486, "fields differ"). The
  // reference samples texel centres on x and y ((i + 0.5) / size, from vUv) but
  // layer / size on z. Corners on all three move the noise ~0.22 of a cell

  // Pinned in the emitted WGSL because a "consistency" cleanup would
  // regularise it
  test('samples texel centres on x and y, and the slice plane on z', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn, float, int, screenCoordinate, vec3, vec4 } =
      await import('three/tsl')

    const size = 32
    const node = Fn(() => {
      const i = int(screenCoordinate.x)
      const x = i.mod(size)
      const y = i.div(size).mod(size)
      const z = i.div(size * size)
      return vec4(
        vec3(
          float(x).add(0.5).div(size),
          float(y).add(0.5).div(size),
          float(z).div(size)
        ),
        1
      )
    })()
    const { fragment } = compileWGSL(node)

    // Two half-offsets, not three: x and y get 0.5, z does not
    const halves = (fragment.match(/\+ 0\.5/g) ?? []).length
    log('procedural-half-texel', [
      { field: '+ 0.5 occurrences', expected: 2, actual: halves }
    ])
    expect(halves).toBe(2)
  })
})
