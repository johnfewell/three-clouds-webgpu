// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// The per-frame uniform values of the default graph, each a plain function of
// CloudsInputs and the camera. Each section names the port function it
// reproduces, and core/CPU-STATE.md maps every value to its test

import { cameraWorldPosition, type CameraState } from './camera'
import {
  CascadedShadowMaps,
  getSunDistanceFudge,
  MAX_CASCADE_COUNT,
  type FrustumSplitMode
} from './cascades'
import { moonlight } from './celestial'
import { geodeticHeight, getAltitudeCorrectionOffset } from './geodesy'
import type { CloudLayerValues, CloudsInputs } from './inputs'
import { Mat3, Mat4, Vec2, Vec3, Vec4 } from './math'

// Frame dimensions (CloudsPassNode.frameDimensions)

export interface FrameSize {
  fullW: number
  fullH: number
  marchW: number
  marchH: number
}

export function frameSize(
  inputs: CloudsInputs,
  drawingBufferWidth: number,
  drawingBufferHeight: number
): FrameSize {
  const fullW = Math.ceil(drawingBufferWidth * inputs.resolutionScale)
  const fullH = Math.ceil(drawingBufferHeight * inputs.resolutionScale)
  // Cite: CloudsPass.ts:205-225
  const divisor = inputs.temporalUpscale ? 4 : 1
  return {
    fullW,
    fullH,
    marchW: Math.ceil(fullW / divisor),
    marchH: Math.ceil(fullH / divisor)
  }
}

// Frame of reference (CloudsContext.updateCamera)

export interface FrameOfReference {
  readonly ecefToWorldMatrix: Mat4
  readonly altitudeCorrection: Vec3
  // Kept from the previous frame where the camera cannot be projected
  cameraHeight: number
}

export function createFrameOfReference(): FrameOfReference {
  return {
    ecefToWorldMatrix: new Mat4(),
    altitudeCorrection: new Vec3(),
    cameraHeight: 0
  }
}

const _cameraECEF = /*#__PURE__*/ new Vec3()

export function updateFrameOfReference(
  frame: FrameOfReference,
  inputs: CloudsInputs,
  camera: CameraState
): FrameOfReference {
  frame.ecefToWorldMatrix.copy(inputs.worldToECEFMatrix).invert()
  const cameraPositionECEF = cameraWorldPosition(
    camera,
    _cameraECEF
  ).applyMatrix4(inputs.worldToECEFMatrix)
  if (inputs.correctAltitude) {
    getAltitudeCorrectionOffset(
      cameraPositionECEF,
      inputs.bottomRadius,
      inputs.ellipsoid,
      frame.altitudeCorrection
    )
  } else {
    frame.altitudeCorrection.setScalar(0)
  }
  const height = geodeticHeight(cameraPositionECEF, inputs.ellipsoid)
  if (height != null) frame.cameraHeight = height
  return frame
}

// Camera uniforms (CameraUniforms.update)

// bayerOffsets from src/resolve/bayer.ts: the cell centre each frame jitters to
const BAYER_INDICES = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
export const BAYER_OFFSETS: readonly Vec2[] = BAYER_INDICES.map((_, index) => {
  const i = BAYER_INDICES.indexOf(index)
  return new Vec2(((i % 4) + 0.5) / 4, (Math.floor(i / 4) + 0.5) / 4)
})

export interface CameraUniformValues {
  readonly viewMatrix: Mat4
  readonly inverseViewMatrix: Mat4
  readonly inverseProjectionMatrix: Mat4
  cameraNear: number
  cameraFar: number
  readonly cameraPosition: Vec3
  readonly cameraPositionECEF: Vec3
  readonly cameraDirectionECEF: Vec3
  readonly reprojectionMatrix: Mat4
  readonly viewReprojectionMatrix: Mat4
  // The temporal jitter this frame, in NDC, zero without temporal upscale
  readonly jitter: Vec2
  // Previous frame's matrices, null after a reset (CloudsPass.ts:203-224)
  previousProjectionMatrix: Mat4 | null
  previousViewMatrix: Mat4 | null
}

