// Cite: @takram/three-atmosphere shared.js:294. The site's PCF seeds from
// gl_FragCoord, which is bottom-first. three's screenCoordinate is top-first,
// so the conversion is what makes the two sides' disks land on the same taps

import { DataArrayTexture, Matrix4, Vector2, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  createCloudShadowTransmittance,
  webglFragCoordCPU
} from './sampleCloudShadowOpticalDepth'

describe('site-2 PCF seed row origin', () => {
  setCurrentSpec('sampleCloudShadow-row')

  const CASCADES = 4
  const FRAMEBUFFER_HEIGHT = 540

  /** The reference's seed, verbatim from both implementations */
  const ign = (x: number, y: number): number => {
    const inner = (0.06711056 * x + 0.00583715 * y) % 1
    return (52.9829189 * inner) % 1
  }

  it('maps a top-first fragment row onto the bottom-first row the reference reads', () => {
    // Pixel centres sit at half-integers in both conventions, so the mirror is
    // height - y and not height - 1 - y
    expect(webglFragCoordCPU([10.5, 0.5], FRAMEBUFFER_HEIGHT)).toEqual([
      10.5, 539.5
    ])
    expect(webglFragCoordCPU([10.5, 539.5], FRAMEBUFFER_HEIGHT)).toEqual([
      10.5, 0.5
    ])
    // The row index is mirrored, the column is not
    expect(webglFragCoordCPU([3.5, 7.5], FRAMEBUFFER_HEIGHT)[0]).toBe(3.5)
  })

  it('is the mirror every row needs, so the conversion never skips one', () => {
    for (let y = 0; y < FRAMEBUFFER_HEIGHT; y++) {
      const [, converted] = webglFragCoordCPU(
        [0.5, y + 0.5],
        FRAMEBUFFER_HEIGHT
      )
      if (converted !== FRAMEBUFFER_HEIGHT - (y + 0.5)) {
        throw new Error(`row ${y} not mirrored`)
      }
    }
    expect(FRAMEBUFFER_HEIGHT).toBeGreaterThan(0)
  })

  it('the unconverted row decorrelates the seed on every pixel', () => {
    // The red: without the conversion the two sides' disks are rotated by an
    // independent angle per pixel, which is what collapsed the ground shadow to
    // ssim 0.35 while the plate statistics matched
    let sum = 0
    let sumSq = 0
    let sumOther = 0
    let sumOtherSq = 0
    let sumCross = 0
    let n = 0
    for (let y = 0; y < 64; y++) {
      const yTop = y + 0.5
      const [x, yBottom] = webglFragCoordCPU([0.5, yTop], FRAMEBUFFER_HEIGHT)
      for (let i = 0; i < 256; i++) {
        const px = i + 0.5
        const raw = ign(px, yTop)
        const converted = ign(px, yBottom)
        void x
        n++
        sum += raw
        sumSq += raw * raw
        sumOther += converted
        sumOtherSq += converted * converted
        sumCross += raw * converted
      }
    }
    const mean = sum / n
    const meanOther = sumOther / n
    const correlation =
      (sumCross - n * mean * meanOther) /
      Math.sqrt(
        (sumSq - n * mean * mean) * (sumOtherSq - n * meanOther * meanOther)
      )

    log('seed-row-correlation', [
      {
        field: 'pearson(ign at top-first row, ign at bottom-first row)',
        expected: '~0, i.e. unrelated seeds',
        actual: +correlation.toFixed(6)
      },
      { field: 'pixels sampled', expected: '> 1000', actual: n }
    ])

    expect(Math.abs(correlation)).toBeLessThan(0.05)
  })

  it('the sampler emits the mirrored row into the seed', async () => {
    // The CPU twin above cannot see whether the SHADER uses it. This reads the
    // generated WGSL, where the mirror is an explicit subtraction of the
    // framebuffer height from the coordinate the noise is seeded with
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const {
      Fn: tslFn,
      float,
      texture,
      uniform,
      uniformArray,
      vec3
    } = await import('three/tsl')

    const atlas = new DataArrayTexture(
      new Uint8Array(4 * 4 * CASCADES * 4),
      4,
      4,
      CASCADES
    )
    const transmittance = createCloudShadowTransmittance(
      {
        mapNode: texture(atlas),
        // The descriptor also carries the live handles the pass keeps in sync;
        // this build only reads through mapNode
        map: atlas,
        mapSize: new Vector2(4, 4),
        texelSize: uniform(new Vector2(1 / 4, 1 / 4)),
        intervals: uniformArray(
          Array.from({ length: CASCADES }, () => new Vector2(0, 1))
        ),
        matrices: uniformArray(
          Array.from({ length: CASCADES }, () => new Matrix4())
        ),
        inverseMatrices: uniformArray(
          Array.from({ length: CASCADES }, () => new Matrix4())
        ),
        far: uniform(1e5),
        topHeight: uniform(3000),
        cascadeCount: CASCADES,
        cascadeCountNode: uniform(CASCADES, 'int')
      },
      {
        viewMatrix: uniform(new Matrix4()),
        cameraNear: uniform(1),
        sunDirection: uniform(new Vector3(0, 0, 1)),
        bottomRadius: uniform(6360000),
        ecefToWorldMatrix: uniform(new Matrix4()),
        altitudeCorrection: uniform(new Vector3()),
        worldToUnit: uniform(1 / 6360000),
        temporalJitter: uniform(new Vector2()),
        resolution: uniform(new Vector2(1280, 720))
      },
      { enabled: true }
    )

    // A radius past the point-sample early-out, so the PCF branch is the one
    // that gets emitted
    const node = tslFn(() =>
      transmittance(vec3(0, 6361000, 0), float(3), float(0.5))
    )()
    const { fragment } = compileWGSL(node)

    // The seed is the one place the coordinate is mirrored, so read the
    // statement that carries the interleaved-gradient coefficients and require
    // the row it is dotted against to be built from a height subtraction
    const seedStatement = fragment
      .split(';')
      .find(stmt => stmt.includes('0.06711056') && stmt.includes('0.00583715'))

    const MIRRORED_ROW =
      /fragCoord\s*\.\s*xy\s*\.\s*x\s*,\s*\(\s*[\w.]+\s*-\s*fragCoord\s*\.\s*xy\s*\.\s*y\s*\)/

    log('seed-row-wgsl', [
      {
        field: 'finds the seed statement',
        expected: true,
        actual: seedStatement != null
      },
      {
        field: 'seed row is the mirrored one',
        expected: true,
        actual: MIRRORED_ROW.test(seedStatement ?? '')
      },
      { field: 'wgsl chars', expected: '> 0', actual: fragment.length }
    ])

    expect(
      seedStatement,
      'the interleaved-gradient coefficients are absent, so this is not the ' +
        'site-2 seed path'
    ).toBeDefined()
    expect(
      MIRRORED_ROW.test(seedStatement!),
      'the seed is dotted against the raw top-first fragCoord, so every pixel ' +
        "reads the reference's seed from the mirrored row"
    ).toBe(true)

    // The control: the shape an unmirrored seed has, which the same regex
    // must not accept. Without it the pattern above could match anything
    const unmirrored =
      'dot( ( fragCoord.xy + v ), vec2<f32>( 0.06711056, 0.00583715 ) )'
    expect(MIRRORED_ROW.test(unmirrored)).toBe(false)
  })
})
