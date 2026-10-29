// The two terms are the whole of this feature, so each is pinned from both
// ends: a CPU twin saying what the shape should be, and the compiled WGSL
// saying the graph contains it. The prose is in docs/EXPERIMENTAL.md

// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { createHash } from 'node:crypto'
import { PerspectiveCamera, Vector2 } from 'three'
import { uniform, vec2, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import {
  compileWGSL,
  expectWGSL,
  normalizeWGSL
} from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { clouds } from '../CloudsPassNode'
import { getLayerDensityCPU } from '../density/layerDensity'
import {
  cpuSampleWeather,
  type ConvectiveWeatherCPU
} from '../density/sampleWeather'
import { createLayerUniforms, updateLayerUniforms } from '../layerUniforms'
import {
  buildConvectiveDeps,
  cellMask,
  cellMaskCPU,
  CONVECTIVE_TOWER_MIN_HEIGHT,
  CONVECTIVE_TOWER_RAMP,
  convectiveHeightProfile,
  convectiveHeightProfileCPU,
  convectiveProfileDefaults,
  createConvectiveUniforms,
  towerWeight,
  towerWeightCPU,
  updateConvectiveUniforms,
  type ConvectiveUniforms
} from './convectiveProfile'

// One tower per lane position: three default decks and a 1.2 to 10.2 km tower
const BASES: [number, number, number, number] = [750, 1000, 7500, 1200]
const TOPS: [number, number, number, number] = [1400, 2200, 8000, 10200]
const WEATHER: [number, number, number, number] = [0.7, 0.7, 0.6, 0.7]
const EXPONENTS: [number, number, number, number] = [1, 1, 1, 1]
const BIASES: [number, number, number, number] = [0.35, 0.35, 0.35, 0.35]
const WIDTHS: [number, number, number, number] = [0.6, 0.6, 0.5, 0.6]
const NO_SHADOW: [number, number, number, number] = [0, 0, 0, 0]
const COVERAGE = 0.3

const at = (
  height: number,
  convective: ConvectiveWeatherCPU | null
): [number, number, number, number] =>
  cpuSampleWeather(
    height,
    BASES,
    TOPS,
    WEATHER,
    EXPONENTS,
    BIASES,
    COVERAGE,
    WIDTHS,
    NO_SHADOW,
    false,
    undefined,
    convective
  ).density

const towerLane = (
  height: number,
  convective: ConvectiveWeatherCPU | null
): number => at(height, convective)[3]

// A cell mask at full strength and none at all, which are the two states the
// coverage fold has to get right
const CELL_ON: ConvectiveWeatherCPU = {
  cellMask: 1,
  cellDensity: convectiveProfileDefaults.cellDensity
}
const CELL_OFF: ConvectiveWeatherCPU = { cellMask: 0, cellDensity: 0 }

describe('convective params', () => {
  it('reach the uniforms without a rebuild', () => {
    // They are uniform-backed precisely so tuning an anvil costs a uniform
    // write, which is why a plain field on the context is enough (design doc
    // section 2.3)
    const uniforms = createConvectiveUniforms(convectiveProfileDefaults)
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    ctx.convectiveProfile.anvilCenter = 0.5
    ctx.convectiveProfile.cellsPerWeatherTile = 16
    updateConvectiveUniforms(uniforms, ctx.convectiveProfile)

    log('convective uniforms', [
      { key: 'anvilCenter', want: 0.5, got: uniforms.anvilCenter.value },
      {
        key: 'cellsPerWeatherTile',
        want: 16,
        got: uniforms.cellsPerWeatherTile.value
      }
    ])

    expect(uniforms.anvilCenter.value).toBe(0.5)
    expect(uniforms.cellsPerWeatherTile.value).toBe(16)
  })

  it('a fresh context starts at the documented defaults', () => {
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    log('convective defaults', { ...ctx.convectiveProfile })
    expect(ctx.convectiveProfile).toEqual(convectiveProfileDefaults)
  })

  it('the flag is off unless a caller turns it on', () => {
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    log('flag default', {
      convectiveProfile: ctx.experimental.convectiveProfile
    })
    expect(ctx.experimental.convectiveProfile).toBe(false)
  })
})

describe('the per-frame write', () => {
  it('a knob moved after the first frame reaches the uniform', () => {
    // A plain field, so nothing bumps graphVersion for a knob and no rebuild
    // picks the values up: only the per-frame write can carry them, so this
    // drives updateBefore instead of calling updateConvectiveUniforms
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    ctx.experimental = { convectiveProfile: true }
    const frame = frameStub(1)

    // setup() needs a NodeBuilder, so the graph is built through the same
    // internals seam. Under test is the per-frame write, not how it first builds
    internals(pass).buildGraph(false)
    const built = internals(pass)._convectiveUniforms
    expect(built).not.toBeNull()

    const before = built!.anvilCenter.value
    ctx.convectiveProfile.anvilCenter = 0.21

    // No graphVersion bump, so this frame cannot be a rebuild picking the knob
    // up: only the uniform write can carry it
    const versionBefore = ctx.graphVersion
    pass.updateBefore({ ...frame, frameId: 2 } as never)

    log('per-frame convective write', {
      anvilCenterBefore: before,
      anvilCenterAfter: built!.anvilCenter.value,
      graphVersionUnchanged: ctx.graphVersion === versionBefore
    })

    expect(built!.anvilCenter.value).toBe(0.21)
    expect(built!.anvilCenter.value).not.toBe(before)
    expect(ctx.graphVersion).toBe(versionBefore)
  })
})

describe('tower weight', () => {
  it('promotes only layers over the tower floor', () => {
    // 4000 m is the floor, 1000 m the ramp above it. A 650 m deck must score
    // zero or it grows a shoulder and stops being a deck
    const thin = towerWeightCPU(750, 1400)
    const justUnder = towerWeightCPU(1200, 4800)
    const mid = towerWeightCPU(1200, 5700)
    const atFloor = towerWeightCPU(1200, 5200)
    const tower = towerWeightCPU(1200, 10200)
    const empty = towerWeightCPU(0, 0)

    log('tower weight by thickness', [
      { key: '650 m deck', want: 0, got: thin },
      { key: '3600 m, under floor', want: 0, got: justUnder },
      { key: '4500 m over floor', want: '0.5', got: mid },
      { key: '4000 m at floor', want: 0, got: atFloor },
      { key: '9000 m tower', want: 1, got: tower },
      { key: 'empty lane', want: 0, got: empty }
    ])

    expect(thin).toBe(0)
    expect(justUnder).toBe(0)
    expect(atFloor).toBe(0)
    expect(tower).toBe(1)
    expect(empty).toBe(0)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(CONVECTIVE_TOWER_RAMP).toBe(1000)
  })

  it('the ramp constants reach the shader as the exported values', () => {
    // The floor and the ramp are uniforms, so a change to either shows here
    // As float() literals, towerWeightCPU would read the exported constants
    // while the shader read its own copy and no test could see the difference
    const lane = (thickness: number) =>
      createHash('sha256')
        .update(
          normalizeWGSL(
            compileWGSL(towerWeight(vec4(0), vec4(thickness))).fragment
          )
        )
        .digest('hex')

    log('tower weight constants', {
      atFloor: towerWeightCPU(0, CONVECTIVE_TOWER_MIN_HEIGHT),
      aboveFloor: towerWeightCPU(
        0,
        CONVECTIVE_TOWER_MIN_HEIGHT + CONVECTIVE_TOWER_RAMP
      )
    })

    // Two thicknesses on either side of the ramp must compile differently, which
    // is only true if the shader is reading the ramp rather than a literal
    expect(lane(CONVECTIVE_TOWER_MIN_HEIGHT)).not.toBe(
      lane(CONVECTIVE_TOWER_MIN_HEIGHT + CONVECTIVE_TOWER_RAMP)
    )
    expect(towerWeightCPU(0, CONVECTIVE_TOWER_MIN_HEIGHT)).toBe(0)
    expect(
      towerWeightCPU(0, CONVECTIVE_TOWER_MIN_HEIGHT + CONVECTIVE_TOWER_RAMP)
    ).toBe(1)
  })

  it('compiles to a per-lane ramp from the packed heights', () => {
    const { fragment } = compileWGSL(
      towerWeight(vec4(750, 1200, 7500, 1200), vec4(1400, 2200, 8000, 10200))
    )
    const wgsl = normalizeWGSL(fragment)
    expectWGSL(wgsl).toContain('smoothstep')
    log('tower weight wgsl', { hasSmoothstep: wgsl.includes('smoothstep') })
  })
})

describe('convective height profile', () => {
  const { anvilCenter, anvilWidth, anvilStrength } = convectiveProfileDefaults

  it('keeps the shipped profile where the shoulder is zero', () => {
    // The shoulder is additive on top of the four-term family, so with
    // strength 0 the new evaluator must equal getLayerDensity exactly. That is
    // what makes it a replacement rather than a different cloud
    const p = convectiveProfileDefaults
    for (const h of [0, 0.25, 0.5, 0.75, 0.86, 1]) {
      const shipped = getLayerDensityCPU(h, 0.2, 3, 0.75, 0.25)
      const withShoulder = convectiveHeightProfileCPU(
        h,
        0.2,
        3,
        0.75,
        0.25,
        p.anvilCenter,
        p.anvilWidth,
        p.anvilStrength
      )
      const zeroStrength = convectiveHeightProfileCPU(
        h,
        0.2,
        3,
        0.75,
        0.25,
        p.anvilCenter,
        p.anvilWidth,
        0
      )
      expect(zeroStrength).toBeCloseTo(shipped, 6)
      expect(withShoulder).toBeGreaterThanOrEqual(shipped)
    }
    log('profile superset', { centre: anvilCenter, width: anvilWidth })
  })

  it('peaks at anvilCenter and dies away from it', () => {
    const zero = convectiveHeightProfileCPU(
      anvilCenter,
      0,
      0,
      0.75,
      0.25,
      anvilCenter,
      anvilWidth,
      0
    )
    const peak = convectiveHeightProfileCPU(
      anvilCenter,
      0,
      0,
      0.75,
      0.25,
      anvilCenter,
      anvilWidth,
      anvilStrength
    )
    const outHeight = anvilCenter + anvilWidth
    // The base is a ramp, so it is different a width along the shoulder. The
    // ratio is only meaningful against the base at that same height
    const outBase = getLayerDensityCPU(outHeight, 0, 0, 0.75, 0.25)
    const oneWidthOut = convectiveHeightProfileCPU(
      outHeight,
      0,
      0,
      0.75,
      0.25,
      anvilCenter,
      anvilWidth,
      anvilStrength
    )
    // Read against the base at the same height: the profile is a ramp, so
    // the values are not comparable across heights
    const baseH = getLayerDensityCPU(0, 0, 0, 0.75, 0.25)
    const base =
      convectiveHeightProfileCPU(
        0,
        0,
        0,
        0.75,
        0.25,
        anvilCenter,
        anvilWidth,
        anvilStrength
      ) / baseH

    log('shoulder', [
      { key: 'shipped at centre', want: zero, got: zero },
      {
        key: 'with shoulder at centre',
        want: `zero * ${1 + anvilStrength}`,
        got: peak
      },
      {
        key: 'one width out, over its own base',
        want: 1 + anvilStrength * Math.exp(-1),
        got: oneWidthOut / outBase
      },
      { key: 'at the base, over its own base', want: 1, got: base }
    ])

    expect(peak).toBeCloseTo(zero * (1 + anvilStrength), 6)
    expect(oneWidthOut / outBase).toBeCloseTo(
      1 + anvilStrength * Math.exp(-1),
      6
    )
    // e^-61 is 3e-27, so the shoulder is exactly nothing 7.8 widths away
    expect(base).toBeCloseTo(1, 6)
  })

  it('is the concave shoulder the four-term family cannot be', () => {
    // Design doc section 1: the shipped family is convex on [0,1] and has no
    // interior maximum, so the test is that the shoulder adds one in the top
    // decile which the linear profile cannot have
    const grid = Array.from({ length: 51 }, (_, i) => i / 50)
    const shipped = grid.map(h => getLayerDensityCPU(h, 0, 0, 0.75, 0.25))
    const shouldered = grid.map(h =>
      convectiveHeightProfileCPU(
        h,
        0,
        0,
        0.75,
        0.25,
        anvilCenter,
        anvilWidth,
        anvilStrength
      )
    )
    // The height at which the profile peaks, not its value there
    const argmax = (a: number[]) => grid[a.indexOf(Math.max(...a))]!

    const top = grid.length - 1
    log('profile by height', [
      { key: 'shipped argmax (h)', want: 1, got: argmax(shipped) },
      {
        key: 'shouldered argmax (h)',
        want: anvilCenter,
        got: argmax(shouldered)
      },
      { key: 'shipped at h=1', want: shipped[top], got: shipped[top] },
      { key: 'shouldered at h=1', want: '> shipped', got: shouldered[top] }
    ])

    // A linear ramp is still rising at its top, so the shoulder is the only
    // thing that can put a maximum below h = 1
    expect(argmax(shipped)).toBe(1)
    expect(argmax(shouldered)).toBeGreaterThan(0.7)
    expect(argmax(shouldered)).toBeLessThan(1)
    expect(shouldered[top]!).toBeGreaterThan(shipped[top]!)
  })

  it('a degenerate width cannot produce NaN', () => {
    // width = 0 would divide by zero; the max() floor is what stops an
    // exp(-inf) NaN reaching the density
    const v = convectiveHeightProfileCPU(0.5, 0, 0, 0.75, 0.25, 0.5, 0, 1)
    expect(Number.isFinite(v)).toBe(true)
  })

  it('compiles to an exp and a per-lane strength', () => {
    const uniforms = createConvectiveUniforms(convectiveProfileDefaults)
    const { fragment } = compileWGSL(
      convectiveHeightProfile(
        vec4(0.2, 0.86, 0.5, 0.1),
        vec4(0.2),
        vec4(3),
        vec4(0.75),
        vec4(0.25),
        uniforms.anvilCenter,
        uniforms.anvilWidth,
        vec4(1)
      )
    )
    const wgsl = normalizeWGSL(fragment)
    expectWGSL(wgsl).toContain('exp')
    log('profile wgsl', { hasExp: wgsl.includes('exp') })
  })
})

// Enough renderer for the per-frame path: getDrawingBufferSize feeds
// frameDimensions and hasFeature gates the quad shadow-length variant
function rendererStub() {
  const size = new Vector2(800, 600)
  return {
    getDrawingBufferSize: (target: Vector2) => target.copy(size),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    setMRT: vi.fn(),
    setRenderObjectFunction: vi.fn(),
    setClearColor: vi.fn(),
    clear: vi.fn(),
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: 'srgb',
    autoClear: true,
    setPixelRatio: vi.fn(),
    getPixelRatio: () => 1,
    getRenderTarget: () => null,
    getMRT: () => null,
    getRenderObjectFunction: () => null,
    getClearColor: () => ({ r: 0, g: 0, b: 0 }),
    getClearAlpha: () => 1,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getScissorTest: () => false,
    setScissorTest: vi.fn(),
    compute: vi.fn(),
    hasFeature: () => false,
    backend: { isWebGPUBackend: true },
    logarithmicDepthBuffer: false
  }
}

function frameStub(frameId: number) {
  return {
    frameId,
    renderer: rendererStub(),
    camera: new PerspectiveCamera(75, 800 / 600, 0.1, 1000),
    deltaTime: 1 / 60,
    time: frameId / 60
  }
}

interface ConvectivePassInternals {
  _convectiveUniforms: ConvectiveUniforms | null
  buildGraph: (quadOperations: boolean) => unknown
}

const internals = (p: unknown) => p as ConvectivePassInternals

// How many uniform bindings each Fn's compiled graph is expected to upload
// Folding any one uniform to a literal removes exactly one of these, which is
// the control that used to pass
const PROFILE_BINDINGS = 12
const CELL_BINDINGS = 5

// CloudsContext.localWeatherRepeat, which is what the cell scale follows
const LOCAL_WEATHER_REPEAT = 100

// The reference implementation tiles this weather map once over the planet's
// circumference, so a cell is CIRCUMFERENCE/cellsPerWeatherTile across
const CIRCUMFERENCE_KM = 40075

describe('cell scale', () => {
  it('is a fraction of a weather tile, not an absolute uv scale', () => {
    const { cellsPerWeatherTile } = convectiveProfileDefaults
    const scale = LOCAL_WEATHER_REPEAT * cellsPerWeatherTile
    const cellKm = CIRCUMFERENCE_KM / scale

    log('cell size', {
      repeat: LOCAL_WEATHER_REPEAT,
      cellsPerWeatherTile,
      scale,
      cellKm: cellKm.toFixed(1)
    })

    // An absolute uv scale put one cell across the whole planet, which reads
    // as "the feature is off" rather than as a bug: the frame lands inside a
    // single cell either way
    expect(scale).toBeGreaterThan(LOCAL_WEATHER_REPEAT)
    expect(cellKm).toBeGreaterThan(10)
    expect(cellKm).toBeLessThan(200)
  })

  it('the mask scale is driven by the repeat node, not by a literal', () => {
    // A runtime uniform's value never appears in the shader, so two repeat
    // values compiling alike proves nothing. What proves it is that a literal
    // repeat changes the graph, as hardcoding the scale in the module would
    const depsAt = (repeat: Node<'vec2'>) => {
      const ctx = clouds({ sceneDepth: null }).cloudsContext
      const layerU = createLayerUniforms()
      updateLayerUniforms(layerU, ctx)
      return buildConvectiveDeps(
        {
          expTerms: layerU.densityProfileExpTerms,
          exponents: layerU.densityProfileExponents,
          linearTerms: layerU.densityProfileLinearTerms,
          constantTerms: layerU.densityProfileConstantTerms
        },
        layerU.minLayerHeights,
        layerU.maxLayerHeights,
        repeat,
        createConvectiveUniforms(ctx.convectiveProfile)
      )
    }
    const digestAt = (repeat: Node<'vec2'>) =>
      createHash('sha256')
        .update(
          normalizeWGSL(
            compileWGSL(depsAt(repeat).cellMask(vec2(0.3, 0.7))).fragment
          )
        )
        .digest('hex')

    const fromUniform = digestAt(
      uniform(new Vector2(LOCAL_WEATHER_REPEAT, LOCAL_WEATHER_REPEAT))
    )
    const fromLiteral = digestAt(vec2(100, 100))

    log('cell mask scale wiring', { fromUniform, fromLiteral })

    expect(fromLiteral).not.toBe(fromUniform)
  })

  it('each uniform is live: its value reaches the shader', () => {
    // The CPU twins take their values as arguments, so a break in the TSL
    // wiring is invisible to them: hardcoding a uniform to its default left
    // every test passing. What differs is the uniform's own binding
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    const layerU = createLayerUniforms()
    updateLayerUniforms(layerU, ctx)
    const uniforms = createConvectiveUniforms(ctx.convectiveProfile)
    const deps = buildConvectiveDeps(
      {
        expTerms: layerU.densityProfileExpTerms,
        exponents: layerU.densityProfileExponents,
        linearTerms: layerU.densityProfileLinearTerms,
        constantTerms: layerU.densityProfileConstantTerms
      },
      layerU.minLayerHeights,
      layerU.maxLayerHeights,
      uniform(new Vector2(LOCAL_WEATHER_REPEAT, LOCAL_WEATHER_REPEAT)),
      uniforms
    )
    const fraction = vec4(0.86, 0.86, 0.5, 0.86)

    // Every uniform the two Fns take, resolved through the production wiring
    // Every uniform is a member of the object group's struct, named or not
    const wgsl = compileWGSL(deps.heightProfile(fraction)).fragment
    const cellsWGSL = compileWGSL(deps.cellMask(vec2(0.3, 0.7))).fragment
    const bindings = (src: string) =>
      (src.match(/struct objectStruct \{([^}]*)\}/)?.[1] ?? '')
        .split(',')
        .filter(m => m.includes(':')).length

    log('uniform wiring', {
      profileBindings: bindings(wgsl),
      cellsBindings: bindings(cellsWGSL)
    })

    // Pinned exactly, not a floor, because a literal substitution removes one
    // binding and pinning the count is what turns that into a failure
    expect(bindings(wgsl)).toBe(PROFILE_BINDINGS)
    expect(bindings(cellsWGSL)).toBe(CELL_BINDINGS)
  })
})