export function createCameraUniformValues(): CameraUniformValues {
  return {
    viewMatrix: new Mat4(),
    inverseViewMatrix: new Mat4(),
    inverseProjectionMatrix: new Mat4(),
    cameraNear: 0,
    cameraFar: 0,
    cameraPosition: new Vec3(),
    cameraPositionECEF: new Vec3(),
    cameraDirectionECEF: new Vec3(),
    reprojectionMatrix: new Mat4(),
    viewReprojectionMatrix: new Mat4(),
    jitter: new Vec2(),
    previousProjectionMatrix: null,
    previousViewMatrix: null
  }
}

const _vec3 = /*#__PURE__*/ new Vec3()
const _vec4 = /*#__PURE__*/ new Vec4()
const _projScratch = /*#__PURE__*/ new Mat4()

// The jittered path runs with temporal upscale, at the 4x march resolution
// (CloudsPassNode.syncFrameUniforms)
export function updateCameraUniformValues(
  u: CameraUniformValues,
  inputs: CloudsInputs,
  camera: CameraState,
  size: FrameSize
): CameraUniformValues {
  u.viewMatrix.copy(camera.matrixWorldInverse)
  u.inverseViewMatrix.copy(camera.matrixWorld)
  u.cameraNear = camera.near
  u.cameraFar = camera.far
  cameraWorldPosition(camera, u.cameraPosition)
  u.cameraPositionECEF
    .copy(u.cameraPosition)
    .applyMatrix4(inputs.worldToECEFMatrix)

  // clouds.vert:72-74
  _vec4.set(0, 0, -1, 0).applyMatrix4(camera.matrixWorld)
  _vec3.set(_vec4.x, _vec4.y, _vec4.z).normalize()
  _vec4.set(_vec3.x, _vec3.y, _vec3.z, 0).applyMatrix4(inputs.worldToECEFMatrix)
  u.cameraDirectionECEF.set(_vec4.x, _vec4.y, _vec4.z).normalize()

  const prevProj = u.previousProjectionMatrix ?? camera.projectionMatrix
  const prevView = u.previousViewMatrix ?? camera.matrixWorldInverse

  // Cite: CloudsMaterial.ts:338-370
  if (inputs.temporalUpscale) {
    const offset = BAYER_OFFSETS[inputs.frame % 16]!
    const dx = ((offset.x - 0.5) / (size.marchW * 4)) * 4
    const dy = ((offset.y - 0.5) / (size.marchH * 4)) * 4
    u.jitter.set(dx, dy)
    _projScratch.copy(camera.projectionMatrix)
    _projScratch.elements[8]! += dx * 2
    _projScratch.elements[9]! += dy * 2
    u.inverseProjectionMatrix.copy(_projScratch).invert()
    u.reprojectionMatrix.copy(prevProj)
    u.reprojectionMatrix.elements[8]! += dx * 2
    u.reprojectionMatrix.elements[9]! += dy * 2
    u.reprojectionMatrix.multiply(prevView)
  } else {
    u.jitter.set(0, 0)
    u.inverseProjectionMatrix.copy(camera.projectionMatrixInverse)
    u.reprojectionMatrix.copy(prevProj).multiply(prevView)
  }
  u.viewReprojectionMatrix
    .copy(u.reprojectionMatrix)
    .multiply(u.inverseViewMatrix)
  return u
}

// After each rendered frame (CameraUniforms.copyReprojectionMatrix)
export function storeCameraHistory(
  u: CameraUniformValues,
  camera: CameraState
): void {
  u.previousProjectionMatrix ??= new Mat4()
  u.previousViewMatrix ??= new Mat4()
  u.previousProjectionMatrix.copy(camera.projectionMatrix)
  u.previousViewMatrix.copy(camera.matrixWorldInverse)
}

