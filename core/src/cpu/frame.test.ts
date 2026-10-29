// The whole CPU frame against the live port. The port runs its real
// renderFrame through updateBefore on a renderer stub, as CloudsPassNode.test
// does, and every value the GPU would read is compared with CloudsFrameState
// field by field over multi-frame sequences

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Matrix4,
  PerspectiveCamera,
  Vector2,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem
} from 'three'

import { clouds, type CloudsPassNode } from '../../../src/CloudsPassNode'
import { createLayerUniforms } from '../../../src/layerUniforms'
import { createMarchUniforms } from '../../../src/marchUniforms'
import { createParameterUniforms } from '../../../src/parameterUniforms'
import {
  createShadowPassUniforms,
  shadowTemporalAlpha
} from '../../../src/pass/shadowUniforms'
import type { QualityPreset } from '../../../src/qualityPresets'
import { CLOUDS_TEMPORAL_ALPHA } from '../../../src/resolve/cloudsResolve'
import { log } from '../../../test/helpers/log'
import { bitDiff, mat4From } from '../../test/twin'
import { createCamera, setCameraWorld, setPerspective } from './camera'
import { CloudsFrameState } from './frame'
import {
  applyQualityPreset,
  createCloudsInputs,
  type CloudsInputs
} from './inputs'
import type { Mat4, Vec2, Vec3, Vec4 } from './math'
import type { ShadowCascadeDraw } from './uniforms'

const ER = 6378137

type Values = Record<string, number[]>
type V = { x: number; y: number; z?: number; w?: number }

const v2 = (v: V) => [v.x, v.y]
const v3 = (v: V) => [v.x, v.y, v.z!]
const v4 = (v: V) => [v.x, v.y, v.z!, v.w!]
const m4 = (m: { elements: ArrayLike<number> }) => Array.from(m.elements)

interface UniformLike<T> {
  value: T
}
type Uniforms = Record<string, UniformLike<unknown>>

// A uniform's value as numbers, whatever its type
function flatten(value: unknown): number[] {
  if (typeof value === 'number') return [value]
  if (typeof value === 'boolean') return [value ? 1 : 0]
  if (value instanceof Matrix4) return m4(value)
  if (value instanceof Vector4) return v4(value)
  if (value instanceof Vector3) return v3(value)
  if (value instanceof Vector2) return v2(value)
  throw new Error(`unflattenable uniform value ${String(value)}`)
}

function flattenCore(
  value: number | boolean | Vec2 | Vec3 | Vec4 | Mat4
): number[] {
  if (typeof value === 'number') return [value]
  if (typeof value === 'boolean') return [value ? 1 : 0]
  if ('elements' in value) return m4(value)
  if ('w' in value) return v4(value)
  if ('z' in value) return v3(value)
  return v2(value)
}

// What the port's pass reads and writes, reached on purpose as its own tests do
interface PortInternals {
  _marchUniforms: Uniforms
  _layerUniforms: Uniforms
  _parameterUniforms: Uniforms
  _shadowUniforms: ReturnType<typeof createShadowPassUniforms>
  _shadowFromECEF: { array: Matrix4[] }
  _viewZFromECEF: UniformLike<Vector4>
  shadowRT: unknown
  shadowHistoryRT: unknown
}

interface Scenario {
  name: string
  preset: QualityPreset
  frames: number
  size: [number, number]
  pose: { position: [number, number, number]; lookAt: [number, number, number] }
  sun: [number, number, number]
  // Applied to both sides before frame `at`
  edits?: { at: number; apply: (target: Knobs) => void }[]
  setup?: (target: Knobs) => void
  cameraVelocity?: [number, number, number]
  sunVelocity?: [number, number, number]
  windVelocity?: [number, number]
}

// The knobs both sides share, so one edit writes both
interface Knobs {
  temporalUpscale: boolean
  correctAltitude: boolean
  moonlight: boolean
  moonDirection: { set: (x: number, y: number, z: number) => unknown }
  worldToECEFMatrix: { elements: number[] }
  cascadeCount: (n: number) => void
  mapSize: (n: number) => void
  updateInterval: (n: number) => void
  temporalPass: (b: boolean) => void
  layerShadow: (i: number, b: boolean) => void
  resolutionScale: (s: number) => void
}