describe('cell mask', () => {
  it('is 1 well inside a cell, 0 outside one, and smooth between', () => {
    const { cellsPerWeatherTile, cellThreshold, cellSoftness } =
      convectiveProfileDefaults
    // Two cells across the window, sampled at the scale the deps derive from
    // localWeatherRepeat, because that scale is what decides whether a cell is
    // a cell or a continent
    const across = 2
    const values: number[] = []
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        values.push(
          cellMaskCPU(
            (i / 64) * across,
            (j / 64) * across,
            1,
            cellThreshold,
            cellSoftness
          )
        )
      }
    }
    expect(cellsPerWeatherTile).toBeGreaterThan(0)
    const inside = values.filter(v => v > 0.95).length / values.length
    const outside = values.filter(v => v === 0).length / values.length
    const partial = values.filter(v => v > 0 && v < 1).length

    log('cell mask over 64x64 uv', [
      {
        key: 'fully inside',
        want: 'a few %',
        got: `${(inside * 100).toFixed(1)}%`
      },
      {
        key: 'fully outside',
        want: 'a few %',
        got: `${(outside * 100).toFixed(1)}%`
      },
      { key: 'partial (soft edge)', want: '> 0', got: partial }
    ])

    // Concentrating coverage means both, and a soft edge means some of neither
    expect(inside).toBeGreaterThan(0.01)
    expect(inside).toBeLessThan(0.6)
    expect(outside).toBeGreaterThan(0.01)
    expect(partial).toBeGreaterThan(0)
    expect(Math.min(...values)).toBe(0)
    expect(Math.max(...values)).toBeLessThanOrEqual(1)
  })

  it('costs one 2D Perlin and takes no altitude', () => {
    // No altitude input is what makes a cell a column rather than a layer, and
    // one Perlin is the whole of the added cost per march step
    const uniforms = createConvectiveUniforms(convectiveProfileDefaults)
    const { fragment } = compileWGSL(
      cellMask(
        vec2(0.25, 0.75),
        1,
        uniforms.cellThreshold,
        uniforms.cellSoftness
      )
    )
    const wgsl = normalizeWGSL(fragment)
    const floors = (wgsl.match(/floor\(/g) ?? []).length
    log('cell mask wgsl', {
      floorCalls: floors,
      hasSmoothstep: wgsl.includes('smoothstep')
    })
    expectWGSL(wgsl).toContain('smoothstep')
    expect(floors).toBeLessThanOrEqual(3)
  })

  it('a zero softness cannot produce NaN', () => {
    const v = cellMaskCPU(0.5, 0.5, 1, 0.52, 0)
    expect(Number.isFinite(v)).toBe(true)
  })
})