// On a history reset or resize (CameraUniforms.resetPreviousMatrices)
export function resetCameraHistory(u: CameraUniformValues): void {
  u.previousProjectionMatrix = null
  u.previousViewMatrix = null
}

// March uniforms (updateMarchUniforms, with CloudsContext.updateMoonlight)

export interface MarchUniformValues {
  bottomRadius: number
  readonly sunDirection: Vec3
  readonly lightDirection: Vec3
  readonly moonIrradianceRatio: Vec3
  readonly altitudeCorrection: Vec3
  readonly worldToECEFMatrix: Mat4
  readonly ecefToWorldMatrix: Mat4
  worldToUnit: number
  cameraHeight: number
  maxIterationCount: number
  maxIterationCountToSun: number
  minStepSize: number
  maxStepSize: number
  maxRayDistance: number
  perspectiveStepScale: number
  minSecondaryStepSize: number
  secondaryStepScale: number
  minShadowLengthStepSize: number
  maxShadowLengthRayDistance: number
  maxShadowFilterRadius: number
  maxIterationCountToGround: number
  skyLightScale: number
  groundBounceScale: number
  powderScale: number
  powderExponent: number
}

export function createMarchUniformValues(): MarchUniformValues {
  return {
    bottomRadius: 0,
    sunDirection: new Vec3(),
    lightDirection: new Vec3(),
    moonIrradianceRatio: new Vec3(),
    altitudeCorrection: new Vec3(),
    worldToECEFMatrix: new Mat4(),
    ecefToWorldMatrix: new Mat4(),
    worldToUnit: 0,
    cameraHeight: 0,
    maxIterationCount: 0,
    maxIterationCountToSun: 0,
    minStepSize: 0,
    maxStepSize: 0,
    maxRayDistance: 0,
    perspectiveStepScale: 0,
    minSecondaryStepSize: 0,
    secondaryStepScale: 0,
    minShadowLengthStepSize: 0,
    maxShadowLengthRayDistance: 0,
    maxShadowFilterRadius: 0,
    maxIterationCountToGround: 0,
    skyLightScale: 0,
    groundBounceScale: 0,
    powderScale: 0,
    powderExponent: 0
  }
}

// The light the march and the cascades follow this frame
export function updateLight(
  u: MarchUniformValues,
  inputs: CloudsInputs,
  cameraPositionECEF: Vec3
): void {
  u.sunDirection.copy(inputs.sunDirection)
  moonlight(
    inputs.sunDirection,
    inputs.moonDirection,
    cameraPositionECEF,
    inputs.moonlight ? inputs.moonGain : 0,
    inputs.moonColor,
    { lightDirection: u.lightDirection, irradianceRatio: u.moonIrradianceRatio }
  )
}

const MARCH_QUALITY_KEYS = [
  'maxIterationCount',
  'maxIterationCountToSun',
  'minStepSize',
  'maxStepSize',
  'maxRayDistance',
  'perspectiveStepScale',
  'minSecondaryStepSize',
  'secondaryStepScale',
  'minShadowLengthStepSize',
  'maxShadowLengthRayDistance',
  'maxShadowFilterRadius',
  'maxIterationCountToGround'
] as const

export function updateMarchUniformValues(
  u: MarchUniformValues,
  inputs: CloudsInputs,
  frame: FrameOfReference,
  cameraPositionECEF: Vec3
): MarchUniformValues {
  u.bottomRadius = inputs.bottomRadius
  updateLight(u, inputs, cameraPositionECEF)
  u.altitudeCorrection.copy(frame.altitudeCorrection)
  u.worldToECEFMatrix.copy(inputs.worldToECEFMatrix)
  u.ecefToWorldMatrix.copy(frame.ecefToWorldMatrix)
  u.worldToUnit = 1 / inputs.bottomRadius
  u.cameraHeight = frame.cameraHeight
  for (const key of MARCH_QUALITY_KEYS) u[key] = inputs.clouds[key]
  u.skyLightScale = inputs.skyLightScale
  u.groundBounceScale = inputs.groundBounceScale
  u.powderScale = inputs.powderScale
  u.powderExponent = inputs.powderExponent
  return u
}