function portKnobs(pass: CloudsPassNode): Knobs {
  const ctx = pass.cloudsContext
  return {
    set temporalUpscale(b: boolean) {
      ctx.temporalUpscale = b
    },
    set correctAltitude(b: boolean) {
      ctx.correctAltitude = b
    },
    set moonlight(b: boolean) {
      ctx.experimental = { moonlight: b }
    },
    moonDirection: ctx.moonDirection,
    worldToECEFMatrix: ctx.worldToECEFMatrix,
    cascadeCount: n => (ctx.shadow.cascadeCount = n),
    mapSize: n => ctx.shadow.mapSize.set(n, n),
    updateInterval: n => (ctx.shadow.updateInterval = n),
    temporalPass: b => (ctx.shadow.temporalPass = b),
    layerShadow: (i, b) => (ctx.cloudLayers[i]!.shadow = b),
    resolutionScale: s => (ctx.resolutionScale = s)
  }
}

function coreKnobs(inputs: CloudsInputs): Knobs {
  return {
    set temporalUpscale(b: boolean) {
      inputs.temporalUpscale = b
    },
    set correctAltitude(b: boolean) {
      inputs.correctAltitude = b
    },
    set moonlight(b: boolean) {
      inputs.moonlight = b
    },
    moonDirection: inputs.moonDirection,
    worldToECEFMatrix: inputs.worldToECEFMatrix,
    cascadeCount: n => (inputs.shadow.cascadeCount = n),
    mapSize: n => inputs.shadow.mapSize.set(n, n),
    updateInterval: n => (inputs.shadow.updateInterval = n),
    temporalPass: b => (inputs.shadow.temporalPass = b),
    layerShadow: (i, b) => (inputs.cloudLayers[i]!.shadow = b),
    resolutionScale: s => (inputs.resolutionScale = s)
  }
}

function rendererStub(
  width: number,
  height: number,
  onTarget: (target: unknown, layer?: number) => void
) {
  const size = new Vector2(width, height)
  const noop = () => undefined
  return {
    size,
    getDrawingBufferSize: (target: Vector2) => target.copy(size),
    setRenderTarget: onTarget,
    render: noop,
    setMRT: noop,
    setRenderObjectFunction: noop,
    setClearColor: noop,
    clear: noop,
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: 'srgb',
    autoClear: true,
    setPixelRatio: noop,
    getRenderTarget: () => null,
    getPixelRatio: () => 1,
    getMRT: () => null,
    getRenderObjectFunction: () => null,
    getClearColor: () => ({ r: 0, g: 0, b: 0 }),
    getClearAlpha: () => 1,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getScissorTest: () => false,
    setScissorTest: noop,
    compute: noop,
    hasFeature: () => false
  }
}

interface PortPrivate {
  frameDimensions: (renderer: unknown) => { fullW: number; fullH: number }
}