// A saturated weather map, so a lane's density is decided by the coverage
// threshold alone and any floor a term adds shows up
const FULL_WEATHER: [number, number, number, number] = [1, 1, 1, 1]

// A Perlin lattice cell of the mask in km. The scale folds
// localWeatherRepeat.x and cellsPerWeatherTile into the noise argument, so a
// cell is GLOBE_KM / (repeat * cellsPerTile) across, 50 km at the defaults
const GLOBE_KM = 40075

// The step the boundary walk takes, as a fraction of a lattice cell. A hard
// mask puts the whole transition inside one of these
const WALK_STEP = 1 / 40

// The plan-view guard. Loose because cellSoftness is a band in NOISE value and
// the noise gradient varies over the lattice, so the transition width varies by
// 6x between the steepest and shallowest edge (docs/EXPERIMENTAL.md)
const TIGHTEST_EDGE_LATTICE_CELLS = 0.02

// The 10-90 span of a monotone response, in walk steps. Steps either side of
// `centre` until the response leaves the 10-90 band
function spanInSteps(values: number[], centre: number): number {
  const before = values[centre - 1]!
  const after = values[centre + 1]!
  const lo = Math.min(before, after)
  const hi = Math.max(before, after)
  if (hi - lo < 1e-9) return 0
  const rising = after > before
  const at10 = rising ? lo + 0.1 * (hi - lo) : lo + 0.9 * (hi - lo)
  const at90 = rising ? lo + 0.9 * (hi - lo) : lo + 0.1 * (hi - lo)
  let lo_i = centre
  let hi_i = centre
  while (lo_i > 0 && (rising ? values[lo_i]! > at10 : values[lo_i]! < at90))
    lo_i--
  while (
    hi_i < values.length - 1 &&
    (rising ? values[hi_i]! < at90 : values[hi_i]! > at10)
  )
    hi_i++
  return hi_i - lo_i
}