// Layer uniforms (updateLayerUniforms)

export interface LayerUniformValues {
  readonly minLayerHeights: Vec4
  readonly maxLayerHeights: Vec4
  readonly minIntervalHeights: Vec3
  readonly maxIntervalHeights: Vec3
  readonly densityScales: Vec4
  readonly shapeAmounts: Vec4
  readonly shapeDetailAmounts: Vec4
  readonly weatherExponents: Vec4
  readonly shapeAlteringBiases: Vec4
  readonly coverageFilterWidths: Vec4
  minHeight: number
  maxHeight: number
  shadowTopHeight: number
  shadowBottomHeight: number
  readonly shadowLayerMask: Vec4
  readonly densityProfileExpTerms: Vec4
  readonly densityProfileExponents: Vec4
  readonly densityProfileLinearTerms: Vec4
  readonly densityProfileConstantTerms: Vec4
}

export function createLayerUniformValues(): LayerUniformValues {
  return {
    minLayerHeights: new Vec4(),
    maxLayerHeights: new Vec4(),
    minIntervalHeights: new Vec3(),
    maxIntervalHeights: new Vec3(),
    densityScales: new Vec4(),
    shapeAmounts: new Vec4(),
    shapeDetailAmounts: new Vec4(),
    weatherExponents: new Vec4(),
    shapeAlteringBiases: new Vec4(),
    coverageFilterWidths: new Vec4(),
    minHeight: 0,
    maxHeight: 0,
    shadowTopHeight: 0,
    shadowBottomHeight: 0,
    shadowLayerMask: new Vec4(),
    densityProfileExpTerms: new Vec4(),
    densityProfileExponents: new Vec4(),
    densityProfileLinearTerms: new Vec4(),
    densityProfileConstantTerms: new Vec4()
  }
}

type Layers = CloudsInputs['cloudLayers']

function pack(
  layers: Layers,
  value: (layer: CloudLayerValues) => number,
  out: Vec4
): void {
  out.set(
    value(layers[0]),
    value(layers[1]),
    value(layers[2]),
    value(layers[3])
  )
}

// CloudLayers.packIntervalHeights: the union of layer spans as up to three
// disjoint intervals, from a sweep over sorted endpoints
function packIntervalHeights(
  layers: Layers,
  minIntervals: Vec3,
  maxIntervals: Vec3
): void {
  const entries = layers.flatMap(l => [
    { value: l.altitude, flag: 0 },
    { value: l.altitude + l.height, flag: 1 }
  ])
  // The port fills the entries array in the order [4 starts, 4 ends]
  const ordered = [
    ...entries.filter(e => e.flag === 0),
    ...entries.filter(e => e.flag === 1)
  ]
  ordered.sort((a, b) =>
    a.value !== b.value ? a.value - b.value : a.flag - b.flag
  )
  const intervals: { min: number; max: number }[] = []
  let balance = 0
  ordered.forEach(({ value, flag }, index) => {
    if (balance === 0 && index > 0) {
      intervals.push({ min: ordered[index - 1]!.value, max: value })
    }
    balance += flag === 0 ? 1 : -1
  })
  const get = (i: number) => intervals[i] ?? { min: 0, max: 0 }
  minIntervals.set(get(0).min, get(1).min, get(2).min)
  maxIntervals.set(get(0).max, get(1).max, get(2).max)
}

