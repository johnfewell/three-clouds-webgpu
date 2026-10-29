// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Side A: the original 0.7.6 WebGL chain for parity comparison

import {
  CopyPass,
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode
} from 'postprocessing'
import {
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NeutralToneMapping,
  PlaneGeometry,
  WebGLRenderer,
  WebGLRenderTarget,
  type ColorRepresentation
} from 'three'
import {
  createHashJitterTexture,
  loadBakedCloudTextures
} from 'three-clouds-webgpu'

import {
  AerialPerspectiveEffect,
  PrecomputedTexturesGenerator,
  SkyMaterial,
  type SkyLightProbe,
  type SunDirectionalLight
} from '@takram/three-atmosphere'
import {
  CloudsEffect,
  CloudShape,
  CloudShapeDetail,
  LocalWeather,
  Turbulence
} from '@takram/three-clouds'

import {
  asDebugView,
  MARCH_DEBUG_DEFINES,
  RESOLVE_DEBUG_DEFINES,
  syncDebugDefines
} from './debugViews'
import { applyLayerSet } from './layerSet'
import {
  applyCameraAspect,
  createParityCamera,
  type ParityCamera,
  type ParityCameraKind
} from './parityCamera'
import type { ParityCase, ParityKnobs } from './parityState'
import {
  createSyntheticScene,
  sunDirectionFromElevationAzimuth,
  type SyntheticSceneResult
} from './scenes/synthetic'
import { sitePath } from './sitePath'

export type LightingMode = 'post' | 'lights'

export interface SideAOptions {
  canvas: HTMLCanvasElement
  lighting?: LightingMode
  // Cases 53 and 46 are CONSTRUCTION-time here: an orthographic camera
  // is another class and logarithmicDepthBuffer a WebGLRenderer option, so the
  // case loader reads them before building the side
  camera?: ParityCameraKind
  logarithmicDepthBuffer?: boolean
  // Case 45: construction-time, see the assignment site
  proceduralTextures?: boolean
}

export interface SideAHandle {
  renderer: WebGLRenderer
  camera: ParityCamera
  clouds: ParityCloudsEffect
  aerial: AerialPerspectiveEffect
  composer: EffectComposer
  linearPass: CopyPass
  // Full-frame pre-tonemap target. With clouds disabled this contains only the
  // scene and atmosphere, which is the source for readSceneLinear()
  linearRT: WebGLRenderTarget
  sceneResult: SyntheticSceneResult
  skyMesh: Mesh
  applyCase(pc: ParityCase): void
  resetTemporalHistory(): void
  setSun(elevationDeg: number, azimuthDeg: number): void
  render(deltaTime: number): void
  recreate(): Promise<SideAHandle>
  dispose(): void
}

const DEG = Math.PI / 180

export class ParityCloudsEffect extends CloudsEffect {
  frameOverride = 0

  override update(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget,
    deltaTime?: number
  ): void {
    ;(this as unknown as { frame: number }).frame = this.frameOverride - 1
    super.update(renderer, inputBuffer, deltaTime)
  }
}

function applyNeutralisedKnobs(
  clouds: CloudsEffect,
  knobs: Partial<ParityKnobs>
): void {
  if (knobs.haze != null) clouds.haze = knobs.haze
  if (knobs.maxIterationCountToGround != null) {
    clouds.clouds.maxIterationCountToGround = knobs.maxIterationCountToGround
  }
  // the layer SET first, then the shadow flag over it. Order matters,
  // because applyLayerSet resets `shadow` on the slots it deactivates
  if (knobs.layers != null) {
    applyLayerSet(clouds.cloudLayers, knobs.layers)
  }
  if (knobs.shadow != null) {
    for (const layer of clouds.cloudLayers) {
      layer.shadow = knobs.shadow
    }
  }
  if (knobs.lightShafts != null) clouds.lightShafts = knobs.lightShafts
  if (knobs.temporalUpscale != null) {
    clouds.temporalUpscale = knobs.temporalUpscale
  }
  if (knobs.accuratePhaseFunction != null) {
    clouds.clouds.accuratePhaseFunction = knobs.accuratePhaseFunction
  }
  if (knobs.debug != null) {
    applyDebugView(clouds, knobs.debug)
  }
}