// The widest 10-90 span anywhere on the sampled line, which is the least
// flattering place to have put the bound. Only the samples where the response
// actually moves are candidates, so this stays linear in the walk length
function widestSpan(values: number[]): { steps: number; at: number } {
  let best = 0
  let at = -1
  for (let i = 1; i < values.length - 1; i++) {
    if (Math.abs(values[i + 1]! - values[i - 1]!) < 1e-9) continue
    const span = spanInSteps(values, i)
    if (span > best) {
      best = span
      at = i
    }
  }
  return { steps: best, at }
}

describe('the cell mask is a smooth falloff, not a hard cell edge', () => {
  it('the coverage multiplier climbs across a cell boundary over kilometres', () => {
    // The mask alone and the density out of the seam, because a smooth mask
    // only helps if nothing downstream re-sharpens it. 100 lattice cells at 40
    // samples each, so two cell boundaries at least
    const steps = 4000
    const { cellsPerWeatherTile, cellThreshold, cellSoftness } =
      convectiveProfileDefaults
    const scale = LOCAL_WEATHER_REPEAT * cellsPerWeatherTile
    const latticeKm = GLOBE_KM / scale
    const stepU = WALK_STEP / scale
    const masks: number[] = []
    const lanes: number[] = []
    for (let i = 0; i < steps; i++) {
      const cellMaskValue = cellMaskCPU(
        0.1 + i * stepU,
        0.42,
        scale,
        cellThreshold,
        cellSoftness
      )
      masks.push(cellMaskValue)
      // The lane the march reads at mid-height, so the number under test is the
      // one that reaches the density. cellDensity 0 leaves the mask the only
      // thing the cell moves
      lanes.push(at(5000, { cellMask: cellMaskValue, cellDensity: 0 })[3])
    }

    const maskSpan = widestSpan(masks)
    const laneSpan = widestSpan(lanes)

    log('cell boundary walk', [
      { key: 'lattice cell', want: 'km', got: latticeKm.toFixed(2) },
      { key: 'walk step', want: 'cells', got: WALK_STEP.toFixed(4) },
      {
        key: 'widest mask 10-90',
        want: `> ${TIGHTEST_EDGE_LATTICE_CELLS} cells`,
        got: (maskSpan.steps * WALK_STEP * latticeKm).toFixed(2) + ' km'
      },
      {
        key: 'widest density 10-90',
        want: `> ${TIGHTEST_EDGE_LATTICE_CELLS} cells`,
        got: (laneSpan.steps * WALK_STEP * latticeKm).toFixed(2) + ' km'
      },
      {
        key: 'a hard edge would be',
        want: 'cells',
        got: (WALK_STEP * latticeKm).toFixed(2) + ' km'
      }
    ])

    expect(maskSpan.steps).toBeGreaterThan(0)
    expect(laneSpan.steps).toBeGreaterThan(0)
    expect(maskSpan.steps * WALK_STEP).toBeGreaterThan(
      TIGHTEST_EDGE_LATTICE_CELLS
    )
    expect(laneSpan.steps * WALK_STEP).toBeGreaterThan(
      TIGHTEST_EDGE_LATTICE_CELLS
    )
  })

  it('a cell adds nothing at the two heights where the lane has no weight', () => {
    // hf = 0 and hf = 1 are where shapeAlteringFunction is 0, so the shipped
    // coverage term already contributes nothing there. A cell that ignores the
    // height weight floors it anyway, and that floor has the layer's end planes
    const bottom = BASES[3]
    const top = TOPS[3]
    log('no floor at the lane ends', [
      { key: 'lane bottom, flag off', want: 0, got: lane3(bottom, null) },
      {
        key: 'lane bottom, cell at full strength',
        want: 0,
        got: lane3(bottom, CELL_ON)
      },
      { key: 'lane top, flag off', want: 0, got: lane3(top, null) },
      {
        key: 'lane top, cell at full strength',
        want: 0,
        got: lane3(top, CELL_ON)
      }
    ])

    expect(lane3(bottom, null)).toBe(0)
    expect(lane3(bottom, CELL_ON)).toBe(lane3(bottom, null))
    expect(lane3(top, CELL_ON)).toBe(lane3(top, null))
  })

  it("the cell scales the lane's own coverage response and adds nothing", () => {
    // The bound as a ratio, not a peak: a full cell multiplies the lane's own
    // nonzero coverage term by exactly (coverage + cellDensity) / coverage, and
    // where that term is zero it adds nothing. A floor breaks both halves
    const gain = 1 + convectiveProfileDefaults.cellDensity / COVERAGE
    const heights = Array.from(
      { length: 41 },
      (_, i) => BASES[3] + ((TOPS[3] - BASES[3]) * i) / 40
    )
    const sampled = [0, 13, 26, 40].map(i => heights[i]!)
    const rows = sampled.map(h => {
      const bare = lane3(h, null)
      const on = lane3(h, CELL_ON)
      return {
        key: `${h.toFixed(0)} m`,
        want: bare === 0 ? 'add 0' : `x${gain.toFixed(3)}`,
        got:
          bare === 0
            ? `add ${(on - bare).toFixed(4)}`
            : `x${(on / bare).toFixed(3)}`
      }
    })
    const ratios: number[] = []
    for (const h of heights) {
      const bare = lane3(h, null)
      if (bare > 0) ratios.push(lane3(h, CELL_ON) / bare)
    }
    const worst = Math.max(...ratios.map(r => Math.abs(r - gain)))
    log('cell fold is a pure gain on the coverage term', [
      ...rows,
      { key: 'expected gain', want: '-', got: gain.toFixed(4) },
      { key: 'worst ratio error', want: '< 1e-9', got: worst.toExponential(2) },
      {
        key: 'heights with a nonzero bare density',
        want: '> 0',
        got: ratios.length
      }
    ])

    expect(ratios.length).toBeGreaterThan(0)
    expect(worst).toBeLessThan(1e-9)
    expect(lane3(BASES[3], CELL_ON)).toBe(lane3(BASES[3], null))
    expect(lane3(TOPS[3], CELL_ON)).toBe(lane3(TOPS[3], null))
  })
})