// A resolve constant the port creates only when it builds the graph, read from
// its source with comments stripped so the prose cannot match
function portUniformLiteral(field: string): number {
  const source = readFileSync(
    join(import.meta.dirname, '../../../src/CloudsPassNode.ts'),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  const match = new RegExp(
    `this\\.${field} \\?\\?= uniform\\(([0-9.]+)\\)`
  ).exec(source)
  if (match == null) throw new Error(`no uniform literal for ${field}`)
  return Number(match[1])
}

function portValues(
  pass: CloudsPassNode,
  draws: Values,
  renderer: unknown
): Values {
  const ctx = pass.cloudsContext
  const p = pass as unknown as PortInternals
  const out: Values = { ...draws }
  const cam = ctx.cameraUniforms as unknown as Uniforms
  for (const key of [
    'viewMatrix',
    'inverseViewMatrix',
    'inverseProjectionMatrix',
    'cameraNear',
    'cameraFar',
    'cameraPosition',
    'cameraPositionECEF',
    'cameraDirectionECEF',
    'reprojectionMatrix',
    'viewReprojectionMatrix'
  ]) {
    out[`camera.${key}`] = flatten(cam[key]!.value)
  }
  for (const [group, uniforms] of [
    ['march', p._marchUniforms],
    ['layer', p._layerUniforms],
    ['parameter', p._parameterUniforms]
  ] as const) {
    for (const [key, node] of Object.entries(uniforms)) {
      if (key === 'placeholders' || /Texture$/.test(key)) continue
      out[`${group}.${key}`] = flatten(node.value)
    }
  }
  const su = p._shadowUniforms
  for (const key of [
    'maxIterationCount',
    'minStepSize',
    'maxStepSize',
    'minDensity',
    'minExtinction',
    'minTransmittance',
    'opticalDepthTailScale',
    'shadowResolution'
  ] as const) {
    out[`shadowPass.${key}`] = flatten(su[key].value)
  }
  const dims = (p as unknown as PortPrivate).frameDimensions(renderer)
  out['resolve.width'] = [dims.fullW]
  out['resolve.height'] = [dims.fullH]
  out['resolve.temporalAlpha'] = [CLOUDS_TEMPORAL_ALPHA]
  out['resolve.varianceGamma'] = [portUniformLiteral('_varianceGamma')]
  out['resolve.shadowTemporalAlpha'] = [shadowTemporalAlpha(ctx)]
  out['resolve.shadowVarianceGamma'] = [
    portUniformLiteral('_shadowVarianceGamma')
  ]
  const desc = pass.cloudShadow
  out['cloudShadow.cascadeCount'] = [desc.cascadeCount]
  out['cloudShadow.intervals'] = (desc.intervals.array as Vector2[]).flatMap(v2)
  out['cloudShadow.matrices'] = (desc.matrices.array as Matrix4[]).flatMap(m4)
  out['cloudShadow.inverseMatrices'] = (
    desc.inverseMatrices.array as Matrix4[]
  ).flatMap(m4)
  out['cloudShadow.far'] = [desc.far.value]
  out['cloudShadow.topHeight'] = [desc.topHeight.value]
  out['cloudShadow.texelSize'] = v2(desc.texelSize.value)
  out['cloudShadow.shadowFromECEF'] = p._shadowFromECEF.array.flatMap(m4)
  out['cloudShadow.viewZFromECEF'] = v4(p._viewZFromECEF.value)
  return out
}

function coreValues(state: CloudsFrameState, draws: Values): Values {
  const out: Values = { ...draws }
  const groups = {
    camera: state.camera,
    march: state.march,
    layer: state.layer,
    parameter: state.parameter,
    shadowPass: state.shadowPass,
    resolve: state.resolve
  }
  for (const [group, values] of Object.entries(groups)) {
    for (const [key, value] of Object.entries(values)) {
      if (
        ['jitter', 'previousProjectionMatrix', 'previousViewMatrix'].includes(
          key
        )
      )
        continue
      out[`${group}.${key}`] = flattenCore(value as number)
    }
  }
  const s = state.cloudShadow
  out['cloudShadow.cascadeCount'] = [s.cascadeCount]
  out['cloudShadow.intervals'] = s.intervals.flatMap(v2)
  out['cloudShadow.matrices'] = s.matrices.flatMap(m4)
  out['cloudShadow.inverseMatrices'] = s.inverseMatrices.flatMap(m4)
  out['cloudShadow.far'] = [s.far]
  out['cloudShadow.topHeight'] = [s.topHeight]
  out['cloudShadow.texelSize'] = v2(s.texelSize)
  out['cloudShadow.shadowFromECEF'] = s.shadowFromECEF.flatMap(m4)
  out['cloudShadow.viewZFromECEF'] = v4(s.viewZFromECEF)
  return out
}

function coreDraws(draws: ShadowCascadeDraw[], temporal: boolean): Values {
  const out: Values = {}
  draws.forEach((d, i) => {
    out[`draw${i}.inverseShadowMatrix`] = m4(d.inverseShadowMatrix)
    out[`draw${i}.mipLevel`] = [d.mipLevel]
    if (temporal) {
      out[`draw${i}.reprojectionMatrix`] = m4(d.reprojectionMatrix)
      out[`draw${i}.cascadeIndex`] = [d.cascadeIndex]
    }
  })
  return out
}

interface FrameRow {
  scenario: string
  frame: number
  fields: number
  values: number
  mismatchedFields: string[]
  shadowRendered: boolean
}

function runScenario(sc: Scenario): FrameRow[] {
  // Port side
  const pass = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  ctx.qualityPreset = sc.preset
  const p = pass as unknown as PortInternals
  p._marchUniforms = createMarchUniforms(ctx) as unknown as Uniforms
  p._layerUniforms = createLayerUniforms() as unknown as Uniforms
  p._parameterUniforms = createParameterUniforms(ctx) as unknown as Uniforms
  p._shadowUniforms = createShadowPassUniforms(ctx)
  // A consumer, so the cloud shadow descriptor exists and is composed
  void pass.cloudShadow

  // Core side
  const inputs = applyQualityPreset(createCloudsInputs(), sc.preset)
  sc.setup?.(portKnobs(pass))
  sc.setup?.(coreKnobs(inputs))
  const state = new CloudsFrameState(inputs)

  let portDraws: Values = {}
  const renderer = rendererStub(sc.size[0], sc.size[1], (target, layer) => {
    if (target == null) return
    // Only a history clear binds the history target as a render target
    if (target === p.shadowHistoryRT) portDraws['shadow.clearHistory'] = [1]
    if (target === p.shadowRT) portDraws['shadow.rendered'] = [1]
    if (target === p.shadowRT && layer != null) {
      const su = p._shadowUniforms
      portDraws[`draw${layer}.inverseShadowMatrix`] = m4(
        su.inverseShadowMatrix.value
      )
      portDraws[`draw${layer}.mipLevel`] = [su.mipLevel.value]
      if (ctx.shadow.temporalPass) {
        portDraws[`draw${layer}.reprojectionMatrix`] = m4(
          su.reprojectionMatrix.value
        )
        portDraws[`draw${layer}.cascadeIndex`] = [su.cascadeIndex.value]
      }
    }
  })

  const threeCam = new PerspectiveCamera(50, sc.size[0] / sc.size[1], 100, 1e8)
  threeCam.coordinateSystem = WebGPUCoordinateSystem
  threeCam.updateProjectionMatrix()
  const coreCam = setPerspective(createCamera(), {
    fov: 50,
    aspect: sc.size[0] / sc.size[1],
    near: 100,
    far: 1e8
  })

  const rows: FrameRow[] = []
  const lightRows: { frame: number; sunDotLight: number; moonRatio: number }[] =
    []
  for (let f = 0; f < sc.frames; ++f) {
    for (const edit of sc.edits ?? []) {
      if (edit.at === f) {
        edit.apply(portKnobs(pass))
        edit.apply(coreKnobs(inputs))
      }
    }
    const dt = 0.25
    const t = f * dt
    const cv = sc.cameraVelocity ?? [0, 0, 0]
    const offset = cv.map(c => c * t)
    threeCam.position.set(
      ...(sc.pose.position.map((c, i) => c + offset[i]!) as [
        number,
        number,
        number
      ])
    )
    threeCam.lookAt(
      ...(sc.pose.lookAt.map((c, i) => c + offset[i]!) as [
        number,
        number,
        number
      ])
    )
    threeCam.updateMatrixWorld()
    setCameraWorld(coreCam, mat4From(threeCam.matrixWorld))

    const sv = sc.sunVelocity ?? [0, 0, 0]
    const sun = new Vector3(...sc.sun)
      .add(new Vector3(...sv).multiplyScalar(t))
      .normalize()
    ctx.sunDirection.copy(sun)
    inputs.sunDirection.set(sun.x, sun.y, sun.z)
    const wind = sc.windVelocity ?? [0, 0]
    ctx.localWeatherVelocity.set(...wind)
    inputs.localWeatherVelocity.set(...wind)
    ctx.time = t
    inputs.time = t
    ctx.frame = f
    inputs.frame = f

    portDraws = {}
    pass.updateBefore({
      frameId: f + 1,
      renderer,
      camera: threeCam,
      deltaTime: dt,
      time: t
    } as never)
    const port = portValues(pass, portDraws, renderer)

    state.update(coreCam, sc.size[0], sc.size[1])
    const core = coreValues(
      state,
      coreDraws(state.shadow.draws, inputs.shadow.temporalPass)
    )
    if (state.shadow.clearHistory) core['shadow.clearHistory'] = [1]
    if (state.shadow.rendered) core['shadow.rendered'] = [1]
    lightRows.push({
      frame: f,
      sunDotLight: state.march.lightDirection.dot(state.march.sunDirection),
      moonRatio: state.march.moonIrradianceRatio.x
    })
    state.afterRender(coreCam)

    const fields = [
      ...new Set([...Object.keys(port), ...Object.keys(core)])
    ].sort()
    const mismatchedFields = fields.filter(k => {
      const a = core[k]
      const b = port[k]
      return a == null || b == null || bitDiff(a, b).mismatches > 0
    })
    rows.push({
      scenario: sc.name,
      frame: f,
      fields: fields.length,
      values: fields.reduce((n, k) => n + (port[k]?.length ?? 0), 0),
      mismatchedFields,
      shadowRendered: state.shadow.rendered
    })
  }
  log(`light-${sc.name}`, lightRows)
  lastLight = lightRows
  return rows
}

let lastLight: { frame: number; sunDotLight: number; moonRatio: number }[] = []

const POSE_ORBIT_60KM = {
  position: [0, ER + 60000, 0] as [number, number, number],
  lookAt: [0, ER - 20000, 0] as [number, number, number]
}
const POSE_HORIZON = {
  position: [0, ER + 7900, 0] as [number, number, number],
  lookAt: [ER, 0, 0] as [number, number, number]
}
const SUN_45: [number, number, number] = [0, Math.SQRT1_2, -Math.SQRT1_2]

const SCENARIOS: Scenario[] = [
  {
    name: 'baseline-medium',
    preset: 'medium',
    frames: 4,
    size: [1280, 720],
    pose: POSE_ORBIT_60KM,
    sun: SUN_45,
    setup: k => {
      k.temporalUpscale = false
    }
  },
  {
    name: 'temporal-upscale-moving',
    preset: 'medium',
    frames: 18,
    size: [1283, 717],
    pose: POSE_HORIZON,
    sun: [0.3, 0.9, 0.1],
    cameraVelocity: [400, 30, -250],
    sunVelocity: [0.002, -0.001, 0.003],
    windVelocity: [0.001, -0.0005]
  },
  {
    name: 'high-interval-1-ecef-rotated',
    preset: 'high',
    frames: 5,
    size: [960, 540],
    pose: POSE_ORBIT_60KM,
    sun: SUN_45,
    cameraVelocity: [2000, 0, 1500],
    setup: k => {
      k.updateInterval(1)
      // 28 degrees about ECEF Y, as the ladder's ecef-rotated case
      const a = (28 * Math.PI) / 180
      const m = new Matrix4().makeRotationY(a)
      k.worldToECEFMatrix.elements.splice(0, 16, ...m.elements)
    }
  },
  {
    name: 'twilight-moonlight-no-altitude',
    preset: 'low',
    frames: 6,
    size: [800, 600],
    pose: POSE_HORIZON,
    sun: [0.05, -0.04, 1],
    sunVelocity: [0, -0.02, 0],
    cameraVelocity: [0, 3000, 0],
    setup: k => {
      k.moonlight = true
      k.moonDirection.set(0.2, 0.7, -0.3)
      k.correctAltitude = false
    }
  },
  {
    name: 'structure-and-resize-edits',
    preset: 'ultra',
    frames: 8,
    size: [1024, 768],
    pose: POSE_ORBIT_60KM,
    sun: SUN_45,
    cameraVelocity: [500, 0, 0],
    edits: [
      { at: 2, apply: k => k.cascadeCount(4) },
      { at: 3, apply: k => k.mapSize(256) },
      // No layer casts a shadow, which flips castsShadow and resets
      {
        at: 4,
        apply: k => {
          k.layerShadow(0, false)
          k.layerShadow(1, false)
        }
      },
      {
        at: 5,
        apply: k => {
          k.layerShadow(2, true)
          k.temporalPass(false)
        }
      },
      { at: 6, apply: k => k.resolutionScale(0.5) },
      { at: 7, apply: k => k.temporalPass(true) }
    ]
  }
]

describe('the CPU frame matches the live port bit for bit', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      const rows = runScenario(sc)
      log(`frame-${sc.name}`, rows)
      // Every frame compared, and each compared a full set of fields
      expect(rows).toHaveLength(sc.frames)
      for (const row of rows) expect(row.fields).toBeGreaterThan(80)
      expect(
        rows.flatMap(r => r.mismatchedFields.map(f => `${r.frame}:${f}`))
      ).toEqual([])
    })
  }

  it('the twilight scenario hands the light to the moon', () => {
    // Positive control: without it the moonlight rows compare the sun path
    runScenario(SCENARIOS[3]!)
    expect(lastLight.some(r => r.sunDotLight < 0.999)).toBe(true)
    expect(lastLight.some(r => r.moonRatio > 0)).toBe(true)
  })

  it('the sequences exercise both shadow schedules', () => {
    const rows = runScenario(SCENARIOS[1]!)
    const rendered = rows.map(r => r.shadowRendered)
    log('shadow-schedule', { rendered: rendered.map(Number).join('') })
    // updateInterval 2 renders every other frame after the first
    expect(rendered.slice(0, 6)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false
    ])
  })
})