// Debug views are #ifdefs, so selecting one rebuilds the shader. needsUpdate is
// set only on a change (recompiling per frame stalls captures). Exported so
// set({ debug }) takes the case setup's own path
export function applyDebugView(clouds: CloudsEffect, debug: string): void {
  const pass = clouds.cloudsPass
  // Normalise first: the define tables are keyed by the LIBRARY's names, and the
  // knob arrives carrying the case registry's kebab-case spelling
  const view = asDebugView(debug)
  if (syncDebugDefines(pass.currentMaterial, MARCH_DEBUG_DEFINES, view)) {
    pass.currentMaterial.needsUpdate = true
  }
  if (syncDebugDefines(pass.resolveMaterial, RESOLVE_DEBUG_DEFINES, view)) {
    pass.resolveMaterial.needsUpdate = true
  }
}

// UNUSED (no callers, like recreate()). Kept only because the haze and
// maxIterationCountToGround clauses record knobs SUSPECTED one-way. The shadow
// clause was removed as measured-false (p00s receipt): suspicions, not facts
function _needsRecreate(
  prev: Partial<ParityKnobs>,
  next: Partial<ParityKnobs>
): boolean {
  if (prev.haze === true && next.haze === false) return true
  if (
    prev.maxIterationCountToGround !== 0 &&
    next.maxIterationCountToGround === 0
  )
    return true
  return false
}

export interface HistoryTarget {
  depth?: number
  isWebGLArrayRenderTarget?: boolean
}

// The part of WebGLRenderer the history clear touches, so it can be tested
// without a WebGL context
export interface HistoryClearRenderer {
  getRenderTarget(): HistoryTarget | null
  setRenderTarget(target: HistoryTarget | null, activeCubeFace?: number): void
  getClearColor(target: Color): Color
  getClearAlpha(): number
  setClearColor(color: ColorRepresentation, alpha?: number): void
  clear(color?: boolean, depth?: boolean, stencil?: boolean): void
}

// Clears every layer of every target to ZERO in all four channels. These hold
// data: the atlas alpha is the optical-depth tail, so the default clear alpha
// of 1 became injected tail and doubled thin-caster shadow
export function clearHistoryTargets(
  renderer: HistoryClearRenderer,
  targets: readonly HistoryTarget[]
): void {
  const previous = renderer.getRenderTarget()
  const clearColor = renderer.getClearColor(new Color())
  const clearAlpha = renderer.getClearAlpha()
  renderer.setClearColor(0x000000, 0)
  try {
    for (const target of targets) {
      const depth =
        target.isWebGLArrayRenderTarget === true ? (target.depth ?? 1) : 1
      for (let layer = 0; layer < depth; layer++) {
        renderer.setRenderTarget(target, layer)
        renderer.clear(true, true, true)
      }
    }
  } finally {
    renderer.setClearColor(clearColor, clearAlpha)
    renderer.setRenderTarget(previous)
  }
}

