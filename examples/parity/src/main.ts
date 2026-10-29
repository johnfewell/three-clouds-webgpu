import {
  NeutralToneMapping,
  WebGLRenderer,
  type Matrix4,
  type Vector3
} from 'three'

import type { CloudsEffect } from '@takram/three-clouds'

import {
  BASE_STATE,
  caseByName,
  effectiveState,
  type CaseDefinition
} from '../cases/index'
import type {
  ParityProbe,
  ProbeShadowKnobs,
  ProbeStats
} from '../e2e/parityProbe'
import { assertParityAssets } from './assetGuard'
import { effectiveAtmosphereProfile } from './atmosphereProfile'
import { createCloudShadowProbe } from './cloudShadowProbe'
import { changedFraction } from './convergence'
import { renderGridPage } from './gridPage'
import { harnessLog } from './harnessLog'
import { buildPanel, defaultLiveState } from './liveControls'
import {
  buildTimingSummary,
  GpuTimingCollector,
  WebGLGpuTimer,
  WebGPUGpuTimer,
  type GpuTimingSummary
} from './metrics/gpuTiming'
import type {
  compareMotionDirections,
  computeMotionVector,
  MotionDirectionResult,
  MotionVectorResult
} from './metrics/sequence'
import {
  applyToA,
  applyToB,
  buildCaseParityState,
  caseToParityCase,
  PHASE0_CASES,
  validateParityStatePartial,
  type ParityCase,
  type ParityState
} from './parityState'
import { unpadRows } from './readback'
import { flipRowsTopFirst } from './readbackRows'
import { parseHarnessParams, type ViewMode } from './routing'
import {
  atlasCascadeLayerCount,
  readAtlasLayersGL,
  type AtlasGLReader
} from './shadowAtlasReadback'
import {
  reconstructShadowRayExtent,
  shadowRayExtentCeilingUnit
} from './shadowRayExtent'
import { createSideA, type SideAHandle } from './sideA'
import { createSideB, type SideBHandle } from './sideB'
import { sitePath } from './sitePath'
import { applyViewMode, createViewState, updateUrl } from './viewModes'
import { planTemporal, warmupFramePlan } from './warmupFrames'

function halfFloatToFloat32(src: Uint16Array): Float32Array {
  const dst = new Float32Array(src.length)
  const dv = new DataView(dst.buffer)
  for (let i = 0; i < src.length; i++) {
    const h = src[i]!
    const s = (h >> 15) & 1
    let e = (h >> 10) & 0x1f
    let m = h & 0x3ff
    if (e === 0) {
      if (m === 0) {
        dv.setUint32(i * 4, s << 31, true)
      } else {
        while ((m & 0x400) === 0) {
          m <<= 1
          e--
        }
        e++
        m &= ~0x400
        dv.setUint32(i * 4, (s << 31) | ((e + 112) << 23) | (m << 13), true)
      }
    } else if (e === 31) {
      dv.setUint32(i * 4, (s << 31) | 0x7f800000 | (m << 13), true)
    } else {
      dv.setUint32(i * 4, (s << 31) | ((e + 112) << 23) | (m << 13), true)
    }
  }
  return dst
}

function toFloat32(buf: ArrayBufferView): Float32Array {
  if (buf instanceof Float32Array) return buf
  if (buf instanceof Uint16Array) return halfFloatToFloat32(buf)
  return new Float32Array(buf as unknown as ArrayLike<number>)
}

// ── Probe-only shapes ────────────────────────────────────────────────
// The &e2e=1 probe reaches internals three and postprocessing do not declare
// Naming the shapes keeps those reaches explicit instead of erasing types

interface AsyncPixelReader {
  readRenderTargetPixelsAsync?: (
    rt: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
    textureIndex?: number,
    faceIndex?: number
  ) => Promise<ArrayBufferView>
}

interface ProbeHolder {
  value: ReturnType<typeof createCloudShadowProbe>
}

interface ProbeRenderTarget {
  width: number
  height: number
  depth?: number
  texture?: { image?: { depth?: number }; name?: string; type?: number }
  textures?: Array<{ name?: string; type?: number }>
}

interface CloudsPassProbeAccess {
  layerRT: ProbeRenderTarget
  shadowRT: ProbeRenderTarget | null
  shadowResolveRT: ProbeRenderTarget | null
  shadowHistoryRT: ProbeRenderTarget | null
  // Colour in textures[0]. The shadow length is textures[1] of the same
  // pair while light shafts are on: one resolve pass writes both
  //, as the reference's cloudsResolve.frag does
  resolveRT: ProbeRenderTarget | null
  historyRT: ProbeRenderTarget | null
  _layerUniforms: {
    shadowTopHeight: { value: number }
    shadowBottomHeight: { value: number }
  } | null
}

interface ProbeScalarReadback {
  width: number
  height: number
  data: Float32Array
}

interface ProbeShadowRayExtents {
  extent: ProbeScalarReadback[]
  ulpAllowance: ProbeScalarReadback[]
}

/**
 * side A's atlas readback. Same shape as side B's `ProbeAtlas` plus
 * the unit convention stated, because the two atlases are only comparable
 * channel by channel once the reader knows side A stores frontDepth in METRES
 * and side B in UNIT SPACE. `ms` is the read's own wall time, which is the cost
 * side B's async lane never paid
 */
export interface ProbeAtlasA {
  width: number
  height: number
  depth: number
  temporalPass: boolean
  maxShadowRayExtentUnit: number
  source: 'raw' | 'history'
  layers: ProbeScalarReadback[]
  rayExtents: ProbeShadowRayExtents
  // Errors pending before the read. 0x506 is reported and the texels stay
  preexistingGlErrors: number[]
  // Side A stores frontDepth in metres. RGBA16F saturates a miss at 65504
  atlasUnits: 'metres'
  ms: number
}

/**
 * The geometry `reconstructShadowRayExtent` needs, as plain numbers.
 *
 * Both sides can supply it from their own objects: side B from the
 * CloudsContext, side A from the reference ShadowMaterial's uniforms, which
 * carry the atmosphere and layer uniforms the reference spreads into them
 * (ShadowMaterial.ts:82-86). Taking the numbers rather than a handle keeps the
 * twin independent of which side asked
 */
interface ShadowRayExtentGeometry {
  inverseShadowMatrices: readonly (readonly number[])[]
  worldToECEFMatrix: readonly number[]
  altitudeCorrection: readonly [number, number, number]
  sunDirection: readonly [number, number, number]
  bottomRadius: number
  shadowTopHeight: number
  shadowBottomHeight: number
}

function buildShadowRayExtentLayers(
  geometry: ShadowRayExtentGeometry,
  width: number,
  height: number,
  depth: number
): ProbeShadowRayExtents {
  if (geometry.inverseShadowMatrices.length < depth) {
    throw new Error('Shadow atlas has more layers than cascades')
  }
  const fields = Array.from({ length: depth }, (_, layer) =>
    reconstructShadowRayExtent({
      width,
      height,
      inverseShadowMatrix: geometry.inverseShadowMatrices[layer]!,
      worldToECEFMatrix: geometry.worldToECEFMatrix,
      altitudeCorrection: geometry.altitudeCorrection,
      sunDirection: geometry.sunDirection,
      bottomRadius: geometry.bottomRadius,
      shadowTopHeight: geometry.shadowTopHeight,
      shadowBottomHeight: geometry.shadowBottomHeight
    })
  )
  return {
    extent: fields.map(field => ({
      width,
      height,
      data: field.unit
    })),
    ulpAllowance: fields.map(field => ({
      width,
      height,
      data: field.ulpAllowance
    }))
  }
}

// the shadow velocity lane, summarised. The shader writes
// vec4(frontDepthUnit, velocity, 0) with velocity = (uv - prevUv) * resolution,
// so magnitudes are in TEXELS and prevUv - uv = -velocity / resolution
function shadowRayExtentGeometryB(
  sideB: SideBHandle,
  cloudsPass: CloudsPassProbeAccess
): ShadowRayExtentGeometry {
  const ctx = sideB.cloudsContext
  const shadowMaps = ctx.shadowMaps
  const layerUniforms = cloudsPass._layerUniforms
  if (shadowMaps == null || layerUniforms == null) {
    throw new Error('Shadow ray-extent geometry unavailable')
  }
  return {
    inverseShadowMatrices: shadowMaps.cascades.map(
      cascade => cascade.inverseMatrix.elements
    ),
    worldToECEFMatrix: ctx.worldToECEFMatrix.elements,
    altitudeCorrection: [
      ctx.altitudeCorrection.x,
      ctx.altitudeCorrection.y,
      ctx.altitudeCorrection.z
    ],
    sunDirection: [ctx.sunDirection.x, ctx.sunDirection.y, ctx.sunDirection.z],
    bottomRadius: ctx.bottomRadius,
    shadowTopHeight: layerUniforms.shadowTopHeight.value,
    shadowBottomHeight: layerUniforms.shadowBottomHeight.value
  }
}

