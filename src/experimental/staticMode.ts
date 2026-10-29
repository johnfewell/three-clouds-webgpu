// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Matrix4, type Camera, type Texture } from 'three'

import type { CloudsContext } from '../CloudsContext'
import { shadowTemporalAlpha } from '../pass/shadowUniforms'
import { CLOUDS_TEMPORAL_ALPHA } from '../resolve/cloudsResolve'

// Fixed scalar buffer size covers all uniform properties of CloudsContext
const KNOB_COUNT = 183

// Compares 16 elements of camera world and projection transforms
function matricesEqual(a: Matrix4, b: Matrix4): boolean {
  const ae = a.elements
  const be = b.elements
  for (let i = 0; i < 16; i++) {
    if (ae[i] !== be[i]) return false
  }
  return true
}

// Compares packed numeric properties between frames
function arraysEqual(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Compares bound texture instances by object reference
function texturesEqual(
  a: readonly (Texture | null)[],
  b: readonly (Texture | null)[]
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Packs single-value context properties into the shared buffer
function packContextScalars(ctx: CloudsContext, out: Float64Array): number {
  let idx = 0
  out[idx++] = ctx.coverage
  out[idx++] = ctx.scatteringCoefficient
  out[idx++] = ctx.absorptionCoefficient
  out[idx++] = ctx.skyLightScale
  out[idx++] = ctx.groundBounceScale
  out[idx++] = ctx.powderScale
  out[idx++] = ctx.powderExponent
  out[idx++] = ctx.resolutionScale
  out[idx++] = ctx.turbulenceDisplacement
  out[idx++] = ctx.sunAngularRadius
  out[idx++] = ctx.bottomRadius
  out[idx++] = ctx.correctAltitude ? 1 : 0
  out[idx++] = ctx.temporalUpscale ? 1 : 0
  out[idx++] = ctx.haze ? 1 : 0
  return idx
}

// Packs repeat, offset and velocity vector components
function packVectors(
  ctx: CloudsContext,
  out: Float64Array,
  start: number
): number {
  let idx = start
  out[idx++] = ctx.localWeatherRepeat.x
  out[idx++] = ctx.localWeatherRepeat.y
  out[idx++] = ctx.shapeRepeat.x
  out[idx++] = ctx.shapeRepeat.y
  out[idx++] = ctx.shapeRepeat.z
  out[idx++] = ctx.shapeDetailRepeat.x
  out[idx++] = ctx.shapeDetailRepeat.y
  out[idx++] = ctx.shapeDetailRepeat.z
  out[idx++] = ctx.turbulenceRepeat.x
  out[idx++] = ctx.turbulenceRepeat.y

  out[idx++] = ctx.localWeatherOffset.x
  out[idx++] = ctx.localWeatherOffset.y
  out[idx++] = ctx.localWeatherVelocity.x
  out[idx++] = ctx.localWeatherVelocity.y
  out[idx++] = ctx.shapeOffset.x
  out[idx++] = ctx.shapeOffset.y
  out[idx++] = ctx.shapeOffset.z
  out[idx++] = ctx.shapeVelocity.x
  out[idx++] = ctx.shapeVelocity.y
  out[idx++] = ctx.shapeVelocity.z
  out[idx++] = ctx.shapeDetailOffset.x
  out[idx++] = ctx.shapeDetailOffset.y
  out[idx++] = ctx.shapeDetailOffset.z
  out[idx++] = ctx.shapeDetailVelocity.x
  out[idx++] = ctx.shapeDetailVelocity.y
  out[idx++] = ctx.shapeDetailVelocity.z
  return idx
}

// Packs moon lighting and optional lightning uniforms
function packMoonAndLightning(
  ctx: CloudsContext,
  out: Float64Array,
  start: number
): number {
  let idx = start
  out[idx++] = ctx.moonGain
  out[idx++] = ctx.moonColor.x
  out[idx++] = ctx.moonColor.y
  out[idx++] = ctx.moonColor.z
  out[idx++] = ctx.moonDirection.x
  out[idx++] = ctx.moonDirection.y
  out[idx++] = ctx.moonDirection.z

  const lit = ctx.lightning
  out[idx++] = lit != null ? lit.intensity : 0
  out[idx++] = lit != null ? lit.position.x : 0
  out[idx++] = lit != null ? lit.position.y : 0
  out[idx++] = lit != null ? lit.position.z : 0
  out[idx++] = lit != null ? lit.colour.x : 0
  out[idx++] = lit != null ? lit.colour.y : 0
  out[idx++] = lit != null ? lit.colour.z : 0
  return idx
}

// Packs cloud raymarch and cascaded shadow parameters
function packMarchAndShadow(
  ctx: CloudsContext,
  out: Float64Array,
  start: number
): number {
  let idx = start
  out[idx++] = ctx.clouds.maxIterationCount
  out[idx++] = ctx.clouds.maxIterationCountToSun
  out[idx++] = ctx.clouds.minStepSize
  out[idx++] = ctx.clouds.maxStepSize
  out[idx++] = ctx.clouds.maxRayDistance
  out[idx++] = ctx.clouds.perspectiveStepScale
  out[idx++] = ctx.clouds.minSecondaryStepSize
  out[idx++] = ctx.clouds.secondaryStepScale
  out[idx++] = ctx.clouds.minShadowLengthStepSize
  out[idx++] = ctx.clouds.maxShadowLengthRayDistance
  out[idx++] = ctx.clouds.maxShadowFilterRadius
  out[idx++] = ctx.clouds.maxIterationCountToGround
  out[idx++] = ctx.clouds.minDensity
  out[idx++] = ctx.clouds.minExtinction
  out[idx++] = ctx.clouds.minTransmittance
  out[idx++] = ctx.clouds.hazeDensityScale
  out[idx++] = ctx.clouds.hazeExponent
  out[idx++] = ctx.clouds.hazeScatteringCoefficient
  out[idx++] = ctx.clouds.hazeAbsorptionCoefficient

  out[idx++] = ctx.shadow.splitLambda
  out[idx++] = ctx.shadow.splitMode
  out[idx++] = ctx.shadow.maxFar ?? -1
  out[idx++] = ctx.shadow.farScale
  out[idx++] = ctx.shadow.mapSize.x
  out[idx++] = ctx.shadow.mapSize.y
  out[idx++] = ctx.shadow.updateInterval
  out[idx++] = ctx.shadow.cascadeCount
  out[idx++] = ctx.shadow.maxIterationCount
  out[idx++] = ctx.shadow.minStepSize
  out[idx++] = ctx.shadow.maxStepSize
  out[idx++] = ctx.shadow.minDensity
  out[idx++] = ctx.shadow.minExtinction
  out[idx++] = ctx.shadow.minTransmittance
  out[idx++] = ctx.shadow.opticalDepthTailScale
  return idx
}

// Packs layer parameters for up to 4 layers plus shape tuning
function packLayersAndShape(
  ctx: CloudsContext,
  out: Float64Array,
  start: number
): number {
  let idx = start
  for (let i = 0; i < 4; i++) {
    const layer = ctx.cloudLayers[i]
    if (layer == null) {
      idx += 13
      continue
    }
    out[idx++] = layer.altitude
    out[idx++] = layer.height
    out[idx++] = layer.densityScale
    out[idx++] = layer.shapeAmount
    out[idx++] = layer.shapeDetailAmount
    out[idx++] = layer.weatherExponent
    out[idx++] = layer.shapeAlteringBias
    out[idx++] = layer.coverageFilterWidth
    out[idx++] = layer.shadow ? 1 : 0
    out[idx++] = layer.densityProfile.expTerm
    out[idx++] = layer.densityProfile.exponent
    out[idx++] = layer.densityProfile.linearTerm
    out[idx++] = layer.densityProfile.constantTerm
  }

  const s = ctx.cloudShape
  out[idx++] = s.baseShadowStrength
  out[idx++] = s.baseShadowHeight
  out[idx++] = s.horizonCoverageAmount
  out[idx++] = s.horizonCoverageStart
  out[idx++] = s.horizonCoverageRamp
  out[idx++] = s.windSkewEast
  out[idx++] = s.windSkewNorth
  out[idx++] = s.erosionShape
  return idx
}

// Packs experimental convective profile and world transform
function packExperimentalAndMatrix(
  ctx: CloudsContext,
  out: Float64Array,
  start: number
): number {
  let idx = start
  const cp = ctx.convectiveProfile
  out[idx++] = cp.anvilCenter
  out[idx++] = cp.anvilWidth
  out[idx++] = cp.anvilStrength
  out[idx++] = cp.cellsPerWeatherTile
  out[idx++] = cp.cellThreshold
  out[idx++] = cp.cellSoftness
  out[idx++] = cp.cellDensity

  const rs = ctx.rainShafts
  out[idx++] = rs.strength
  out[idx++] = rs.density
  out[idx++] = rs.slant

  const cd = ctx.cirrusDeck
  out[idx++] = cd.altitude
  out[idx++] = cd.strength
  out[idx++] = cd.scale
  out[idx++] = cd.velocityU
  out[idx++] = cd.velocityV

  const ew = ctx.evolvingWeather
  out[idx++] = ew.windSpeed
  out[idx++] = ew.windPatternSize
  out[idx++] = ew.cellLifetime
  out[idx++] = ew.lifeStrength

  const m = ctx.worldToECEFMatrix.elements
  for (let i = 0; i < 16; i++) {
    out[idx++] = m[i]!
  }
  return idx
}

// Fills the uniform snapshot buffer in a single pass
function packKnobs(ctx: CloudsContext, out: Float64Array): void {
  let idx = packContextScalars(ctx, out)
  idx = packVectors(ctx, out, idx)
  idx = packMoonAndLightning(ctx, out, idx)
  idx = packMarchAndShadow(ctx, out, idx)
  idx = packLayersAndShape(ctx, out, idx)
  idx = packExperimentalAndMatrix(ctx, out, idx)
  // A typed array drops writes past its end, so an unsized knob is unchecked
  if (idx !== KNOB_COUNT) {
    throw new Error(`staticMode packed ${idx} knobs, expected ${KNOB_COUNT}`)
  }
}

// Collects weather and volume texture references for equality checks
function getTextures(ctx: CloudsContext): (Texture | null)[] {
  return [
    ctx.resolvedLocalWeatherTexture,
    ctx.resolvedShapeTexture,
    ctx.resolvedShapeDetailTexture,
    ctx.resolvedTurbulenceTexture,
    ctx.stbnTexture,
    ctx.cloudTypes.map,
    ctx.cirrusDeck.texture
  ]
}

// An in-place upload bumps version and keeps the reference
function getTextureVersions(textures: readonly (Texture | null)[]): number[] {
  return textures.map(t => (t != null ? t.version : -1))
}

function versionsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// The share of a history's starting error left when static mode first skips
export const STATIC_CONVERGENCE_TOLERANCE = 1e-3

// Updates until (1 - alpha)^n is within tolerance. Alpha 0 never converges
function updatesToConverge(alpha: number, tolerance: number): number {
  if (alpha >= 1) return 1
  if (!(alpha > 0)) return Infinity
  return Math.max(1, Math.ceil(Math.log(tolerance) / Math.log(1 - alpha)))
}

export interface ConvergenceInputs {
  temporalUpscale: boolean
  // The full-resolution resolve's weight on the current frame
  cloudAlpha: number
  // The shadow resolve's weight per update, null without a shadow history
  shadowAlpha: number | null
  // Renders between shadow updates
  shadowInterval: number
}

// Rendered frames until every history keeps at most `tolerance` of its error
// Upscaling replaces each Bayer cell once in 16 frames rather than blending
export function staticConvergenceFrames(
  input: ConvergenceInputs,
  tolerance = STATIC_CONVERGENCE_TOLERANCE
): number {
  let frames = input.temporalUpscale
    ? 16
    : updatesToConverge(input.cloudAlpha, tolerance)
  if (input.shadowAlpha != null) {
    const interval = Math.max(1, Math.floor(input.shadowInterval))
    frames = Math.max(
      frames,
      interval * updatesToConverge(input.shadowAlpha, tolerance)
    )
  }
  return frames
}

// The context's own histories. No casting layer leaves the atlas empty
export function contextConvergenceFrames(ctx: CloudsContext): number {
  const shadowHistory = ctx.shadow.temporalPass && ctx.cloudLayers.castsShadow
  return staticConvergenceFrames({
    temporalUpscale: ctx.temporalUpscale,
    cloudAlpha: CLOUDS_TEMPORAL_ALPHA,
    shadowAlpha: shadowHistory ? shadowTemporalAlpha(ctx) : null,
    shadowInterval: ctx.shadow.updateInterval
  })
}

// Frame dimensions passed from the pass node
export interface FrameDimensions {
  fullW: number
  fullH: number
}

// Tracks input snapshot to skip redundant march and resolve passes
export class StaticModeTracker {
  private _renderedFrames = 0
  private _lastFrameSeen = -1
  private _hasSnapshot = false

  private readonly _lastCameraWorld = new Matrix4()
  private readonly _lastCameraProjection = new Matrix4()
  private _lastSunX = 0
  private _lastSunY = 0
  private _lastSunZ = 0
  private _lastTime = 0
  private _lastFullW = 0
  private _lastFullH = 0
  private _lastGraphVersion = -1

  private readonly _lastKnobs = new Float64Array(KNOB_COUNT)
  private readonly _currentKnobs = new Float64Array(KNOB_COUNT)
  private _lastTextures: (Texture | null)[] = []
  private _lastTextureVersions: number[] = []

  get renderedFrames(): number {
    return this._renderedFrames
  }

  // Resets convergence and drops cached snapshot
  reset(): void {
    this._renderedFrames = 0
    this._hasSnapshot = false
  }

  // Checks sun direction, simulation time, viewport and graph version
  private matchesBasic(ctx: CloudsContext, size: FrameDimensions): boolean {
    if (ctx.time !== this._lastTime) return false
    if (size.fullW !== this._lastFullW) return false
    if (size.fullH !== this._lastFullH) return false
    if (ctx.graphVersion !== this._lastGraphVersion) return false
    if (ctx.sunDirection.x !== this._lastSunX) return false
    if (ctx.sunDirection.y !== this._lastSunY) return false
    return ctx.sunDirection.z === this._lastSunZ
  }

  // Checks camera pose and camera projection matrices
  private matchesCamera(camera: Camera): boolean {
    return (
      matricesEqual(camera.matrixWorld, this._lastCameraWorld) &&
      matricesEqual(camera.projectionMatrix, this._lastCameraProjection)
    )
  }

  // Packs and compares current knobs against the previous frame snapshot
  private matchesKnobsAndTextures(ctx: CloudsContext): boolean {
    packKnobs(ctx, this._currentKnobs)
    if (!arraysEqual(this._currentKnobs, this._lastKnobs)) return false
    const textures = getTextures(ctx)
    return (
      texturesEqual(textures, this._lastTextures) &&
      versionsEqual(getTextureVersions(textures), this._lastTextureVersions)
    )
  }

  private matchesSnapshot(
    ctx: CloudsContext,
    camera: Camera,
    size: FrameDimensions
  ): boolean {
    return (
      this.matchesBasic(ctx, size) &&
      this.matchesCamera(camera) &&
      this.matchesKnobsAndTextures(ctx)
    )
  }

  // Returns true when staticMode is on and all inputs match the snapshot
  isStatic(
    ctx: CloudsContext,
    camera: Camera,
    size: FrameDimensions,
    historyReady: boolean
  ): boolean {
    if (!ctx.experimental.staticMode || !historyReady || !this._hasSnapshot) {
      return false
    }

    if (!this.matchesSnapshot(ctx, camera, size)) {
      this._renderedFrames = 0
      return false
    }

    return this._renderedFrames >= contextConvergenceFrames(ctx)
  }

  // Records a completed render and updates convergence frame count
  recordRender(
    ctx: CloudsContext,
    camera: Camera,
    size: FrameDimensions
  ): void {
    if (!ctx.experimental.staticMode) {
      this._renderedFrames = 0
      this._hasSnapshot = false
      return
    }

    if (this._hasSnapshot && this.matchesSnapshot(ctx, camera, size)) {
      if (!ctx.temporalUpscale || ctx.frame !== this._lastFrameSeen) {
        this._renderedFrames++
        this._lastFrameSeen = ctx.frame
      }
    } else {
      this._renderedFrames = 1
      this._lastFrameSeen = ctx.frame
      this.saveSnapshot(ctx, camera, size)
    }
  }

  // Stores current camera, sun, time and knobs as the baseline snapshot
  private saveSnapshot(
    ctx: CloudsContext,
    camera: Camera,
    size: FrameDimensions
  ): void {
    this._hasSnapshot = true
    this._lastTime = ctx.time
    this._lastFullW = size.fullW
    this._lastFullH = size.fullH
    this._lastGraphVersion = ctx.graphVersion
    this._lastSunX = ctx.sunDirection.x
    this._lastSunY = ctx.sunDirection.y
    this._lastSunZ = ctx.sunDirection.z
    this._lastCameraWorld.copy(camera.matrixWorld)
    this._lastCameraProjection.copy(camera.projectionMatrix)
    packKnobs(ctx, this._lastKnobs)
    this._lastTextures = getTextures(ctx)
    this._lastTextureVersions = getTextureVersions(this._lastTextures)
  }
}