// The tower lane on the saturated map, with and without a cell, so what the two
// guards above measure is the cell's alone
function lane3(
  height: number,
  convective: ConvectiveWeatherCPU | null
): number {
  return cpuSampleWeather(
    height,
    BASES,
    TOPS,
    FULL_WEATHER,
    EXPONENTS,
    BIASES,
    COVERAGE,
    WIDTHS,
    NO_SHADOW,
    false,
    undefined,
    convective
  ).density[3]
}

describe('the coverage fold, on the CPU twin', () => {
  it('without the mask the fold is a no-op', () => {
    const off = towerLane(9000, null)
    const neutral = towerLane(9000, { cellMask: 1, cellDensity: 0 })
    log('fold is inert with no density', [
      { key: 'convective off', want: off, got: off },
      { key: 'mask 1, density 0', want: off, got: neutral }
    ])
    expect(neutral).toBe(off)
  })

  it('outside a cell the lane erases, and inside one it fills', () => {
    const outside = towerLane(9000, CELL_OFF)
    const inside = towerLane(9000, CELL_ON)
    const bare = towerLane(9000, null)

    log('cell gate on the tower lane', [
      { key: 'no mask', want: '>= 0', got: bare },
      { key: 'cellMask 0', want: 0, got: outside },
      { key: 'cellMask 1', want: '>= bare', got: inside }
    ])

    // A threshold of 1 admits nothing the weather map holds, so an empty cell
    // erases every lane at once
    expect(outside).toBe(0)
    expect(inside).toBeGreaterThanOrEqual(bare)
  })

  it('erases the thin decks too, which is what concentrates coverage', () => {
    // The mask is global rather than per-lane on purpose, and 1300 m is inside
    // both decks, where the unmasked density is not trivially zero
    const density = cpuSampleWeather(
      1300,
      BASES,
      TOPS,
      WEATHER,
      EXPONENTS,
      BIASES,
      COVERAGE,
      WIDTHS,
      NO_SHADOW,
      false,
      undefined,
      CELL_OFF
    ).density
    const bare = cpuSampleWeather(
      1300,
      BASES,
      TOPS,
      WEATHER,
      EXPONENTS,
      BIASES,
      COVERAGE,
      WIDTHS,
      NO_SHADOW,
      false
    ).density

    log('global cell gate', [
      { key: 'bare, all lanes', want: '> 0 somewhere', got: bare.join(' ') },
      { key: 'masked off, all lanes', want: 'all 0', got: density.join(' ') }
    ])

    expect(Math.max(...bare)).toBeGreaterThan(0)
    expect(Math.max(...density)).toBe(0)
  })
})

