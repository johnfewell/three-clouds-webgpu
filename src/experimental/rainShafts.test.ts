// Rain shafts: the density law and the placement it shares with convection
// Each test has a CPU twin, because a mask pinned only by a WGSL snapshot can
// break in ways the snapshot does not show

import { uniform, vec2 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import { clouds } from '../CloudsPassNode'
import { createLayerUniforms, updateLayerUniforms } from '../layerUniforms'
import {
  createParameterUniforms,
  updateParameterUniforms
} from '../parameterUniforms'
import { cellMask, cellMaskCPU } from './convectiveProfile'
import { experimentalWarnings } from './options'
import {
  createRainShaftUniforms,
  RAIN_SHAFT_GROUND_FADE,
  RAIN_SHAFT_RAGGEDNESS,
  RAIN_SHAFT_STEP_COUNT,
  rainShaftCellCPU,
  rainShaftDefaults,
  rainShaftDensity,
  rainShaftDensityCPU,
  rainShaftDensityFromNoiseCPU,
  rainShaftNoiseCPU,
  updateRainShaftUniforms,
  type RainShaftDeps
} from './rainShafts'

interface PassInternals {
  rainShaftDeps: (
    ctx: unknown,
    layerU: unknown,
    paramU: unknown
  ) => RainShaftDeps | null
}

// The pass's own seam, driven the way CloudsPassNode drives it
function shaftDepsFrom(
  pass: ReturnType<typeof clouds>,
  ctx: ReturnType<typeof clouds>['cloudsContext']
): RainShaftDeps | null {
  const layerU = createLayerUniforms()
  updateLayerUniforms(layerU, ctx)
  const paramU = createParameterUniforms(ctx)
  updateParameterUniforms(paramU, ctx)
  return (pass as unknown as PassInternals).rainShaftDeps(ctx, layerU, paramU)
}

describe('rain shaft knobs', () => {
  it('ships the documented defaults, off', () => {
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    log('rain-shaft defaults', { ...ctx.rainShafts })
    table('rain-shaft-defaults', [
      { field: 'strength', expected: 0.75, actual: ctx.rainShafts.strength },
      { field: 'density', expected: 1.5e-4, actual: ctx.rainShafts.density },
      { field: 'slant', expected: 0.35, actual: ctx.rainShafts.slant },
      {
        field: 'the flag',
        expected: false,
        actual: ctx.experimental.rainShafts
      }
    ])
    expect(ctx.rainShafts).toEqual(rainShaftDefaults)
    expect(ctx.experimental.rainShafts).toBe(false)
  })

  it('hands out no deps until the flag is on, and uniforms once it is', () => {
    // The seam the byte-identity argument rests on: null emits no nodes, so the
    // digests prove the graph is untouched and this proves the gate is real
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    const off = shaftDepsFrom(pass, ctx)
    ctx.experimental = { rainShafts: true }
    ctx.rainShafts.strength = 0.25
    const on = shaftDepsFrom(pass, ctx)

    log('rain shaft seam', {
      offIsNull: off === null,
      onBuilt: on != null,
      strength: on?.uniforms.strength.value,
      steps: RAIN_SHAFT_STEP_COUNT
    })

    expect(off).toBeNull()
    expect(on).not.toBeNull()
    // The knobs are plain fields, so nothing bumps graphVersion: the write has
    // to happen here or the slider is dead after the first frame
    expect(on?.uniforms.strength.value).toBe(0.25)
  })

  it('updateRainShaftUniforms carries all three knobs', () => {
    const uniforms = createRainShaftUniforms(rainShaftDefaults)
    updateRainShaftUniforms(uniforms, {
      strength: 0.5,
      density: 2e-4,
      slant: 0
    })
    log('rain-shaft uniform write', {
      strength: uniforms.strength.value,
      density: uniforms.density.value,
      slant: uniforms.slant.value
    })
    expect(uniforms.strength.value).toBe(0.5)
    expect(uniforms.density.value).toBe(2e-4)
    expect(uniforms.slant.value).toBe(0)
  })
})

describe('the shaft is placed by the convective cell mask', () => {
  it('emits the same smoothstep over the same noise the cell mask does', () => {
    // A shaft hangs under the tower that made it, so both must threshold one
    // field with one pair of edges. Read on the emitted text rather than a
    // digest, because the numbers are uniforms and a digest cannot see them
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    ctx.experimental = { rainShafts: true }
    const deps = shaftDepsFrom(pass, ctx)!
    const shaftWGSL = normalizeWGSL(
      compileWGSL(deps.density(uniform(0.5), vec2(0.5, 0.5)), {
        width: 4,
        height: 4
      }).fragment
    )
    const cellWGSL = normalizeWGSL(
      compileWGSL(
        cellMask(vec2(0.5, 0.5), uniform(1), uniform(0.5), uniform(0.2)),
        { width: 4, height: 4 }
      ).fragment
    )
    // The emitted WGSL is minified and nests parentheses, so the calls are
    // extracted by counting depth. normalizeWGSL renames every uniform, so two
    // calls print the same text iff they are the same expression
    const calls = (wgsl: string, name: string): string[] => {
      const found: string[] = []
      for (
        let at = wgsl.indexOf(name);
        at !== -1;
        at = wgsl.indexOf(name, at + 1)
      ) {
        let depth = 0
        for (let i = at + name.length - 1; i < wgsl.length; i++) {
          if (wgsl[i] === '(') depth++
          else if (wgsl[i] === ')' && --depth === 0) {
            found.push(wgsl.slice(at, i + 1))
            break
          }
        }
      }
      return found
    }
    const shaftSmoothsteps = calls(shaftWGSL, 'smoothstep(')
    const cellSmoothsteps = calls(cellWGSL, 'smoothstep(')
    const perlinCalls = (wgsl: string) =>
      calls(wgsl, 'mx_perlin_noise_float_0(')
    // smoothstep's first two arguments are its iso-contour level and width, so
    // they are the whole claim: same edges over the same noise. Split at
    // commas that are not inside a parenthesis, which a regex cannot do
    const edges = (call: string): string[] => {
      const args: string[] = []
      let depth = 0
      let start = call.indexOf('(') + 1
      for (let i = start; i < call.length; i++) {
        if (call[i] === '(') depth++
        else if (call[i] === ')') {
          if (depth === 0) {
            args.push(call.slice(start, i).trim())
            return args.slice(0, 2)
          }
          depth--
        } else if (call[i] === ',' && depth === 0) {
          args.push(call.slice(start, i).trim())
          if (args.length === 2) return args
          start = i + 1
        }
      }
      return args
    }

    log('cell mask provenance', {
      shaftSmoothsteps: shaftSmoothsteps.length,
      cellSmoothsteps: cellSmoothsteps.length,
      shaftPerlinCalls: perlinCalls(shaftWGSL).length,
      cellPerlinCalls: perlinCalls(cellWGSL).length,
      shaftCellEdges: edges(shaftSmoothsteps[0]!),
      cellEdges: edges(cellSmoothsteps[0]!)
    })

    // One Perlin lattice each, so it is the same field. The third argument
    // differs by construction: the shaft hoists the noise into a var because
    // the ragged term reuses it, while the mask inlines the call
    expect(shaftWGSL).toContain('floor(')
    expect(cellWGSL).toContain('floor(')
    expect(perlinCalls(shaftWGSL)).toHaveLength(1)
    expect(perlinCalls(cellWGSL)).toHaveLength(1)
    // normalizeWGSL folds only unnamed uniforms, and the shaft's are named, so
    // every uniform read is folded here as normalizeWGSL did before naming
    const role = (edge: string) => edge.replace(/\bobject\.\w+/g, 'object.U')
    expect(edges(shaftSmoothsteps[0]!).map(role)).toEqual(
      edges(cellSmoothsteps[0]!).map(role)
    )
    // and the hoisted noise the shaft smoothsteps is the Perlin itself
    expect(shaftSmoothsteps[0]).toContain('nodeVarN')
  })

  it('the cell term is the mask CPU twin, shifted by that twin own pivot', () => {
    // cellMaskCPU adds 0.5 to the noise before thresholding and the shader does
    // not, a divergence its own comment calls out. What has to hold is the shape

    const noise = rainShaftNoiseCPU(0.37, 0.11, 4)
    const threshold = 0.52
    const softness = 0.22
    const shader = rainShaftCellCPU(noise, threshold, softness)
    const shifted = rainShaftCellCPU(noise + 0.5, threshold, softness)

    log('cell term vs the mask twin', {
      noise,
      shaftCell: shader,
      maskTwinCell: cellMaskCPU(0.37, 0.11, 4, threshold + 0.5, softness),
      shaftCellAtShiftedNoise: shifted
    })

    expect(rainShaftCellCPU(-1, threshold, softness)).toBe(0)
    expect(rainShaftCellCPU(1, threshold, softness)).toBe(1)
    // The same smoothstep, evaluated at the noise each side reads
    expect(shifted).toBe(cellMaskCPU(0.37, 0.11, 4, threshold, softness))
  })
})

describe('rain shaft density', () => {
  const p = rainShaftDefaults
  // The convective cell defaults, which is where the shaft reads its mask from
  const CELL_THRESHOLD = 0.52
  const CELL_SOFTNESS = 0.22
  const at = (noise: number, heightFraction: number) =>
    rainShaftDensityFromNoiseCPU(
      noise,
      CELL_THRESHOLD,
      CELL_SOFTNESS,
      heightFraction,
      p.strength,
      p.density
    )

  it('is zero outside every cell and rises inside one', () => {
    const rows = [-0.6, 0.0, 0.52, 0.6, 0.9].map(noise => ({
      noise,
      density: at(noise, 1)
    }))
    log('density vs cell noise', rows)
    expect(rows[0]!.density).toBe(0)
    expect(rows[1]!.density).toBe(0)
    // At the threshold the mask is exactly 0, above it the value rises
    expect(rows[3]!.density).toBeGreaterThan(0)
    expect(rows[4]!.density).toBeGreaterThan(rows[3]!.density)
  })

  it('thins toward the ground and is full just under the base', () => {
    const ground = at(0.9, 0)
    // Half way through the 15% softness ramp, so the taper is inside it
    const ramp = at(0.9, 0.075)
    const base = at(0.9, 1)
    const above = at(0.9, 4)

    table('rain shaft vertical profile', [
      { field: 'at the ground', expected: 'thinnest', actual: ground },
      { field: 'mid-ramp', expected: 'between', actual: ramp },
      { field: 'at the base', expected: 'thickest', actual: base },
      {
        field: 'above the base',
        expected: base,
        actual: above,
        delta: Math.abs(above - base)
      }
    ])

    expect(ground).toBeGreaterThan(0)
    expect(ramp).toBeGreaterThan(ground)
    expect(base).toBeGreaterThan(ramp)
    // Clamped, so a sample above the band cannot brighten the shaft
    expect(above).toBeCloseTo(base, 12)
  })

  it('gives the ground exactly the documented fraction of the base', () => {
    const ratio = at(0.9, 0) / at(0.9, 1)
    log('ground fade', {
      expected: RAIN_SHAFT_GROUND_FADE,
      actual: ratio,
      delta: Math.abs(ratio - RAIN_SHAFT_GROUND_FADE)
    })
    expect(ratio).toBeCloseTo(RAIN_SHAFT_GROUND_FADE, 12)
  })

  it('is zero at strength zero, and linear in strength and density', () => {
    const base = rainShaftDensityFromNoiseCPU(0.9, 0.52, 0.22, 1, 1, 1)
    log('density scaling', {
      base,
      halfStrength: rainShaftDensityFromNoiseCPU(0.9, 0.52, 0.22, 1, 0.5, 1),
      off: rainShaftDensityFromNoiseCPU(0.9, 0.52, 0.22, 1, 0, 1)
    })
    expect(rainShaftDensityFromNoiseCPU(0.9, 0.52, 0.22, 1, 0, 1)).toBe(0)
    expect(
      rainShaftDensityFromNoiseCPU(0.9, 0.52, 0.22, 1, 0.5, 1)
    ).toBeCloseTo(base * 0.5, 18)
    expect(rainShaftDensityFromNoiseCPU(0.9, 0.52, 0.22, 1, 1, 2)).toBeCloseTo(
      base * 2,
      18
    )
  })

  it('is a physical extinction: 0.3 of optical depth over a 2 km column', () => {
    // The number the knob was picked for, stated so a retune has to change it
    const perMetre = rainShaftDensityFromNoiseCPU(
      0.9,
      0.52,
      0.22,
      1,
      p.strength,
      p.density
    )
    const opticalDepth = perMetre * 2000
    log('column optical depth', {
      extinctionPerMetre: perMetre,
      opticalDepthOver2km: opticalDepth,
      transmittanceOver2km: Math.exp(-opticalDepth)
    })
    expect(opticalDepth).toBeGreaterThan(0.15)
    expect(opticalDepth).toBeLessThan(0.5)
  })

  it('carries a ragged edge from the mask field it already sampled', () => {
    // The ragged term multiplies the mask by the same noise, so it can only
    // thin a cell, never deepen it
    const rows = [-0.4, 0.0, 0.6, 0.74].map(noise => {
      const cell = rainShaftCellCPU(noise, 0.52, 0.22)
      return {
        noise,
        cell,
        density: rainShaftDensityFromNoiseCPU(
          noise,
          0.52,
          0.22,
          1,
          p.strength,
          p.density
        )
      }
    })
    log('ragged edge', rows)
    expect(RAIN_SHAFT_RAGGEDNESS).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.density).toBeLessThanOrEqual(row.cell * p.strength * p.density)
    }
    // A real term, not a no-op left at zero: deep inside a cell the noise is
    // high, and the ragged factor pulls the density below the plain cell value
    const solid = rows[rows.length - 1]!
    expect(solid.density).toBeLessThan(solid.cell * p.strength * p.density)
  })

  it('is composed of the noise and the density the shader reads', () => {
    const composed = rainShaftDensityCPU(
      0.31,
      0.77,
      8,
      0.52,
      0.22,
      0.4,
      p.strength,
      p.density
    )
    const direct = rainShaftDensityFromNoiseCPU(
      rainShaftNoiseCPU(0.31, 0.77, 8),
      0.52,
      0.22,
      0.4,
      p.strength,
      p.density
    )
    log('twin composition', { composed, direct })
    expect(composed).toBe(direct)
  })

  it('compiles to WGSL with the cell lattice and no texture sample', () => {
    // Pure ALU on purpose: an implicit-LOD sample inside the march loop returns
    // zeros on Dawn, which reads as the feature being off rather
    // than as a bug
    const result = compileWGSL(
      rainShaftDensity(
        vec2(4, 4),
        uniform(0.52),
        uniform(0.22),
        uniform(0.5),
        uniform(0.75),
        uniform(1.5e-4)
      ),
      { width: 4, height: 4 }
    )
    const wgsl = normalizeWGSL(result.fragment)
    log('density WGSL', {
      bytes: wgsl.length,
      perlinLattice: wgsl.includes('floor('),
      textureSample: wgsl.includes('textureSample'),
      boundTextures: result.boundTextures.length
    })
    expect(wgsl).toContain('smoothstep(')
    expect(wgsl).toContain('floor(')
    expect(wgsl).not.toContain('textureSample')
    expect(result.boundTextures).toHaveLength(0)
  })

  it('warns when it is on without the shadow length it reads', () => {
    // Documented limitation, reported rather than fixed, as the other
    // experimental warnings are: without lightShafts there is no marched cloud
    // path to the sun, so the shafts would be lit under the cell that made them
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    ctx.experimental = { rainShafts: true }
    const warn = (lightShafts: boolean) =>
      experimentalWarnings({
        experimental: ctx.experimental,
        debug: ctx.debug,
        castsShadow: ctx.cloudLayers.castsShadow,
        localWeatherVelocity: ctx.localWeatherVelocity,
        lightShafts
      }).map(warning => warning.id)

    log('rain shaft warning', {
      withoutLightShafts: warn(false),
      withLightShafts: warn(true)
    })

    expect(warn(false)).toEqual(['rainShafts/noLightShafts'])
    expect(warn(true)).toEqual([])
  })

  it('carries slant as a uniform, so leaning costs no rebuild', () => {
    // Stated rather than asserted the other way round: the lean is an offset
    // added to the mask uv, so the emitted graph is the same whatever the value
    // and a caller who animates the lean never triggers a graph rebuild
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    ctx.experimental = { rainShafts: true }
    ctx.rainShafts.slant = 0.9
    const deps = shaftDepsFrom(pass, ctx)!

    log('slant uniform', {
      requested: ctx.rainShafts.slant,
      uploaded: deps.uniforms.slant.value
    })

    expect(deps.uniforms.slant.value).toBe(0.9)
  })
})