/**
 * the same geometry off side A's reference ShadowPass.
 *
 * Read off the ShadowMaterial's own uniforms rather than the CloudsEffect
 * fields: those ARE the values the reference's own march used, because
 * updateSharedUniforms copies altitudeCorrection, worldToECEFMatrix and
 * bottomRadius into them every frame. `shadowPass.currentMaterial` is the
 * documented public surface
 */
function shadowRayExtentGeometryA(
  clouds: CloudsEffect
): ShadowRayExtentGeometry {
  const uniforms = clouds.shadowPass.currentMaterial.uniforms as unknown as {
    inverseShadowMatrices: { value: Matrix4[] }
    worldToECEFMatrix: { value: Matrix4 }
    altitudeCorrection: { value: Vector3 }
    sunDirection: { value: Vector3 }
    bottomRadius: { value: number }
    shadowTopHeight: { value: number }
    shadowBottomHeight: { value: number }
  }
  return {
    inverseShadowMatrices: uniforms.inverseShadowMatrices.value.map(
      matrix => matrix.elements
    ),
    worldToECEFMatrix: uniforms.worldToECEFMatrix.value.elements,
    altitudeCorrection: [
      uniforms.altitudeCorrection.value.x,
      uniforms.altitudeCorrection.value.y,
      uniforms.altitudeCorrection.value.z
    ],
    sunDirection: [
      uniforms.sunDirection.value.x,
      uniforms.sunDirection.value.y,
      uniforms.sunDirection.value.z
    ],
    bottomRadius: uniforms.bottomRadius.value,
    shadowTopHeight: uniforms.shadowTopHeight.value,
    shadowBottomHeight: uniforms.shadowBottomHeight.value
  }
}

interface VelocityStats {
  present: boolean
  texels: number
  meanMag: number
  maxMag: number
  nonZeroFrac: number
}

interface ShadowVelocityAccess {
  // the depth velocity is the shadow march target's SECOND attachment
  // (textures[1]); there is no separate velocity target any more
  shadowRT: {
    width: number
    height: number
    textures: readonly unknown[]
  } | null
  // The RESOLVED shadow. A pass that runs twice per captured frame also
  // BLENDS history twice (side A once). If this target moves between the two
  // executions of one frame, that is the double blend, measured
  shadowResolveRT: { width: number; height: number } | null
}

interface WebGLRendererInternals {
  properties: { get: (key: unknown) => { __webglTexture?: WebGLTexture } }
}

interface LayerRTHolder {
  layerRT: ProbeRenderTarget & { textures: unknown[] }
}

function assertSceneLinearReady(
  side: 'A' | 'B',
  sideA: SideAHandle,
  sideB: SideBHandle | null
): void {
  if (side === 'A') {
    // Side A disables clouds by disconnecting the reference effect's
    // atmosphere overlay. skipRendering stays true in both states
    if (sideA.aerial.overlay != null) {
      throw new Error("readSceneLinear('A') requires clouds to be disabled")
    }
    return
  }

  if (sideB == null) throw new Error('Side B not available')
  if (sideB.cloudsContext.enabled) {
    throw new Error("readSceneLinear('B') requires clouds to be disabled")
  }
}

interface SequenceProbeWindow {
  __seqFramesA: Float32Array[] | null
  __seqFramesB: Float32Array[] | null
  __seqDims: { width: number; height: number }
}

interface ProbeSequenceMetrics {
  flickerA: { mean: number; max: number }
  flickerB: { mean: number; max: number }
  ghostingA: { deMean: number; deP95: number } | null
  ghostingB: { deMean: number; deP95: number } | null
  motionA: MotionVectorResult | null
  motionB: MotionVectorResult | null
  motionDirection: MotionDirectionResult | null
}

function computeSequenceMotion(
  metrics: {
    computeMotionVector: typeof computeMotionVector
    compareMotionDirections: typeof compareMotionDirections
  },
  storedA: Float32Array[],
  storedB: Float32Array[],
  dimensions: { width: number; height: number }
): Pick<ProbeSequenceMetrics, 'motionA' | 'motionB' | 'motionDirection'> {
  if (storedA.length <= 1 || storedB.length <= 1) {
    return { motionA: null, motionB: null, motionDirection: null }
  }
  const args = [dimensions.width, dimensions.height, 4] as const
  const motionA = metrics.computeMotionVector(
    storedA[0]!,
    storedA[storedA.length - 1]!,
    ...args
  )
  const motionB = metrics.computeMotionVector(
    storedB[0]!,
    storedB[storedB.length - 1]!,
    ...args
  )
  return {
    motionA,
    motionB,
    motionDirection: metrics.compareMotionDirections(motionA, motionB)
  }
}

const probeWindow = window as unknown as SequenceProbeWindow

// ADR-011 determinism: rebasing three's frameId (the STBN index)
// before each warm-up fixes the jitter per capture (sigma 5.5e-4 -> ~2e-6). It
// moves by MULTIPLES OF 64: pinned stalls FRAME nodes, repeated goes stale
const STBN_PERIOD = 64
let captureFrameBase = 0

function setNodeFrameId(handle: SideBHandle, value: number): void {
  const nodes = (
    handle.renderer as unknown as {
      _nodes?: { nodeFrame?: { frameId: number } }
    }
  )._nodes
  if (nodes?.nodeFrame != null) nodes.nodeFrame.frameId = value
}

/**
 * the node frameId of side B's last renderOnce FINAL render, or null
 * once anything else has set frame ids or changed side B's state since.
 *
 * Scored reads re-render in a later task, after rAF has advanced frameId, and a
 * new frameId re-runs the FRAME-type passes at another STBN phase. Restoring
 * this id first reads exactly the pinned render. Cleared on any state change,
 * so a later read re-renders freshly.
 */
let scoredFrameIdB: number | null = null

function restoreScoredFrameIdB(handle: SideBHandle): void {
  if (scoredFrameIdB != null) setNodeFrameId(handle, scoredFrameIdB)
}

/** New capture flow: advance the base, keeping base % 64 fixed */
function rebaseNodeFrameId(handle: SideBHandle): void {
  scoredFrameIdB = null
  captureFrameBase += STBN_PERIOD * 16
  setNodeFrameId(handle, captureFrameBase)
}

/**
 * Sequence frame `f`. The jitter must still VARY across a sequence (the
 * temporal cases exercise that), so the index carries `f` rather than being
 * frozen. `(base + f) % 64 === f % 64` because the base only moves by
 * multiples of 64, so frame f draws the same offsets every run while the
 * absolute frameId never repeats.
 */
function setSequenceFrameId(handle: SideBHandle, f: number): void {
  scoredFrameIdB = null
  setNodeFrameId(handle, captureFrameBase + f)
}

const params = parseHarnessParams(window.location.search)

// Console capture for the e2e probe, at MODULE SCOPE. Declared inside the probe
// block (built after createSideB), it missed side B's boot errors and six "no
// console errors" checks passed on a dead side B (p4 e2e test 8)
const e2eErrors: string[] = []
const e2eWarnings: string[] = []
if (params.e2e) {
  const origError = console.error
  const origWarn = console.warn
  console.error = (...args: unknown[]) => {
    e2eErrors.push(args.map(String).join(' '))
    origError.apply(console, args)
  }
  console.warn = (...args: unknown[]) => {
    e2eWarnings.push(args.map(String).join(' '))
    origWarn.apply(console, args)
  }
}

// FRAME-type nodes run once per browser frame, so N renders in one JS task
// re-run the pre-passes once: the warm-up was a no-op on side B
//. Every render loop yields to the browser.
const nextFrame = (): Promise<void> =>
  new Promise(resolve => requestAnimationFrame(() => resolve()))

const caseNameEl = document.getElementById('case-name')!
const gatesEl = document.getElementById('gates')!
const statusEl = document.getElementById('status')!
const canvasA = document.getElementById('canvas-a') as HTMLCanvasElement
const canvasB = document.getElementById('canvas-b') as HTMLCanvasElement

const captureLogs: string[] = []

function logCollector(
  caseName: string,
  side: 'A' | 'B',
  step: string,
  kv: Record<string, unknown> = {}
): void {
  harnessLog(caseName, side, step, kv)
  const parts = Object.entries(kv)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  captureLogs.push(
    `[parity][${caseName}][${side}] ${step}${parts ? ' ' + parts : ''}`
  )
}

function resolveCase(): ParityCase | null {
  if (params.caseName == null) return null
  const p0 = PHASE0_CASES.find(c => c.name === params.caseName)
  const pc = p0 ?? resolveRegistryCase(params.caseName)
  if (pc == null) return null
  // `?w=&h=` renders the case at another size on BOTH sides (routing.ts);
  // the case's own size is the default, so nothing committed changes
  return params.size == null ? pc : { ...pc, ...params.size }
}

function resolveRegistryCase(name: string): ParityCase | null {
  const cd = caseByName(name)
  return cd == null ? null : caseToParityCase(cd)
}