export async function createSideA(opts: SideAOptions): Promise<SideAHandle> {
  const {
    canvas,
    lighting = 'post',
    camera: cameraKind = 'perspective',
    logarithmicDepthBuffer = false,
    proceduralTextures = false
  } = opts

  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    preserveDrawingBuffer: true,
    logarithmicDepthBuffer
  })
  renderer.toneMapping = NeutralToneMapping
  renderer.toneMappingExposure = 1

  const camera = createParityCamera(cameraKind)

  const sceneResult = createSyntheticScene({
    nodeMaterials: false,
    lighting
  })
  const { scene, enuAtAnchor } = sceneResult

  // Sky plane
  const skyMaterial = new SkyMaterial()
  const skyMesh = new Mesh(new PlaneGeometry(2, 2), skyMaterial)
  skyMesh.frustumCulled = false
  scene.add(skyMesh)

  // LUTs
  const generator = new PrecomputedTexturesGenerator(renderer)
  await generator.update()
  const textures = generator.textures

  Object.assign(skyMaterial, textures)

  // CloudsEffect
  const clouds = new ParityCloudsEffect(camera)
  clouds.skipRendering = true
  clouds.temporalUpscale = false

  // Assign LUT textures to clouds
  clouds.irradianceTexture = textures.irradianceTexture ?? null
  clouds.scatteringTexture = textures.scatteringTexture ?? null
  clouds.transmittanceTexture = textures.transmittanceTexture ?? null
  if (textures.singleMieScatteringTexture) {
    clouds.singleMieScatteringTexture = textures.singleMieScatteringTexture
  }
  if (textures.higherOrderScatteringTexture) {
    clouds.higherOrderScatteringTexture = textures.higherOrderScatteringTexture
  }

  // Load baked textures
  const bakedTextures = await loadBakedCloudTextures({
    localWeather: sitePath('assets/local_weather.png'),
    turbulence: sitePath('assets/turbulence.png'),
    shape: sitePath('assets/shape.bin'),
    shapeDetail: sitePath('assets/shape_detail.bin')
  })
  // Case 45. Both packages expose the same four generators, so this is
  // a genuine A/B of generated-vs-baked. Construction-time: assigned once here,
  // and the context keeps whichever kind it was given
  if (proceduralTextures) {
    clouds.localWeatherTexture = new LocalWeather()
    clouds.turbulenceTexture = new Turbulence()
    clouds.shapeTexture = new CloudShape()
    clouds.shapeDetailTexture = new CloudShapeDetail()
  } else {
    clouds.localWeatherTexture = bakedTextures.localWeatherTexture
    clouds.turbulenceTexture = bakedTextures.turbulenceTexture
    clouds.shapeTexture = bakedTextures.shapeTexture
    clouds.shapeDetailTexture = bakedTextures.shapeDetailTexture
  }

  // Jitter volume
  const jitterTexture = createHashJitterTexture()
  clouds.stbnTexture = jitterTexture

  // AerialPerspectiveEffect
  const aerial = new AerialPerspectiveEffect(camera, {
    sunLight: lighting === 'post',
    skyLight: lighting === 'post',
    ...textures
  })
  aerial.stbnTexture = jitterTexture

  // NormalPass (post-lighting mode only)
  let normalPass: NormalPass | null = null
  if (lighting === 'post') {
    normalPass = new NormalPass(scene, camera)
    aerial.normalBuffer = normalPass.texture
  }

  // Lights mode: scene already has SunDirectionalLight + SkyLightProbe
  // from createSyntheticScene. Wire them up with LUT textures.
  let sunLight: SunDirectionalLight | null = null
  let skyProbe: SkyLightProbe | null = null
  if (lighting === 'lights') {
    scene.traverse(obj => {
      if (obj.name === 'sunLight') sunLight = obj as SunDirectionalLight
      if (obj.name === 'skyProbe') skyProbe = obj as SkyLightProbe
    })
    if (sunLight != null) {
      Object.assign(sunLight, textures)
    }
    if (skyProbe != null) {
      Object.assign(skyProbe, textures)
    }
  }

  // Cloud → aerial wiring
  clouds.events.addEventListener('change', e => {
    if (e.property === 'atmosphereOverlay') {
      aerial.overlay = clouds.atmosphereOverlay
    } else if (e.property === 'atmosphereShadow') {
      aerial.shadow = clouds.atmosphereShadow
    } else if (e.property === 'atmosphereShadowLength') {
      aerial.shadowLength = clouds.atmosphereShadowLength
    }
  })

  // EffectComposer
  const composer = new EffectComposer(renderer, {
    frameBufferType: HalfFloatType
  })
  composer.addPass(new RenderPass(scene, camera))
  if (normalPass != null) {
    composer.addPass(normalPass)
  }
  composer.addPass(new EffectPass(camera, clouds, aerial))
  const linearRT = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    stencilBuffer: false,
    depthBuffer: false
  })
  const linearPass = new CopyPass(linearRT)
  composer.addPass(linearPass)
  composer.addPass(
    new EffectPass(
      camera,
      new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL })
    )
  )

  let _currentKnobs: Partial<ParityKnobs> = {}

  // the reference has no reset API, so side A goes cold by CLEARING
  // its private history targets to zero, exactly what a fresh allocation holds
  // A setSize round-trip would be a silent no-op at equal dimensions
  interface ReferencePassInternals {
    historyRenderTarget?: HistoryTarget | null
    resolveRenderTarget?: HistoryTarget | null
  }

  // Every consumer of the sun on this side, in one place. Moving the sun
  // DURING a sequence, and a second list would light the clouds and the sky
  // from different angles, so applyCase calls this
  function setSun(elevationDeg: number, azimuthDeg: number): void {
    const sunDir = sunDirectionFromElevationAzimuth(
      elevationDeg * DEG,
      azimuthDeg * DEG,
      enuAtAnchor
    )
    clouds.sunDirection.copy(sunDir)
    aerial.sunDirection.copy(sunDir)
    skyMaterial.sunDirection.copy(sunDir)

    if (sunLight != null) {
      sunLight.sunDirection.copy(sunDir)
      sunLight.update()
    }
    if (skyProbe != null) {
      skyProbe.sunDirection.copy(sunDir)
      skyProbe.update()
    }
  }

  function resetTemporalHistory(): void {
    const effect = clouds as unknown as {
      cloudsPass?: ReferencePassInternals
      shadowPass?: ReferencePassInternals
    }
    const targets = [
      effect.cloudsPass?.historyRenderTarget,
      effect.cloudsPass?.resolveRenderTarget,
      effect.shadowPass?.historyRenderTarget,
      effect.shadowPass?.resolveRenderTarget
    ].filter((t): t is HistoryTarget => t != null)

    // Both buffers of each ping-pong pair: which one is "history" depends on
    // the swap count, and clearing only the current one leaves the other warm
    // for the next swap to bring back
    clearHistoryTargets(renderer, targets)
  }

  function applyCase(pc: ParityCase): void {
    renderer.setSize(pc.width, pc.height)
    renderer.setPixelRatio(pc.pixelRatio)
    applyCameraAspect(camera, pc.width / pc.height)
    pc.camera(camera)

    setSun(pc.sun.elevation, pc.sun.azimuth)

    // The scene is authored in ECEF, so the frame is identity for every case
    // but 28 `ecef-rotated` (ParityCase.worldToECEF)
    clouds.worldToECEFMatrix.copy(pc.worldToECEF)
    aerial.worldToECEFMatrix.copy(pc.worldToECEF)
    skyMaterial.worldToECEFMatrix.copy(pc.worldToECEF)
    if (sunLight != null) sunLight.worldToECEFMatrix.copy(pc.worldToECEF)
    if (skyProbe != null) skyProbe.worldToECEFMatrix.copy(pc.worldToECEF)

    clouds.correctAltitude = true
    aerial.correctAltitude = true

    applyNeutralisedKnobs(clouds, pc.knobs)
    _currentKnobs = { ...pc.knobs }

    if (clouds instanceof ParityCloudsEffect) {
      clouds.frameOverride = pc.frame
    }

    composer.setSize(pc.width, pc.height)
  }

  function render(deltaTime: number): void {
    // Position sky at camera
    skyMesh.position.copy(camera.position)

    composer.render(deltaTime)
  }

  function dispose(): void {
    composer.dispose()
    generator.dispose()
    bakedTextures.localWeatherTexture.dispose()
    bakedTextures.turbulenceTexture.dispose()
    bakedTextures.shapeTexture.dispose()
    bakedTextures.shapeDetailTexture.dispose()
    jitterTexture.dispose()
    renderer.dispose()
  }

  async function recreate(): Promise<SideAHandle> {
    composer.dispose()
    return createSideA(opts)
  }

  return {
    renderer,
    camera,
    clouds,
    aerial,
    composer,
    linearPass,
    linearRT,
    sceneResult,
    skyMesh,
    applyCase,
    resetTemporalHistory,
    setSun,
    render,
    recreate,
    dispose
  }
}