function computeHeightBounds(u: LayerUniformValues, layers: Layers): void {
  let totalMinHeight = Infinity
  let totalMaxHeight = 0
  let shadowBottom = Infinity
  let shadowTop = 0
  const mask = [0, 0, 0, 0]
  // Strict comparisons, not Math.min, which differ from them on -0
  layers.forEach(({ altitude, height, shadow }, i) => {
    const top = altitude + height
    if (height > 0) {
      if (altitude < totalMinHeight) totalMinHeight = altitude
      if (shadow && altitude < shadowBottom) shadowBottom = altitude
      if (top > totalMaxHeight) totalMaxHeight = top
      if (shadow && top > shadowTop) shadowTop = top
    }
    mask[i] = shadow ? 1 : 0
  })
  // Unset bounds keep their previous value, as the port's uniforms do
  if (totalMinHeight !== Infinity) {
    u.minHeight = totalMinHeight
    u.maxHeight = totalMaxHeight
  } else {
    u.minHeight = 0
  }
  if (shadowBottom !== Infinity) {
    u.shadowBottomHeight = shadowBottom
    u.shadowTopHeight = shadowTop
  } else {
    u.shadowBottomHeight = 0
  }
  u.shadowLayerMask.set(mask[0]!, mask[1]!, mask[2]!, mask[3]!)
}

export function updateLayerUniformValues(
  u: LayerUniformValues,
  inputs: CloudsInputs
): LayerUniformValues {
  const layers = inputs.cloudLayers
  pack(layers, l => l.altitude, u.minLayerHeights)
  pack(layers, l => l.altitude + l.height, u.maxLayerHeights)
  packIntervalHeights(layers, u.minIntervalHeights, u.maxIntervalHeights)
  pack(layers, l => l.densityScale, u.densityScales)
  pack(layers, l => l.shapeAmount, u.shapeAmounts)
  pack(layers, l => l.shapeDetailAmount, u.shapeDetailAmounts)
  pack(layers, l => l.weatherExponent, u.weatherExponents)
  pack(layers, l => l.shapeAlteringBias, u.shapeAlteringBiases)
  pack(layers, l => l.coverageFilterWidth, u.coverageFilterWidths)
  pack(layers, l => l.densityProfile.expTerm, u.densityProfileExpTerms)
  pack(layers, l => l.densityProfile.exponent, u.densityProfileExponents)
  pack(layers, l => l.densityProfile.linearTerm, u.densityProfileLinearTerms)
  pack(
    layers,
    l => l.densityProfile.constantTerm,
    u.densityProfileConstantTerms
  )
  computeHeightBounds(u, layers)
  return u
}

// Parameter uniforms (updateParameterUniforms, updateParameterUniformsForFrame)

export interface ParameterUniformValues {
  readonly resolution: Vec2
  frame: number
  readonly temporalJitter: Vec2
  readonly targetUvScale: Vec2
  mipLevelScale: number
  scatteringCoefficient: number
  absorptionCoefficient: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  readonly localWeatherRepeat: Vec2
  readonly localWeatherOffset: Vec2
  coverage: number
  readonly shapeRepeat: Vec3
  readonly shapeOffset: Vec3
  readonly shapeDetailRepeat: Vec3
  readonly shapeDetailOffset: Vec3
  readonly turbulenceRepeat: Vec2
  turbulenceDisplacement: number
  hazeDensityScale: number
  hazeExponent: number
  hazeScatteringCoefficient: number
  hazeAbsorptionCoefficient: number
}

export function createParameterUniformValues(): ParameterUniformValues {
  return {
    resolution: new Vec2(),
    frame: 0,
    temporalJitter: new Vec2(),
    targetUvScale: new Vec2(1, 1),
    mipLevelScale: 1,
    scatteringCoefficient: 0,
    absorptionCoefficient: 0,
    minDensity: 0,
    minExtinction: 0,
    minTransmittance: 0,
    localWeatherRepeat: new Vec2(),
    localWeatherOffset: new Vec2(),
    coverage: 0,
    shapeRepeat: new Vec3(),
    shapeOffset: new Vec3(),
    shapeDetailRepeat: new Vec3(),
    shapeDetailOffset: new Vec3(),
    turbulenceRepeat: new Vec2(),
    turbulenceDisplacement: 0,
    hazeDensityScale: 0,
    hazeExponent: 0,
    hazeScatteringCoefficient: 0,
    hazeAbsorptionCoefficient: 0
  }
}