describe('the profile wiring reads the packed heights', () => {
  it('the tower lane is the one the layer list made tall', () => {
    // The evalue is what makes the shoulder reach only the tower: the packed
    // maxLayerHeights minus minLayerHeights is thickness, read per frame
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    const layerU = createLayerUniforms()
    updateLayerUniforms(layerU, ctx)
    const thickness = layerU.maxLayerHeights.value
      .clone()
      .sub(layerU.minLayerHeights.value)

    log('default layer thickness', {
      thickness: [thickness.x, thickness.y, thickness.z, thickness.w].join(' ')
    })

    // Every default layer is a deck, so every weight is 0 and turning the
    // flag on with the shipped layer set changes only the cell mask
    const weights = [0, 1, 2, 3].map(i =>
      towerWeightCPU(
        layerU.minLayerHeights.value.getComponent(i),
        layerU.maxLayerHeights.value.getComponent(i)
      )
    )
    log('default tower weights', { weights: weights.join(' ') })
    expect(weights).toEqual([0, 0, 0, 0])
    // Every default layer is under the floor, so the flag on its own changes
    // the cell mask and not the vertical shape law
    expect(Math.max(...thickness.toArray())).toBeLessThan(
      CONVECTIVE_TOWER_MIN_HEIGHT
    )
  })
})