function _setupRenderer(
  canvas: HTMLCanvasElement,
  pc: ParityCase,
  label: string
): WebGLRenderer {
  const renderer = new WebGLRenderer({ canvas, antialias: false })
  renderer.setSize(pc.width, pc.height)
  renderer.setPixelRatio(pc.pixelRatio)
  renderer.toneMapping = NeutralToneMapping
  renderer.toneMappingExposure = 1
  logCollector(pc.name, label === 'A' ? 'A' : 'B', 'renderer-created', {
    width: pc.width,
    height: pc.height,
    toneMapping: 'NeutralToneMapping'
  })
  return renderer
}

async function captureCanvas(
  canvas: HTMLCanvasElement,
  pc: ParityCase,
  side: string
): Promise<void> {
  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, 'image/png')
  )
  if (blob == null) return

  const buf = await blob.arrayBuffer()
  const data = btoa(
    new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), '')
  )

  await fetch(sitePath('api/capture'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: String(caseByName(pc.name)?.phase ?? 0),
      caseName: pc.name,
      side,
      filename: `${side}.png`,
      data,
      log: captureLogs
    })
  })
  logCollector(pc.name, side as 'A' | 'B', 'captured')
}

async function init(): Promise<void> {
  // refuse by NAME before anything can hang on a 404ing texture
  // This sits in the harness rather than a package hook because a runner that
  // launches Vite directly runs no hooks at all
  try {
    await assertParityAssets()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    statusEl.textContent = message
    console.error(message)
    throw error
  }

  const pc = resolveCase()

  if (pc == null) {
    if (params.caseName) {
      const { cases } = await import('../cases/index')
      const names = cases.map(c => c.name).join(', ')
      statusEl.textContent = `Case "${params.caseName}" not found. Available: ${names}`
      caseNameEl.textContent = 'No case'
      return
    }
    // No case param: show index grid
    document.getElementById('harness')!.style.display = 'none'
    document.getElementById('footer')!.style.display = 'none'
    statusEl.style.display = 'none'
    const gridContainer = document.getElementById('grid-container')!
    gridContainer.style.display = ''
    await renderGridPage(gridContainer)
    return
  }

  statusEl.style.display = 'none'
  caseNameEl.textContent = pc.name

  const effectiveLighting = params.lighting ?? pc.lighting

  logCollector(pc.name, 'A', 'init', {
    capture: params.capture,
    e2e: params.e2e,
    view: params.view,
    backend: params.backend,
    lighting: effectiveLighting
  })

  // Side A: WebGL with CloudsEffect chain
  logCollector(pc.name, 'A', 'creating-clouds-chain')
  // Cases 46 and 53 are CONSTRUCTION-time on both sides (orthographic
  // camera, logarithmicDepthBuffer), so they are read from the case here. Kept
  // above its first use: a TDZ error in e31274b took the harness down
  const registryCd = caseByName(pc.name)
  const caseCamera = registryCd?.camera ?? 'perspective'
  const caseEffective = registryCd != null ? effectiveState(registryCd) : null
  const caseLogDepth = caseEffective?.logarithmicDepthBuffer ?? false
  const caseProcedural = caseEffective?.proceduralTextures ?? false

  const sideA = await createSideA({
    canvas: canvasA,
    lighting: effectiveLighting,
    camera: caseCamera,
    logarithmicDepthBuffer: caseLogDepth,
    proceduralTextures: caseProcedural
  })
  sideA.applyCase(pc)
  logCollector(pc.name, 'A', 'clouds-chain-ready', {
    lighting: effectiveLighting
  })

  // Side B: WebGPU with TSL chain (ADR-001 render graph)
  logCollector(pc.name, 'B', 'creating-clouds-chain')
  // the case's `backend` had no consumer, so case 54 rendered the
  // default WebGPU side and passed for a backend it never ran. The URL param
  // still wins for ad-hoc use, the case supplies the default
  const sideBOpts = {
    canvas: canvasB,
    lighting: effectiveLighting,
    forceWebGL: params.backend === 'webgl2' || registryCd?.backend === 'webgl2',
    reversedDepthBuffer: params.reversedDepthBuffer,
    camera: caseCamera,
    logarithmicDepthBuffer: caseLogDepth,
    proceduralTextures: caseProcedural,
    // ADR-013 A6: the URL's diagnostic profile wins, then the case's
    // registered exception (below-deck-1km), then the LUT lookup
    atmosphereProfile: effectiveAtmosphereProfile(
      params.atmosphereProfile,
      registryCd?.atmosphereException
    )
  }
  let sideB: SideBHandle | null = null
  try {
    sideB = await createSideB(sideBOpts)
    sideB.applyCase(pc)
    logCollector(pc.name, 'B', 'clouds-chain-ready', {
      lighting: effectiveLighting,
      backend: params.backend
    })
  } catch (err) {
    logCollector(pc.name, 'B', 'init-failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    console.error('Side B init failed:', err)
  }

  // Apply registry-expanded state (quality preset + case overrides)
  if (registryCd != null) {
    const parityState = buildCaseParityState(registryCd)
    applyToA(parityState, sideA)
    if (sideB != null) applyToB(parityState, sideB)
    logCollector(pc.name, 'A', 'parity-state-applied', {
      preset: parityState.clouds?.multiScatteringOctaves,
      coverage: parityState.coverage,
      phase: registryCd.phase
    })
  }

  // Warm-up: identical frames with Δtime=0 so TAA converges, one browser
  // frame per render (see nextFrame)
  for (let i = 0; i < pc.warmup; i++) {
    sideA.render(0)
    sideB?.render()
    await nextFrame()
  }
  logCollector(pc.name, 'A', 'warmup-complete', { frames: pc.warmup })
  if (sideB != null) {
    logCollector(pc.name, 'B', 'warmup-complete', { frames: pc.warmup })
  }

  // Final render
  sideA.render(0)
  sideB?.render()
  logCollector(pc.name, 'A', 'rendered')
  if (sideB != null) {
    logCollector(pc.name, 'B', 'rendered')
  }

  // Capture mode
  if (params.capture) {
    await captureCanvas(canvasA, pc, 'A')
    logCollector(pc.name, 'A', 'capture-done')
    if (sideB != null) {
      await captureCanvas(canvasB, pc, 'B')
      logCollector(pc.name, 'B', 'capture-done')
    }
  }

  // E2E probe API
  if (params.e2e) {
    // Populated since module load: see the hoisted collector above
    const errors = e2eErrors
    const warnings = e2eWarnings

    // The convergence receipt: the fraction of pixels still changing
    // between the last two warm-up frames. The same call measured
    // 71.88 % cold and ~0 % warm, and nothing in the artifact told them apart
    const convergence: { A: number | null; B: number | null } = {
      A: null,
      B: null
    }
    const lastFrameMs: { A: number | null; B: number | null } = {
      A: null,
      B: null
    }
    const lastPasses = {
      A: { atlas: 0, march: 0, shadowLength: 0 },
      B: { atlas: 0, march: 0, shadowLength: 0 }
    }
    const targetIds = new WeakMap<object, number>()
    let nextTargetId = 1

    function targetId(target: object): number {
      const existing = targetIds.get(target)
      if (existing != null) return existing
      const id = nextTargetId++
      targetIds.set(target, id)
      return id
    }

    function classifyPassTarget(
      target: unknown
    ): keyof typeof lastPasses.B | null {
      if (sideB == null || target == null) return null
      const cp = sideB.cloudsPass as unknown as CloudsPassProbeAccess
      if (target === cp.layerRT) return 'march'
      if (
        target === cp.shadowRT ||
        target === cp.shadowResolveRT ||
        target === cp.shadowHistoryRT
      ) {
        return 'atlas'
      }
      // The shadow length rides in the resolve pair's second attachment: a
      // resolve into a two-attachment target IS the shadow-length resolve
      if (
        (target === cp.resolveRT || target === cp.historyRT) &&
        (target as ProbeRenderTarget).textures?.length === 2
      ) {
        return 'shadowLength'
      }
      return null
    }

    let activeBPasses: typeof lastPasses.B | null = null
    if (sideB != null) {
      const renderer = sideB.renderer as unknown as {
        setRenderTarget: (
          target: unknown,
          activeCubeFace?: number,
          activeMipmapLevel?: number
        ) => unknown
      }
      const original = renderer.setRenderTarget
      renderer.setRenderTarget = function (
        target: unknown,
        activeCubeFace?: number,
        activeMipmapLevel?: number
      ): unknown {
        const kind = classifyPassTarget(target)
        if (kind != null && activeBPasses != null) activeBPasses[kind]++
        return original.call(
          renderer,
          target,
          activeCubeFace,
          activeMipmapLevel
        )
      }
    }

    function beginBPassObservation(): void {
      activeBPasses = { atlas: 0, march: 0, shadowLength: 0 }
    }

    function finishBPassObservation(): void {
      if (activeBPasses != null) lastPasses.B = activeBPasses
      activeBPasses = null
    }

    /** B's linear plate, for the convergence receipt */
    async function readLinearB(): Promise<Float32Array> {
      if (sideB == null) return new Float32Array(0)
      sideB.renderLinear()
      const rt = sideB.linearRT
      const reader = sideB.renderer as unknown as AsyncPixelReader
      if (typeof reader.readRenderTargetPixelsAsync !== 'function') {
        return new Float32Array(0)
      }
      const buf = await reader.readRenderTargetPixelsAsync(
        rt,
        0,
        0,
        rt.width,
        rt.height
      )
      return toFloat32(unpadRows(buf, rt.width, rt.height))
    }

    function readLinearRT(): {
      width: number
      height: number
      data: Float32Array
    } {
      const rt = sideA.linearRT
      const w = rt.width
      const h = rt.height
      const gl = sideA.renderer.getContext()
      const fb = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      const props = (
        sideA.renderer as unknown as WebGLRendererInternals
      ).properties.get(rt.texture)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        props.__webglTexture ?? null,
        0
      )
      const buf = new Float32Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fb)
      // gl.readPixels is bottom-first, side B's readback top-first, so side A
      // is flipped here, once (the sky-pair A/B vertical-flip ruling,
      // ADR-013 Amendment 5: confirmed by the sun-disc arbiter at two poses)
      return { width: w, height: h, data: flipRowsTopFirst(buf, w, h) }
    }

    async function readRTPixels(
      rt: ProbeRenderTarget,
      textureIndex: number,
      faceIndex = 0
    ): Promise<{ width: number; height: number; data: Float32Array }> {
      if (sideB == null) throw new Error('Side B not available')
      const renderer = sideB.renderer as unknown as AsyncPixelReader
      if (typeof renderer.readRenderTargetPixelsAsync === 'function') {
        const buf = await renderer.readRenderTargetPixelsAsync(
          rt,
          0,
          0,
          rt.width,
          rt.height,
          textureIndex,
          faceIndex
        )
        return {
          width: rt.width,
          height: rt.height,
          data: toFloat32(unpadRows(buf, rt.width, rt.height))
        }
      }
      return {
        width: rt.width,
        height: rt.height,
        data: new Float32Array(rt.width * rt.height * 4)
      }
    }

    const probeCaseName = pc.name

    async function readSceneLinear(side: 'A' | 'B'): Promise<{
      width: number
      height: number
      data: Float32Array
    }> {
      assertSceneLinearReady(side, sideA, sideB)
      const t0 = performance.now()
      const result = await probe.readLinear(side)
      logCollector(probeCaseName, side, 'readSceneLinear', {
        w: result.width,
        h: result.height,
        ms: performance.now() - t0
      })
      return result
    }

    function serializeShadowKnobs(source: unknown): ProbeShadowKnobs {
      const shadow = source as {
        cascadeCount: number
        mapSize: { x: number; y: number }
        maxFar: number | null
        farScale: number
        splitMode: number | string
        splitLambda: number
        temporalPass: boolean
        temporalJitter: boolean
        maxIterationCount: number
        minStepSize: number
        maxStepSize: number
        minDensity: number
        minExtinction: number
        minTransmittance: number
        opticalDepthTailScale: number
      }
      const splitMode =
        typeof shadow.splitMode === 'number'
          ? shadow.splitMode
          : ['uniform', 'logarithmic', 'practical'].indexOf(shadow.splitMode)
      return {
        cascadeCount: shadow.cascadeCount,
        mapSize: [shadow.mapSize.x, shadow.mapSize.y],
        maxFar: shadow.maxFar,
        farScale: shadow.farScale,
        splitMode,
        splitLambda: shadow.splitLambda,
        temporalPass: shadow.temporalPass,
        temporalJitter: shadow.temporalJitter,
        maxIterationCount: shadow.maxIterationCount,
        minStepSize: shadow.minStepSize,
        maxStepSize: shadow.maxStepSize,
        minDensity: shadow.minDensity,
        minExtinction: shadow.minExtinction,
        minTransmittance: shadow.minTransmittance,
        opticalDepthTailScale: shadow.opticalDepthTailScale
      }
    }

    // B2: annotated, not `satisfies`, so an extra published member
    // is also caught (TS2353). Nested method returns stay unchecked (measured)
    const probe: ParityProbe = {
      caseName: pc.name,
      sideAHandle: sideA,
      sideBHandle: sideB,
      canvasA,
      canvasB,
      params,
      pc,
      errors,
      warnings,

      set(partial: Partial<ParityState>): void {
        scoredFrameIdB = null
        const t0 = performance.now()
        // this arrives from page.evaluate with its type erased, so a
        // flat nested key would otherwise be dropped in silence and the probe
        // would measure the old value while reporting the new one
        validateParityStatePartial(partial)
        applyToA(partial, sideA)
        if (sideB != null) applyToB(partial, sideB)
        logCollector(pc.name, 'A', 'set', { ms: performance.now() - t0 })
      },

      // `shadow` is a per-LAYER flag, not a ParityState key, so `set({ shadow
      // })` was a silent no-op (mail #635). These return the flags READ BACK
      // from both sides, and a runtime flip is measured to collapse the shadow
      setShadow(value: boolean) {
        scoredFrameIdB = null
        for (const layer of sideA.clouds.cloudLayers) {
          layer.shadow = value
        }
        if (sideB != null) {
          for (const layer of sideB.cloudsContext.cloudLayers) {
            layer.shadow = value
          }
        }
        const result = {
          A: [...sideA.clouds.cloudLayers].map(layer => layer.shadow),
          B:
            sideB != null
              ? [...sideB.cloudsContext.cloudLayers].map(layer => layer.shadow)
              : null
        }
        logCollector(pc.name, 'A', 'setShadow', { value, ...result })
        return result
      },

      setLayerShadows(values: readonly boolean[]) {
        scoredFrameIdB = null
        if (
          values.length !== sideA.clouds.cloudLayers.length ||
          (sideB != null &&
            values.length !== sideB.cloudsContext.cloudLayers.length)
        ) {
          throw new Error(
            `setLayerShadows expected ${sideA.clouds.cloudLayers.length} flags, ` +
              `received ${values.length}`
          )
        }
        values.forEach((value, index) => {
          sideA.clouds.cloudLayers[index]!.shadow = value
          if (sideB != null)
            sideB.cloudsContext.cloudLayers[index]!.shadow = value
        })
        const result = {
          A: [...sideA.clouds.cloudLayers].map(layer => layer.shadow),
          B:
            sideB != null
              ? [...sideB.cloudsContext.cloudLayers].map(layer => layer.shadow)
              : null
        }
        logCollector(pc.name, 'A', 'setLayerShadows', result)
        return result
      },

      // READ, never write, the temporalUpscale each side runs with. No
      // artifact recorded it, and showed case and live state diverging
      // (a sixteenth-bright plate that looked like a dim render, not an error)
      readTemporalUpscale() {
        const result = {
          A: sideA.clouds.temporalUpscale,
          B: sideB != null ? sideB.cloudsContext.temporalUpscale : null
        }
        logCollector(pc.name, 'A', 'readTemporalUpscale', result)
        return result
      },

      // `lightShafts` IS routed through set() (parityState.ts:292), unlike
      // `shadow`, but routed is not applied: side A's shaft path changes the
      // MRT count and may need a recreate. The read-back says which happened
      setLightShafts(value: boolean) {
        scoredFrameIdB = null
        sideA.clouds.lightShafts = value
        if (sideB != null) {
          sideB.cloudsContext.lightShafts = value
        }
        const result = {
          A: sideA.clouds.lightShafts,
          B: sideB != null ? sideB.cloudsContext.lightShafts : null
        }
        logCollector(pc.name, 'A', 'setLightShafts', { value, ...result })
        return result
      },

      readShadowKnobs() {
        const result = {
          A: serializeShadowKnobs(sideA.clouds.shadow),
          B:
            sideB != null
              ? serializeShadowKnobs(sideB.cloudsContext.shadow)
              : null
        }
        logCollector(pc.name, 'A', 'readShadowKnobs', result)
        return result
      },

      /** changed% between the last two warm-up frames, per side */
      convergence() {
        return { A: convergence.A, B: convergence.B }
      },

      async renderOnce(
        side: 'A' | 'B',
        opts: {
          time: number
          frame: number
          warmup?: number
          /**
           * Defaults to TRUE: `warmup N` must mean N frames from cold,
           * or the same call returns a different plate depending on what the
           * page rendered earlier. Pass false only where continuing is the
           * point, as the sequence paths accumulate across frames.
           */
          resetHistory?: boolean
        }
      ): Promise<void> {
        const t0 = performance.now()
        const w = opts.warmup ?? 0
        // Before the warm-up, so the w frames below are the FIRST w frames the
        // accumulator sees. Without it, "warmup 64" meant 71.88 % changed on a
        // cold page and fully converged on a warm one
        if (opts.resetHistory !== false) {
          if (side === 'A') sideA.resetTemporalHistory()
          else sideB?.resetTemporalHistory()
        }
        if (side === 'B' && sideB != null) {
          rebaseNodeFrameId(sideB)
        }
        // both sides gate the march on `bayerValue == frame % 16`, so
        // both must advance identically. Read the LIVE flag, not
        // `pc.knobs`, or a set() temporal case marches one cell in sixteen
        const temporal = planTemporal(side, sideA.clouds, sideB?.cloudsContext)
        // Every call lands on the SAME final frame with its warm-up as the w+1
        // frames before it (counting up left A and B on different Bayer cells,
        // 0.7226 vs 0.9395). warmupFramePlan is extracted and tested (hjhq).
        const plan = warmupFramePlan(opts.frame, w, temporal)
        const warmupFrame = (i: number): number => plan[i]!
        if (side === 'B') beginBPassObservation()
        if (side === 'A') {
          const parityClouds =
            sideA.clouds.constructor.name === 'ParityCloudsEffect'
              ? (sideA.clouds as unknown as { frameOverride: number })
              : undefined
          for (let i = 0; i < w; i++) {
            if (parityClouds != null)
              parityClouds.frameOverride = warmupFrame(i)
            sideA.render(0)
            await nextFrame()
          }
          // Read BEFORE the final frame, then after it: the two reads bracket
          // the last warm-up step, which is the increment the receipt is about
          const prevA = w > 0 ? Float32Array.from(readLinearRT().data) : null
          if (parityClouds != null) parityClouds.frameOverride = warmupFrame(w)
          sideA.render(0)
          convergence.A =
            prevA != null ? changedFraction(prevA, readLinearRT().data) : null
        } else {
          if (sideB == null) throw new Error('Side B not available')
          sideB.cloudsContext.time = opts.time
          // a fixed `frame` marched ONE Bayer cell (4x4 blocks), so
          // the warm-up counts FORWARD from the pinned frame, `time` pinned
          // pin the node frameId at every step as well
          for (let i = 0; i < w; i++) {
            sideB.cloudsContext.frame = warmupFrame(i)
            setSequenceFrameId(sideB, i)
            sideB.render()
            await nextFrame()
          }
          await nextFrame()
          // Same bracket as side A. After the extra read was added it shares the
          // frame id, so it adds no pre-pass. The awaits moved the id on, so it
          // is set back to the last warm-up step's
          if (w > 0) setSequenceFrameId(sideB, w - 1)
          const prevB = w > 0 ? Float32Array.from(await readLinearB()) : null
          sideB.cloudsContext.frame = warmupFrame(w)
          setSequenceFrameId(sideB, w)
          scoredFrameIdB = captureFrameBase + w
          sideB.render()
          convergence.B =
            prevB != null ? changedFraction(prevB, await readLinearB()) : null
        }
        if (side === 'B') finishBPassObservation()
        lastFrameMs[side] = performance.now() - t0
        logCollector(pc.name, side, 'renderOnce', {
          frame: opts.frame,
          time: opts.time,
          ms: lastFrameMs[side]
        })
      },

      async renderSequence(opts: {
        frames: number
        dt: number
        warmup: number
      }) {
        const { frames, dt, warmup } = opts
        const framesA: Float32Array[] = []
        const framesB: Float32Array[] = []

        // Reset history: re-apply case to clear temporal state
        sideA.applyCase(pc)
        if (sideB != null) sideB.applyCase(pc)

        // Warm-up phase
        if (sideB != null) rebaseNodeFrameId(sideB)
        for (let i = 0; i < warmup; i++) {
          sideA.render(0)
          sideB?.render()
          await nextFrame()
        }
        logCollector(pc.name, 'A', 'seq-warmup', { frames: warmup })

        // Capture frames
        for (let f = 0; f < frames; f++) {
          const time = f * dt
          if (sideA.clouds.constructor.name === 'ParityCloudsEffect') {
            ;(
              sideA.clouds as unknown as { frameOverride: number }
            ).frameOverride = f
          }
          sideA.render(dt)
          if (sideB != null) {
            sideB.cloudsContext.time = time
            sideB.cloudsContext.frame = f
            setSequenceFrameId(sideB, f)
            sideB.render()
            // No yield, as in sequenceStep below: it would advance frameId and
            // re-run the shadow pre-pass for the linear read. No callers today,
            // fixed anyway so a future one cannot reintroduce that shape
          }

          const linA = readLinearRT()
          framesA.push(Float32Array.from(linA.data))

          if (sideB != null) {
            sideB.renderLinear()
            const rt = sideB.linearRT
            const renderer = sideB.renderer as unknown as AsyncPixelReader
            let data: Float32Array
            if (typeof renderer.readRenderTargetPixelsAsync === 'function') {
              const buf = await renderer.readRenderTargetPixelsAsync(
                rt,
                0,
                0,
                rt.width,
                rt.height
              )
              data = toFloat32(unpadRows(buf, rt.width, rt.height))
            } else {
              data = new Float32Array(rt.width * rt.height * 4)
            }
            framesB.push(Float32Array.from(data))
          }

          logCollector(pc.name, 'A', 'seq-frame', {
            frame: f,
            time: time.toFixed(3)
          })
        }

        const linA = readLinearRT()
        return {
          framesA,
          framesB,
          width: linA.width,
          height: linA.height
        }
      },

      async sequenceInit(warmup: number): Promise<void> {
        sideA.applyCase(pc)
        if (sideB != null) sideB.applyCase(pc)
        for (let i = 0; i < warmup; i++) {
          sideA.render(0)
          sideB?.render()
          await nextFrame()
        }
        probeWindow.__seqFramesA = []
        probeWindow.__seqFramesB = []
        probeWindow.__seqDims = { width: 0, height: 0 }
        if (sideB != null) rebaseNodeFrameId(sideB)
        logCollector(pc.name, 'A', 'seq-warmup', { frames: warmup })
      },

      async sequenceStep(
        frame: number,
        dt: number,
        motion?: {
          cameraVelocity?: readonly [number, number, number]
          sunVelocity?: readonly [number, number]
        }
      ) {
        // Loaded HERE, before any render. An await between the display
        // and linear renders advances frameId and re-runs the shadow pre-pass,
        // double-blending B's history, so the module is awaited up front
        const seqMetricsMod = await import('./metrics/index')
        const time = frame * dt

        // ONE offset from the harness's own `time`, written to both
        // cameras, absolute from the base pose. Per-side poses or clocks would
        // diverge and read as a port bug (the two-writes trap)
        let cameraReceipt: {
          A: [number, number, number]
          B: [number, number, number] | null
          expected: [number, number, number]
        } | null = null
        if (motion?.cameraVelocity != null) {
          const [vx, vy, vz] = motion.cameraVelocity
          pc.camera(sideA.camera)
          const expected: [number, number, number] = [
            sideA.camera.position.x + vx * time,
            sideA.camera.position.y + vy * time,
            sideA.camera.position.z + vz * time
          ]
          sideA.camera.position.set(...expected)
          sideA.camera.updateMatrixWorld()
          if (sideB != null) {
            pc.camera(sideB.camera)
            sideB.camera.position.set(...expected)
            sideB.camera.updateMatrixWorld()
          }
          cameraReceipt = {
            A: [
              sideA.camera.position.x,
              sideA.camera.position.y,
              sideA.camera.position.z
            ],
            B:
              sideB != null
                ? [
                    sideB.camera.position.x,
                    sideB.camera.position.y,
                    sideB.camera.position.z
                  ]
                : null,
            expected
          }
        }
        // Sun half: ONE pair of angles from the harness's `time`, set
        // on both sides, absolute from the base sun. The receipt reads back
        // each side's direction VECTOR, which is what the shader consumes
        let sunReceipt: {
          elevation: number
          azimuth: number
          A: [number, number, number]
          B: [number, number, number] | null
        } | null = null
        if (motion?.sunVelocity != null) {
          const [vEl, vAz] = motion.sunVelocity
          const elevation = pc.sun.elevation + vEl * time
          const azimuth = pc.sun.azimuth + vAz * time
          sideA.setSun(elevation, azimuth)
          sideB?.setSun(elevation, azimuth)
          const a = sideA.clouds.sunDirection
          const b = sideB?.cloudsContext.sunDirection
          sunReceipt = {
            elevation,
            azimuth,
            A: [a.x, a.y, a.z],
            B: b != null ? [b.x, b.y, b.z] : null
          }
        }
        if (sideA.clouds.constructor.name === 'ParityCloudsEffect') {
          ;(
            sideA.clouds as unknown as { frameOverride: number }
          ).frameOverride = frame
        }
        sideA.render(dt)
        if (sideB != null) {
          sideB.cloudsContext.time = time
          sideB.cloudsContext.frame = frame
          setSequenceFrameId(sideB, frame)
          sideB.render()
          // NO yield here. A yield lets rAF advance frameId, so the
          // shadow pre-pass runs a SECOND time for the linear read: history
          // blended twice, velocity lane ~0. Sharing the frameId dedups it
        }

        const linA = readLinearRT()
        probeWindow.__seqFramesA?.push(Float32Array.from(linA.data))

        // from the buffer already read, and
        // the same computePlateStats as the still's plate.A.mean, so it
        // compares directly with the committed still
        const plateMeanA = seqMetricsMod.computePlateStats(linA.data, 4).mean
        let plateMeanB: number | null = null

        if (sideB != null) {
          sideB.renderLinear()
          const rt = sideB.linearRT
          const renderer = sideB.renderer as unknown as AsyncPixelReader
          let data: Float32Array
          if (typeof renderer.readRenderTargetPixelsAsync === 'function') {
            const buf = await renderer.readRenderTargetPixelsAsync(
              rt,
              0,
              0,
              rt.width,
              rt.height
            )
            data = toFloat32(unpadRows(buf, rt.width, rt.height))
          } else {
            data = new Float32Array(rt.width * rt.height * 4)
          }
          probeWindow.__seqFramesB?.push(Float32Array.from(data))
          plateMeanB = seqMetricsMod.computePlateStats(data, 4).mean
        }

        probeWindow.__seqDims = {
          width: linA.width,
          height: linA.height
        }
        logCollector(pc.name, 'A', 'seq-frame', {
          frame,
          time: time.toFixed(3),
          plateMeanA,
          plateMeanB
        })
        return {
          width: linA.width,
          height: linA.height,
          camera: cameraReceipt,
          sun: sunReceipt,
          // Per side, per frame. B is null when side B is absent: an absent
          // side must read as ABSENT, never as a plate mean of 0, which would
          // be a real-looking value for a side that never rendered
          plateMean: { A: plateMeanA, B: plateMeanB }
        }
      },

      // the shadow VELOCITY lane, separately for each of the TWO
      // cloudsPass executions per sequence frame (render + renderLinear), over
      // several frames. Null from both refutes the self-reprojection theory
      async shadowVelocityProbe(opts: {
        frames: number
        dt: number
        cameraVelocity: [number, number, number]
        cascade?: number
        // Whether to yield between B's two renders. true reproduces the
        // pre-fix capture flow (frameId advances, pre-pass runs twice);
        // false reproduces the fixed flow (shared frameId, dedup, one pass)
        yieldBetween?: boolean
      }) {
        if (sideB == null) return null
        const cascade = opts.cascade ?? 0
        const EMPTY: VelocityStats = {
          present: false,
          texels: 0,
          meanMag: 0,
          maxMag: 0,
          nonZeroFrac: 0
        }

        async function readVelocity(): Promise<VelocityStats> {
          if (sideB == null) return EMPTY
          const rt = (sideB.cloudsPass as unknown as ShadowVelocityAccess)
            .shadowRT
          if (rt == null || rt.textures.length < 2) return EMPTY
          const reader = sideB.renderer as unknown as AsyncPixelReader
          if (typeof reader.readRenderTargetPixelsAsync !== 'function') {
            return EMPTY
          }
          // (target, x, y, w, h, textureIndex, faceIndex): the velocity is
          // attachment 1 and the cascade is the array LAYER. This read used to
          // pass the cascade as the textureIndex, which only worked for 0
          const buf = await reader.readRenderTargetPixelsAsync(
            rt,
            0,
            0,
            rt.width,
            rt.height,
            1,
            cascade
          )
          const data = toFloat32(unpadRows(buf, rt.width, rt.height))
          const n = rt.width * rt.height
          let sum = 0
          let max = 0
          let nonZero = 0
          for (let i = 0; i < n; i++) {
            const vx = data[i * 4 + 1] ?? 0
            const vy = data[i * 4 + 2] ?? 0
            const mag = Math.hypot(vx, vy)
            if (!Number.isFinite(mag)) continue
            sum += mag
            if (mag > max) max = mag
            // A tenth of a texel: below this the lane is doing nothing a
            // reprojection could act on
            if (mag > 0.1) nonZero++
          }
          return {
            present: true,
            texels: n,
            meanMag: sum / n,
            maxMag: max,
            nonZeroFrac: nonZero / n
          }
        }

        // The decisive datum for that trap, read from the renderer: the same
        // frameId for both executions means three deduped the second pre-pass,
        // N and N+1 means it ran twice
        function currentFrameId(): number {
          if (sideB == null) return Number.NaN
          const nodes = (
            sideB.renderer as unknown as {
              _nodes?: { nodeFrame?: { frameId: number } }
            }
          )._nodes
          return nodes?.nodeFrame?.frameId ?? Number.NaN
        }

        async function readResolveMean(): Promise<number> {
          if (sideB == null) return Number.NaN
          const rt = (sideB.cloudsPass as unknown as ShadowVelocityAccess)
            .shadowResolveRT
          if (rt == null) return Number.NaN
          const reader = sideB.renderer as unknown as AsyncPixelReader
          if (typeof reader.readRenderTargetPixelsAsync !== 'function') {
            return Number.NaN
          }
          const buf = await reader.readRenderTargetPixelsAsync(
            rt,
            0,
            0,
            rt.width,
            rt.height,
            cascade
          )
          const data = toFloat32(unpadRows(buf, rt.width, rt.height))
          const n = rt.width * rt.height
          let sum = 0
          for (let i = 0; i < n; i++) sum += data[i * 4] ?? 0
          return sum / n
        }

        const out: Array<{
          frame: number
          afterRender: VelocityStats
          afterRenderLinear: VelocityStats
          resolveAfterRender: number
          resolveAfterRenderLinear: number
          frameIdRender: number
          frameIdRenderLinear: number
        }> = []
        const [vx, vy, vz] = opts.cameraVelocity
        for (let frame = 0; frame < opts.frames; frame++) {
          const time = frame * opts.dt
          // Same absolute-from-base motion as sequenceStep
          pc.camera(sideB.camera)
          sideB.camera.position.set(
            sideB.camera.position.x + vx * time,
            sideB.camera.position.y + vy * time,
            sideB.camera.position.z + vz * time
          )
          sideB.camera.updateMatrixWorld()
          sideB.cloudsContext.time = time
          sideB.cloudsContext.frame = frame
          setSequenceFrameId(sideB, frame)

          // Execution 1: the display pipeline, exactly as sequenceStep runs it
          const frameIdRender = currentFrameId()
          sideB.render()
          const afterRender = await readVelocity()
          const resolveAfterRender = await readResolveMean()

          // the one sanctioned yield, since reproducing the defect is
          // this probe's purpose. Its readbacks yield too, so it cannot
          // validate the fixed flow, which the plate comparison does
          if (opts.yieldBetween !== false) await nextFrame()

          // Execution 2: the linear pipeline, the one the plate is read from
          const frameIdRenderLinear = currentFrameId()
          sideB.renderLinear()
          const afterRenderLinear = await readVelocity()
          const resolveAfterRenderLinear = await readResolveMean()

          out.push({
            frame,
            afterRender,
            afterRenderLinear,
            resolveAfterRender,
            resolveAfterRenderLinear,
            frameIdRender,
            frameIdRenderLinear
          })
          logCollector(pc.name, 'B', 'zl5f-velocity', {
            frame,
            renderMean: afterRender.meanMag.toExponential(3),
            renderMax: afterRender.maxMag.toExponential(3),
            linearMean: afterRenderLinear.meanMag.toExponential(3),
            linearMax: afterRenderLinear.maxMag.toExponential(3),
            fidR: frameIdRender,
            fidL: frameIdRenderLinear,
            resolveDelta: (
              resolveAfterRenderLinear - resolveAfterRender
            ).toExponential(3)
          })
        }
        return out
      },

      async sequenceMetrics(opts: {
        frames: number
        dt: number
      }): Promise<ProbeSequenceMetrics> {
        const metricsMod = await import('./metrics/index')
        const storedA = probeWindow.__seqFramesA ?? []
        const storedB = probeWindow.__seqFramesB ?? []
        const dims = probeWindow.__seqDims

        const flickerA = metricsMod.computeFlicker(
          storedA,
          dims.width,
          dims.height,
          4
        )
        const flickerB = metricsMod.computeFlicker(
          storedB,
          dims.width,
          dims.height,
          4
        )

        let ghostingA: { deMean: number; deP95: number } | null = null
        let ghostingB: { deMean: number; deP95: number } | null = null
        const motion = computeSequenceMotion(metricsMod, storedA, storedB, dims)

        if (storedA.length > 0 && storedB.length > 0) {
          const lastFrame = opts.frames - 1
          const lastTime = lastFrame * opts.dt

          await probe.renderOnce('A', {
            time: lastTime,
            frame: lastFrame,
            warmup: 0
          })
          const linAOff = readLinearRT()

          await probe.renderOnce('B', {
            time: lastTime,
            frame: lastFrame,
            warmup: 0
          })
          const linBOff = await probe.readLinear('B')

          const lastA = storedA[storedA.length - 1]!
          const lastB = storedB[storedB.length - 1]!

          if (linAOff.data.length > 0 && lastA.length > 0) {
            ghostingA = metricsMod.computeGhosting(
              lastA,
              linAOff.data,
              dims.width,
              dims.height,
              4
            )
          }
          if (linBOff.data.length > 0 && lastB.length > 0) {
            ghostingB = metricsMod.computeGhosting(
              lastB,
              new Float32Array(linBOff.data),
              dims.width,
              dims.height,
              4
            )
          }
        }

        // Clean up stored frames
        probeWindow.__seqFramesA = null
        probeWindow.__seqFramesB = null

        return {
          flickerA: { mean: flickerA.mean, max: flickerA.max },
          flickerB: { mean: flickerB.mean, max: flickerB.max },
          ghostingA,
          ghostingB,
          ...motion
        }
      },

      async readLinear(side: 'A' | 'B') {
        const t0 = performance.now()
        if (side === 'A') {
          const result = readLinearRT()
          logCollector(pc.name, 'A', 'readLinear', {
            w: result.width,
            h: result.height,
            ms: performance.now() - t0
          })
          return result
        }
        if (sideB == null) throw new Error('Side B not available')
        // no yield first. Re-running the pre-passes for the linear
        // read double-blended the shadow history. This call arrives in a later
        // task, so the pinned render's frameId is restored first
        restoreScoredFrameIdB(sideB)
        sideB.renderLinear()
        const rt = sideB.linearRT
        const w = rt.width
        const h = rt.height
        const renderer = sideB.renderer as unknown as AsyncPixelReader
        let data: Float32Array
        if (typeof renderer.readRenderTargetPixelsAsync === 'function') {
          const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h)
          data = toFloat32(unpadRows(buf, w, h))
        } else {
          data = new Float32Array(w * h * 4)
        }
        logCollector(pc.name, 'B', 'readLinear', {
          w,
          h,
          ms: performance.now() - t0
        })
        return { width: w, height: h, data }
      },
      readSceneLinear,

      // Step 1: the site-2 PCF radius lane. Returns null, never a
      // zero-filled buffer, when side B built no lane, so the capture can
      // REFUSE. A missing instrument must read as missing
      async readShadowRadius() {
        if (sideB == null) throw new Error('Side B not available')
        const t0 = performance.now()
        // Rendered here: this lane is off the scored path and nothing else
        // draws it. It samples the pinned render's frame, like readLinear('B')
        restoreScoredFrameIdB(sideB)
        if (!sideB.renderShadowRadius()) return null
        const rt = sideB.shadowRadiusRT
        if (rt == null) return null
        const result = await readRTPixels(rt as ProbeRenderTarget, 0)
        logCollector(pc.name, 'B', 'readShadowRadius', {
          w: result.width,
          h: result.height,
          ms: performance.now() - t0
        })
        return result
      },

      /**
       * a ground patch drawn with `cloudShadowAt(positionWorld)` and
       * nothing else, off the scored path. Its texels ARE the 0..1
       * transmittance a custom material would multiply by
       */
      async readCloudShadowProbe() {
        if (sideB == null) throw new Error('Side B not available')
        const t0 = performance.now()
        restoreScoredFrameIdB(sideB)
        const { anchorECEF, enuAtAnchor } = sideB.sceneResult
        const probe = (sideB as unknown as { cloudShadowProbe?: ProbeHolder })
          .cloudShadowProbe
        // Minted once per side: the material is a graph, and a fresh one per
        // read would recompile the sampler on every call
        const holder =
          probe ??
          ((
            sideB as unknown as { cloudShadowProbe: ProbeHolder }
          ).cloudShadowProbe = {
            value: createCloudShadowProbe({
              renderer: sideB.renderer,
              pass: sideB.cloudsPass,
              anchorECEF,
              enuAtAnchor
            })
          })
        const result = await holder.value.render()
        logCollector(pc.name, 'B', 'readCloudShadowProbe', {
          w: result.width,
          h: result.height,
          min: result.min,
          max: result.max,
          ms: performance.now() - t0
        })
        return result
      },

      async readLayer() {
        if (sideB == null) throw new Error('Side B not available')
        const t0 = performance.now()
        const rt = (sideB.cloudsPass as unknown as LayerRTHolder).layerRT
        const result = await readRTPixels(rt, 0)
        logCollector(pc.name, 'B', 'readLayer', {
          w: result.width,
          h: result.height,
          ms: performance.now() - t0
        })
        return result
      },

      async readDepthVelocity() {
        if (sideB == null) throw new Error('Side B not available')
        const t0 = performance.now()
        const rt = (sideB.cloudsPass as unknown as LayerRTHolder).layerRT
        const result = await readRTPixels(rt, 1)
        logCollector(pc.name, 'B', 'readDepthVelocity', {
          w: result.width,
          h: result.height,
          ms: performance.now() - t0
        })
        return result
      },

      async readShadowAtlas() {
        if (sideB == null) throw new Error('Side B not available')
        const cp = sideB.cloudsPass as unknown as CloudsPassProbeAccess
        const map = sideB.cloudsPass.cloudShadow.map
        const historyIsPublished = cp.shadowHistoryRT?.texture === map
        const rt = historyIsPublished ? cp.shadowHistoryRT : cp.shadowRT
        if (rt == null) throw new Error('Shadow atlas not allocated')
        const depth = rt.texture?.image?.depth ?? rt.depth ?? 0
        if (depth <= 0) throw new Error('Shadow atlas has no array layers')
        const layers = []
        for (let layer = 0; layer < depth; layer++) {
          layers.push(await readRTPixels(rt, 0, layer))
        }
        const rayExtents = buildShadowRayExtentLayers(
          shadowRayExtentGeometryB(sideB, cp),
          rt.width,
          rt.height,
          depth
        )
        const result = {
          width: rt.width,
          height: rt.height,
          depth,
          temporalPass: sideB.cloudsContext.shadow.temporalPass,
          maxShadowRayExtentUnit: shadowRayExtentCeilingUnit(
            sideB.cloudsContext.bottomRadius
          ),
          source: historyIsPublished ? ('history' as const) : ('raw' as const),
          layers,
          rayExtents
        }
        logCollector(pc.name, 'B', 'readShadowAtlas', {
          w: result.width,
          h: result.height,
          depth: result.depth,
          source: result.source
        })
        return result
      },

      /**
       * side A's raw shadow atlas, per cascade. The lane that was
       * missing.
       *
       * A composited plate cannot substitute for it: the aerial post-lighting
       * factor K and the optical depth enter only as `K · exp(-od)`, so the same
       * plate reads equally as "B's optical depth is 15x larger" and as "K
       * differs 15x". Side A's atlas is a WebGLArrayRenderTarget, so this is a
       * framebufferTextureLayer + readPixels per array layer.
       *
       * Rows stay in gl.readPixels' own bottom-first order, which is the order
       * `reconstructShadowRayExtent`'s row 0 → clipY -1 correspondence expects,
       * so both sides answer the twin in one frame of reference
       */
      readShadowAtlasA(): ProbeAtlasA {
        const t0 = performance.now()
        const shadowPass = sideA.clouds.shadowPass
        const depth = shadowPass.shadow.cascadeCount
        const layerCount = atlasCascadeLayerCount({
          depth,
          temporalPass: shadowPass.temporalPass,
          raw: false
        })
        // outputBuffer is the reference's own published accessor: the
        // already-swapped history texture with the temporal pass on, the
        // current target without it (ShadowPass.ts:164-171)
        const texture = shadowPass.outputBuffer
        const image = texture.image as { width?: number; height?: number }
        const width = image.width ?? 0
        const height = image.height ?? 0
        const webglTexture = (
          sideA.renderer as unknown as WebGLRendererInternals
        ).properties.get(texture).__webglTexture
        if (webglTexture == null) {
          throw new Error('Side A shadow atlas texture is not uploaded')
        }
        const read = readAtlasLayersGL({
          gl: sideA.renderer.getContext() as unknown as AtlasGLReader,
          texture: webglTexture,
          width,
          height,
          layerCount
        })
        const result: ProbeAtlasA = {
          width,
          height,
          depth,
          temporalPass: shadowPass.temporalPass,
          maxShadowRayExtentUnit: shadowRayExtentCeilingUnit(
            shadowPass.currentMaterial.uniforms.bottomRadius.value
          ),
          source: shadowPass.temporalPass
            ? ('history' as const)
            : ('raw' as const),
          layers: read.layers.map(data => ({ width, height, data })),
          rayExtents: buildShadowRayExtentLayers(
            shadowRayExtentGeometryA(sideA.clouds),
            width,
            height,
            layerCount
          ),
          preexistingGlErrors: read.preexistingErrors,
          atlasUnits: 'metres' as const,
          ms: performance.now() - t0
        }
        logCollector(pc.name, 'A', 'readShadowAtlas', {
          w: result.width,
          h: result.height,
          depth: result.depth,
          source: result.source
        })
        return result
      },

      async readShadowLength() {
        if (sideB == null) throw new Error('Side B not available')
        if (!sideB.cloudsContext.lightShafts) return null
        const cp = sideB.cloudsPass as unknown as CloudsPassProbeAccess
        const rt = cp.historyRT
        if (rt == null || rt.textures?.length !== 2) {
          throw new Error('Shadow-length history not allocated')
        }
        // The second attachment of the colour/shadow-length history pair
        const result = await readRTPixels(rt, 1)
        logCollector(pc.name, 'B', 'readShadowLength', {
          w: result.width,
          h: result.height
        })
        return result
      },

      sampleShadowOD(input: {
        texel: readonly [number, number, number, number]
        distanceToTop: number
        distanceOffset?: number
        worldToUnit?: number
      }) {
        const [r, g, b, a] = input.texel
        const worldToUnit = input.worldToUnit ?? 1
        const distanceToFront = Math.max(
          0,
          input.distanceToTop - r / worldToUnit
        )
        const inCloudDistance = Math.max(
          0,
          distanceToFront - (input.distanceOffset ?? 0)
        )
        const result = {
          inCloud: Math.min(b + a, g * inCloudDistance),
          ground: Math.min(b, g * distanceToFront)
        }
        logCollector(pc.name, 'B', 'sampleShadowOD', result)
        return result
      },

      stats(side: 'A' | 'B'): ProbeStats {
        if (side === 'A') {
          return {
            frame: (sideA.clouds as unknown as { frame?: number }).frame ?? 0,
            time: 0,
            frameMs: lastFrameMs.A,
            passes: lastPasses.A,
            targets: []
          }
        }
        if (sideB == null) {
          return {
            frame: 0,
            time: 0,
            frameMs: null,
            passes: lastPasses.B,
            targets: []
          }
        }
        const cp = sideB.cloudsPass as unknown as CloudsPassProbeAccess
        const targets = [
          ['layer', cp.layerRT],
          ['shadowAtlas.raw', cp.shadowRT],
          ['shadowAtlas.resolve', cp.shadowResolveRT],
          ['shadowAtlas.history', cp.shadowHistoryRT],
          ['clouds.resolve', cp.resolveRT],
          ['clouds.history', cp.historyRT]
        ] as const
        return {
          frame: sideB.cloudsContext.frame,
          time: sideB.cloudsContext.time,
          frameMs: lastFrameMs.B,
          passes: lastPasses.B,
          targets: targets.flatMap(([name, target]) =>
            target == null
              ? []
              : [
                  {
                    id: targetId(target),
                    name,
                    width: target.width,
                    height: target.height,
                    depth: target.texture?.image?.depth ?? target.depth ?? 1,
                    attachments: target.textures?.length ?? 1,
                    format: 'HalfFloat'
                  }
                ]
          )
        }
      },

      regions(_side: 'A' | 'B') {
        return { sphere: null, plane: null }
      },

      async gpuTiming(frameCount = 32): Promise<GpuTimingSummary> {
        // renders side B on the Animation loop's frames
        scoredFrameIdB = null
        const gl = sideA.renderer.getContext() as WebGL2RenderingContext
        const timerA = new WebGLGpuTimer(gl)
        const collectorA = new GpuTimingCollector(frameCount)

        const timerB =
          sideB != null
            ? new WebGPUGpuTimer(
                sideB.renderer as unknown as ConstructorParameters<
                  typeof WebGPUGpuTimer
                >[0]
              )
            : null
        const collectorB = new GpuTimingCollector(frameCount)

        for (let i = 0; i < frameCount + 2; i++) {
          // Collect any ready results from previous frames
          if (timerA.available) {
            const sample = timerA.collectPending()
            if (sample) collectorA.add(sample)
          }

          // Side A: wrap composer.render() with timer query
          if (timerA.available) {
            timerA.beginPass('total')
            sideA.render(0)
            timerA.endPass()
            timerA.endFrame()
          } else {
            sideA.render(0)
          }

          // Side B: render + resolve timestamp
          if (sideB != null) {
            sideB.render()
            if (timerB != null && timerB.available) {
              const sample = await timerB.resolve()
              if (sample) collectorB.add(sample)
            }
          }

          // Allow browser to flush GPU commands
          await new Promise(r => setTimeout(r, 0))
        }

        // Drain remaining WebGL queries
        if (timerA.available) {
          for (let attempt = 0; attempt < 100; attempt++) {
            const sample = timerA.collectPending()
            if (sample) collectorA.add(sample)
            if (collectorA.ready) break
            await new Promise(r => setTimeout(r, 2))
          }
        }

        timerA.dispose()

        logCollector(pc.name, 'A', 'gpu-timing', {
          available: timerA.available,
          samples: collectorA.count
        })
        if (sideB != null) {
          logCollector(pc.name, 'B', 'gpu-timing', {
            available: timerB?.available ?? false,
            samples: collectorB.count
          })
        }

        return buildTimingSummary(
          collectorA,
          collectorB,
          timerA.available ? null : timerA.reason,
          timerB != null
            ? timerB.available
              ? null
              : timerB.reason
            : 'Side B not available'
        )
      }
    }

    // The probe's declaration carries the type (see `const probe: ParityProbe`
    // above); this is a plain assignment
    ;(window as unknown as { __parity: ParityProbe }).__parity = probe
    logCollector(pc.name, 'A', 'e2e-probe-registered')
    if (sideB != null) {
      logCollector(pc.name, 'B', 'e2e-probe-registered')
    }
  }

  // Live interactive mode (skip in capture/e2e)
  if (!params.capture && !params.e2e) {
    setupLiveMode(pc.name, sideA, sideB)

    function loop(): void {
      sideA.render(0)
      sideB?.render()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }
}