export function updateParameterUniformValues(
  u: ParameterUniformValues,
  inputs: CloudsInputs,
  size: FrameSize,
  jitter: Vec2
): ParameterUniformValues {
  // CloudsContext.updateOffsets: base + velocity * time, seek-safe
  u.localWeatherOffset
    .copy(inputs.localWeatherOffset)
    .addScaledVector(inputs.localWeatherVelocity, inputs.time)
  u.shapeOffset
    .copy(inputs.shapeOffset)
    .addScaledVector(inputs.shapeVelocity, inputs.time)
  u.shapeDetailOffset
    .copy(inputs.shapeDetailOffset)
    .addScaledVector(inputs.shapeDetailVelocity, inputs.time)
  u.localWeatherRepeat.copy(inputs.localWeatherRepeat)
  u.shapeRepeat.copy(inputs.shapeRepeat)
  u.shapeDetailRepeat.copy(inputs.shapeDetailRepeat)
  u.turbulenceRepeat.copy(inputs.turbulenceRepeat)
  u.frame = inputs.frame
  u.scatteringCoefficient = inputs.scatteringCoefficient
  u.absorptionCoefficient = inputs.absorptionCoefficient
  u.coverage = inputs.coverage
  u.turbulenceDisplacement = inputs.turbulenceDisplacement
  u.minDensity = inputs.clouds.minDensity
  u.minExtinction = inputs.clouds.minExtinction
  u.minTransmittance = inputs.clouds.minTransmittance
  u.hazeDensityScale = inputs.clouds.hazeDensityScale
  u.hazeExponent = inputs.clouds.hazeExponent
  u.hazeScatteringCoefficient = inputs.clouds.hazeScatteringCoefficient
  u.hazeAbsorptionCoefficient = inputs.clouds.hazeAbsorptionCoefficient
  // Cite: CloudsMaterial.ts:338-358
  if (inputs.temporalUpscale) {
    const resW = size.marchW * 4
    const resH = size.marchH * 4
    u.resolution.set(resW, resH)
    u.temporalJitter.copy(jitter)
    // NOTE(port): Not exactly
    u.mipLevelScale = 0.25
    u.targetUvScale.set(resW / size.fullW, resH / size.fullH)
  } else {
    u.resolution.set(size.marchW, size.marchH)
    u.temporalJitter.set(0, 0)
    u.mipLevelScale = 1
    u.targetUvScale.set(1, 1)
  }
  return u
}

// Shadow maps (CloudsContext.syncShadowMaps, updateShadowMaps)

const SPLIT_MODES: readonly FrustumSplitMode[] = [
  'uniform',
  'logarithmic',
  'practical'
]

export function createShadowMaps(inputs: CloudsInputs): CascadedShadowMaps {
  return new CascadedShadowMaps({
    cascadeCount: inputs.shadow.cascadeCount,
    mapSize: inputs.shadow.mapSize.clone(),
    splitLambda: inputs.shadow.splitLambda
  })
}

export function syncShadowMaps(
  csm: CascadedShadowMaps,
  inputs: CloudsInputs
): void {
  csm.splitLambda = inputs.shadow.splitLambda
  csm.splitMode = SPLIT_MODES[inputs.shadow.splitMode] ?? 'practical'
  csm.maxFar = inputs.shadow.maxFar
  csm.farScale = inputs.shadow.farScale
  csm.cascadeCount = inputs.shadow.cascadeCount
  csm.mapSize.copy(inputs.shadow.mapSize)
}

const _mat3 = /*#__PURE__*/ new Mat3()
const _surfaceNormal = /*#__PURE__*/ new Vec3()
const _sunWorld = /*#__PURE__*/ new Vec3()

// The cascades fit the march's light, the moon's once twilight hands it over
export function updateShadowMaps(
  csm: CascadedShadowMaps,
  inputs: CloudsInputs,
  frame: FrameOfReference,
  lightDirection: Vec3,
  camera: CameraState
): void {
  const cameraPositionECEF = cameraWorldPosition(
    camera,
    _cameraECEF
  ).applyMatrix4(inputs.worldToECEFMatrix)
  const surfaceNormal = inputs.ellipsoid.getSurfaceNormal(
    cameraPositionECEF,
    _surfaceNormal
  )
  const light =
    lightDirection.lengthSq() > 0 ? lightDirection : inputs.sunDirection
  const distance = getSunDistanceFudge(light, surfaceNormal)
  // Rotation only, as CloudsEffect.ts:389-395 applies it
  _mat3.setFromMatrix4(frame.ecefToWorldMatrix)
  const sunDirectionWorld = _sunWorld
    .copy(light)
    .applyMatrix3(_mat3)
    .normalize()
  csm.update(camera, sunDirectionWorld, distance)
}

// Shadow pass uniforms (updateShadowPassUniforms, renderShadowPass)

// Per-cascade weather mip level (src/shadow/opticalDepthMarch.ts MIP_LEVELS)
export const SHADOW_MIP_LEVELS = [0, 0.5, 1, 2] as const

export interface ShadowPassUniformValues {
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  opticalDepthTailScale: number
  readonly shadowResolution: Vec2
}

export function createShadowPassUniformValues(): ShadowPassUniformValues {
  return {
    maxIterationCount: 0,
    minStepSize: 0,
    maxStepSize: 0,
    minDensity: 0,
    minExtinction: 0,
    minTransmittance: 0,
    opticalDepthTailScale: 0,
    shadowResolution: new Vec2()
  }
}

// ShadowPass.ts temporalAlpha 0.01 per frame, compounded over updateInterval
export function shadowTemporalAlpha(inputs: CloudsInputs): number {
  const interval = Math.max(1, Math.floor(inputs.shadow.updateInterval))
  return interval === 1 ? 0.01 : 1 - Math.pow(1 - 0.01, interval)
}

export function updateShadowPassUniformValues(
  u: ShadowPassUniformValues,
  inputs: CloudsInputs
): ShadowPassUniformValues {
  const s = inputs.shadow
  u.maxIterationCount = s.maxIterationCount
  u.minStepSize = s.minStepSize
  u.maxStepSize = s.maxStepSize
  u.minDensity = s.minDensity
  u.minExtinction = s.minExtinction
  u.minTransmittance = s.minTransmittance
  u.opticalDepthTailScale = s.opticalDepthTailScale
  u.shadowResolution.copy(s.mapSize)
  return u
}

// The two temporal resolves (CloudsPassNode.buildShadowResolveGraph and
// ensureResolveTargets). Only the sizes and the shadow alpha change at run time

export interface ResolveUniformValues {
  // resolve_width and resolve_height, the full frame size
  width: number
  height: number
  // CLOUDS_TEMPORAL_ALPHA and the colour resolve's variance clip
  temporalAlpha: number
  varianceGamma: number
  shadowTemporalAlpha: number
  shadowVarianceGamma: number
}

export function createResolveUniformValues(): ResolveUniformValues {
  return {
    width: 1,
    height: 1,
    temporalAlpha: 0.1,
    varianceGamma: 2,
    shadowTemporalAlpha: 0,
    shadowVarianceGamma: 1
  }
}

export function updateResolveUniformValues(
  u: ResolveUniformValues,
  inputs: CloudsInputs,
  size: FrameSize
): ResolveUniformValues {
  u.width = size.fullW
  u.height = size.fullH
  u.shadowTemporalAlpha = shadowTemporalAlpha(inputs)
  return u
}

// One draw per cascade: the per-draw writes the shadow march reads
export interface ShadowCascadeDraw {
  readonly inverseShadowMatrix: Mat4
  readonly reprojectionMatrix: Mat4
  mipLevel: number
  cascadeIndex: number
}