function setupLiveMode(
  caseName: string,
  sideA: SideAHandle,
  sideB: SideBHandle | null
): void {
  const sideAEl = document.getElementById('side-a')!
  const sideBEl = document.getElementById('side-b')!
  const toolbar = document.getElementById('view-toolbar')!
  const panelContainer = document.getElementById('panel-container')!

  toolbar.style.display = ''

  const viewState = createViewState()
  viewState.mode = params.view

  const liveState = defaultLiveState()
  const registryCase = caseByName(caseName)
  if (registryCase != null) {
    Object.assign(liveState, registryCase.state)
    liveState['sunElevation'] = registryCase.sun.elevation
    liveState['sunAzimuth'] = registryCase.sun.azimuth
  }

  function applyView(): void {
    applyViewMode(sideAEl, sideBEl, canvasA, canvasB, viewState)
  }

  // The panel used to only log. A change now re-derives the case with
  // that override and replays it through the case loader's own paths, so a
  // control matches a capture. Live mode only, the ladder is untouched
  function applyLiveKnob(key: string, value: unknown): void {
    const cd = caseByName(caseName)
    if (cd == null) return
    const isStateKey = Object.prototype.hasOwnProperty.call(BASE_STATE, key)
    const merged: CaseDefinition = {
      ...cd,
      sun: {
        elevation:
          key === 'sunElevation' ? (value as number) : cd.sun.elevation,
        azimuth: key === 'sunAzimuth' ? (value as number) : cd.sun.azimuth
      },
      state: isStateKey ? { ...cd.state, [key]: value } : cd.state
    }
    const pc = caseToParityCase(merged)
    sideA.applyCase(pc)
    sideB?.applyCase(pc)
    const state = buildCaseParityState(merged)
    applyToA(state, sideA)
    if (sideB != null) applyToB(state, sideB)
  }

  function setView(mode: ViewMode): void {
    viewState.mode = mode
    applyView()
    updateUrl(caseName, mode, new URLSearchParams(window.location.search))
    for (const btn of toolbar.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset['view'] === mode)
    }
  }

  toolbar.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('button')
    if (btn?.dataset['view']) {
      setView(btn.dataset['view'] as ViewMode)
    }
  })

  buildPanel(
    panelContainer,
    liveState,
    viewState,
    (key, value) => {
      if (key === '_viewUpdate') {
        applyView()
        return
      }
      liveState[key] = value
      applyLiveKnob(key, value)
      logCollector(caseName, 'A', 'knob-changed', { key, value })
    },
    mode => setView(mode)
  )

  applyView()
  logCollector(caseName, 'A', 'live-mode-active')
}

// Load gate numbers: prefer build-time env, fall back to API
try {
  // VITE_GATES is injected at build time by vite-plugin-gates
  const gatesData: string | undefined = import.meta.env.VITE_GATES
  if (gatesData) {
    gatesEl.textContent = gatesData
  } else {
    fetch(sitePath('api/gates.json'))
      .then(r => (r.ok ? r.json() : null))
      .then((data: { summary?: string } | null) => {
        if (data?.summary) gatesEl.textContent = data.summary
      })
      .catch(() => {})
  }
} catch {
  // gate numbers are optional
}

init().catch(err => {
  statusEl.textContent = `Error: ${err instanceof Error ? err.message : err}`
  console.error(err)
})