export function shadowCascadeDraws(
  csm: CascadedShadowMaps,
  previousMatrices: readonly Mat4[]
): ShadowCascadeDraw[] {
  return csm.cascades.map((cascade, i) => ({
    inverseShadowMatrix: cascade.inverseMatrix.clone(),
    reprojectionMatrix: (previousMatrices[i] ?? new Mat4()).clone(),
    mipLevel: SHADOW_MIP_LEVELS[i] ?? 2,
    cascadeIndex: i
  }))
}

// After a temporal shadow pass (CloudsPassNode.storeShadowReprojection)
export function storeShadowHistory(
  csm: CascadedShadowMaps,
  previousMatrices: Mat4[]
): void {
  csm.cascades.forEach((cascade, i) => {
    previousMatrices[i] = (previousMatrices[i] ?? new Mat4()).copy(
      cascade.matrix
    )
  })
}

// The cloud shadow the consumers read (updateCloudShadowDescriptor and
// composeShadowFromECEF). Arrays are MAX_CASCADE_COUNT long, as allocated

export interface CloudShadowValues {
  cascadeCount: number
  readonly intervals: Vec2[]
  readonly matrices: Mat4[]
  readonly inverseMatrices: Mat4[]
  far: number
  topHeight: number
  readonly texelSize: Vec2
  // shadowMatrices[i] * ecefToWorld * altitude translation
  readonly shadowFromECEF: Mat4[]
  // Row 2 of viewMatrix * ecefToWorld * altitude translation
  readonly viewZFromECEF: Vec4
}

export function createCloudShadowValues(): CloudShadowValues {
  const list = <T>(make: () => T) =>
    Array.from({ length: MAX_CASCADE_COUNT }, make)
  return {
    cascadeCount: 0,
    intervals: list(() => new Vec2()),
    matrices: list(() => new Mat4()),
    inverseMatrices: list(() => new Mat4()),
    far: 0,
    topHeight: 0,
    texelSize: new Vec2(),
    shadowFromECEF: list(() => new Mat4()),
    viewZFromECEF: new Vec4()
  }
}

// On a frame that rendered the shadow map
export function updateCloudShadowValues(
  u: CloudShadowValues,
  csm: CascadedShadowMaps,
  inputs: CloudsInputs,
  shadowTopHeight: number
): void {
  u.cascadeCount = inputs.shadow.cascadeCount
  for (let i = 0; i < u.cascadeCount; i++) {
    const cascade = csm.cascades[i]!
    u.intervals[i]!.copy(cascade.interval)
    u.matrices[i]!.copy(cascade.matrix)
    u.inverseMatrices[i]!.copy(cascade.inverseMatrix)
  }
  u.far = csm.far
  u.topHeight = shadowTopHeight
  u.texelSize.set(1 / inputs.shadow.mapSize.x, 1 / inputs.shadow.mapSize.y)
}

const _altitudeTranslation = /*#__PURE__*/ new Mat4()
const _ecefToWorldCorrected = /*#__PURE__*/ new Mat4()
const _viewFromECEF = /*#__PURE__*/ new Mat4()

// Every frame, rendered or skipped: this frame's view and altitude correction
// over the matrices the map was rendered with
export function composeShadowFromECEF(
  u: CloudShadowValues,
  frame: FrameOfReference,
  viewMatrix: Mat4
): void {
  const c = frame.altitudeCorrection
  _altitudeTranslation.makeTranslation(-c.x, -c.y, -c.z)
  _ecefToWorldCorrected.multiplyMatrices(
    frame.ecefToWorldMatrix,
    _altitudeTranslation
  )
  for (let i = 0; i < MAX_CASCADE_COUNT; i++) {
    u.shadowFromECEF[i]!.multiplyMatrices(u.matrices[i]!, _ecefToWorldCorrected)
  }
  const e = _viewFromECEF.multiplyMatrices(
    viewMatrix,
    _ecefToWorldCorrected
  ).elements
  u.viewZFromECEF.set(e[2]!, e[6]!, e[10]!, e[14]!)
}
