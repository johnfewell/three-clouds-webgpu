// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Side B: the WebGPU TSL chain, canonical wiring per ADR-001

import {
  Color,
  HalfFloatType,
  Matrix4,
  NeutralToneMapping,
  RenderTarget,
  Vector2
} from 'three'
import {
  aerialPerspectiveWithCloudShadow,
  assertWebGPUSupported,
  CloudShadowedAtmosphereLightNode,
  CloudShape,
  CloudShapeDetail,
  clouds as createClouds,
  createCloudShadowTransmittance,
  createGetShadowRadius,
  createHashJitterTexture,
  DEFAULT_SHADOW_RADIUS,
  getSTBN,
  loadBakedCloudTextures,
  LocalWeather,
  Turbulence,
  type CloudsContext,
  type CloudsPassNode,
  type GroundShadowExtraDeps
} from 'three-clouds-webgpu'
import {
  context,
  float,
  Fn,
  mrt,
  normalView,
  output,
  pass,
  uniform,
  uv,
  vec4
} from 'three/tsl'
import { RenderPipeline, WebGPURenderer, type Node } from 'three/webgpu'

import {
  AtmosphereContext,
  AtmosphereLight,
  AtmosphereLightNode,
  type AerialPerspectiveNode
} from '@takram/three-atmosphere/webgpu'
import {
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

import {
  configureAtmosphereProfile,
  type AtmosphereProfileMode
} from './atmosphereProfile'
import { asDebugView } from './debugViews'
import { applyLayerSet } from './layerSet'
import {
  applyCameraAspect,
  createParityCamera,
  type ParityCamera,
  type ParityCameraKind
} from './parityCamera'
import type { ParityCase } from './parityState'
import {
  createSyntheticScene,
  sunDirectionFromElevationAzimuth,
  type SyntheticSceneResult
} from './scenes/synthetic'
import { sitePath } from './sitePath'

export type LightingMode = 'post' | 'lights'

// ── Narrow shims for gaps in three's public typings ─────────────
// Each replaces an `as any` and names the missing member: `any` disables
// checking wherever it flows, a shim disables exactly one member

// inverseViewMatrix() is typed as a bare Node<T> with no TSL operators. The
// runtime value is a mat4 node, and .mul is the documented way to transform a
// vec4 by it
interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

export interface SideBOptions {
  canvas: HTMLCanvasElement
  lighting?: LightingMode
  forceWebGL?: boolean
  reversedDepthBuffer?: boolean
  // Cases 53 and 46, both CONSTRUCTION-time. logarithmicDepthBuffer is
  // READ BACK onto the context every update (CloudsPassNode:594), so a context
  // knob would be silently reverted each frame
  camera?: ParityCameraKind
  logarithmicDepthBuffer?: boolean
  // Case 45: construction-time, see the assignment site
  proceduralTextures?: boolean
  atmosphereProfile?: AtmosphereProfileMode
}

export interface SideBHandle {
  renderer: WebGPURenderer
  camera: ParityCamera
  cloudsPass: CloudsPassNode
  cloudsContext: CloudsContext
  atmosphereContext: AtmosphereContext
  /** The atmosphere profile this side was configured with (ADR-013 A6) */
  atmosphereProfile: AtmosphereProfileMode
  aerial: AerialPerspectiveNode
  pipeline: RenderPipeline
  // Full-frame pre-tonemap target. With clouds disabled, composite(aerial)
  // passes the scene/atmosphere plate through unchanged for readSceneLinear()
  linearRT: RenderTarget
  /**
   * Step 1: the site-2 PCF radius lane's target, or null when this side
   * built no lane (lighting:'lights', or no shadow consumer at all). NULL IS
   * LOAD-BEARING: the capture refuses on it rather than reading zeros.
   */
  shadowRadiusRT: RenderTarget | null
  /** Renders the radius lane, false when there is none. See shadowRadiusRT. */
  renderShadowRadius(): boolean
  sceneResult: SyntheticSceneResult
  applyCase(pc: ParityCase): void
  resetTemporalHistory(): void
  setSun(elevationDeg: number, azimuthDeg: number): void
  render(): void
  renderLinear(): void
  dispose(): void
}

const DEG = Math.PI / 180

export async function createSideB(opts: SideBOptions): Promise<SideBHandle> {
  const {
    canvas,
    lighting = 'post',
    forceWebGL = false,
    reversedDepthBuffer = false,
    camera: cameraKind = 'perspective',
    logarithmicDepthBuffer = false,
    proceduralTextures = false
  } = opts

  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL,
    trackTimestamp: true,
    reversedDepthBuffer,
    logarithmicDepthBuffer
  })
  renderer.toneMapping = NeutralToneMapping
  renderer.toneMappingExposure = 1
  await renderer.init()

  // Refuse an unsupported backend HERE so createSideB rejects (8ff). The
  // pass's own WebGL2 throw is swallowed by three's node build, and case 54
  // walked past it into a black plate that looked like a rendering bug
  assertWebGPUSupported(renderer)

  const camera = createParityCamera(cameraKind)

  const sceneResult = createSyntheticScene({
    nodeMaterials: true,
    lighting
  })
  const { scene, enuAtAnchor } = sceneResult

  // ADR-004: context injection, atmosphere + clouds on the renderer
  const atmosphereContext = new AtmosphereContext()
  atmosphereContext.camera = camera
  // Parity pin: groundAlbedo defaults to
  // 0.1 in WebGL and 0.3 in WebGPU and feeds the LUT precompute (B +11-17 %)
  // Side A is the reference look, so B takes its value. ADR-013.
  atmosphereContext.parameters.groundAlbedo.setScalar(0.1)
  // Atmosphere method (ADR-013 Amendment 6): side B reads the LUT as
  // side A does (aerialPerspectiveEffect.frag:135). The former 256-sample
  // raymarch pin cost 6.9x A's frame, kept as opt-in 'raymarch-256'
  configureAtmosphereProfile(
    atmosphereContext,
    opts.atmosphereProfile ?? 'reference'
  )

  // CloudsPassNode owns the authoritative CloudsContext (this.cloudsContext)
  // The getClouds closure captures the variable binding so it returns the
  // correct instance once the pass is created below (line ~125)
  // Assigned once below, after the pass is constructed. `const` cannot express
  // a deferred single assignment, and the closure needs the binding
  // eslint-disable-next-line prefer-const
  let cloudsContext!: CloudsContext

  const existingContext =
    (renderer.contextNode?.value as Record<string, unknown>) ?? {}
  renderer.contextNode = context({
    ...existingContext,
    getAtmosphere: () => atmosphereContext,
    getClouds: () => cloudsContext
  })

  // AtmosphereLight for 'lights' mode (harmless in 'post': BasicNodeMaterial
  // ignores lights)
  // Registration is class-wide in r187, so each scene owns its light class
  class ParityAtmosphereLight extends AtmosphereLight {}
  const atmosphereLight = new ParityAtmosphereLight()
  atmosphereLight.name = 'atmosphereLight'
  scene.add(atmosphereLight)

  // a plain clear, not skyBackground(). The aerial node's own sky
  // overwrites every far-plane pixel, so a background sky was wasted work
  // Alpha stays 1 either way
  scene.background = new Color(0x000000)

  // ADR-001: MRT scene pass, color + normal
  const scenePass = pass(scene, camera, { samples: 0 })
  scenePass.setMRT(
    mrt({
      output,
      normal: normalView
    })
  )

  // Clouds pass first: the shadow descriptor is needed before wiring aerial
  const cloudsPass = createClouds({
    sceneDepth: scenePass.getTextureNode('depth')
  })
  cloudsPass.camera = camera
  cloudsContext = cloudsPass.cloudsContext

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
    cloudsContext.localWeatherTexture = new LocalWeather()
    cloudsContext.turbulenceTexture = new Turbulence()
    cloudsContext.shapeTexture = new CloudShape()
    cloudsContext.shapeDetailTexture = new CloudShapeDetail()
  } else {
    cloudsContext.localWeatherTexture = bakedTextures.localWeatherTexture
    cloudsContext.turbulenceTexture = bakedTextures.turbulenceTexture
    cloudsContext.shapeTexture = bakedTextures.shapeTexture
    cloudsContext.shapeDetailTexture = bakedTextures.shapeDetailTexture
  }

  // Jitter volume
  const jitterTexture = createHashJitterTexture()
  cloudsContext.stbnTexture = jitterTexture

  // Shadow consumer wiring: external uniforms mirroring CloudsPassNode's
  // private march uniforms so we can call createCloudShadowTransmittance
  const viewMatrixU = uniform(camera.matrixWorldInverse).setName(
    'shadowConsumer_viewMatrix'
  )
  const cameraNearU = uniform(camera.near).setName('shadowConsumer_cameraNear')
  const sunDirectionU = uniform(cloudsContext.sunDirection.clone()).setName(
    'shadowConsumer_sunDirection'
  )
  const ecefToWorldMatrixU = uniform(
    new Matrix4().copy(cloudsContext.ecefToWorldMatrix)
  ).setName('shadowConsumer_ecefToWorldMatrix')
  const worldToECEFMatrixU = uniform(
    new Matrix4().copy(cloudsContext.worldToECEFMatrix)
  ).setName('shadowConsumer_worldToECEFMatrix')
  const altitudeCorrectionU = uniform(
    cloudsContext.altitudeCorrection.clone()
  ).setName('shadowConsumer_altitudeCorrection')
  const worldToUnitU = uniform(1 / cloudsContext.bottomRadius).setName(
    'shadowConsumer_worldToUnit'
  )
  const temporalJitterU = uniform(new Vector2()).setName(
    'shadowConsumer_temporalJitter'
  )
  const resolutionU = uniform(
    new Vector2(cloudsContext.shadow.mapSize.x, cloudsContext.shadow.mapSize.y)
  ).setName('shadowConsumer_resolution')

  // getShadowRadius measures a shadow texel's footprint in SCREEN pixels, so it
  // needs the render size. resolutionU above is the shadow map size, a
  // different quantity
  const screenResolutionU = uniform(new Vector2()).setName(
    'shadowConsumer_screenResolution'
  )
  const shadowFrameU = uniform(0).setName('shadowConsumer_shadowFrame')

  const shadowDeps: GroundShadowExtraDeps = {
    viewMatrix: viewMatrixU,
    cameraNear: cameraNearU,
    sunDirection: sunDirectionU,
    bottomRadius: float(cloudsContext.bottomRadius),
    ecefToWorldMatrix: ecefToWorldMatrixU,
    altitudeCorrection: altitudeCorrectionU,
    worldToUnit: worldToUnitU,
    temporalJitter: temporalJitterU,
    resolution: resolutionU
  }

  const transmittanceFn = createCloudShadowTransmittance(
    cloudsPass.cloudShadow,
    shadowDeps,
    { enabled: true }
  )

  // Cite: @takram/three-atmosphere shared.js:445-446: the aerial/light shadow
  // consumer computes a per-pixel adaptive PCF radius and an STBN jitter. The
  // port passed 0 for both, point-sampling every shadow
  const shadowRadiusFn = createGetShadowRadius({
    shadowMatrices: cloudsPass.cloudShadow.matrices,
    inverseShadowMatrices: cloudsPass.cloudShadow.inverseMatrices,
    shadowMapSize: resolutionU,
    // geospatial's helper is generically typed, and it is a mat4 here
    projectionMatrix: projectionMatrix(camera) as Node<'mat4'>,
    viewMatrix: viewMatrixU,
    resolution: screenResolutionU,
    shadowRadius: float(DEFAULT_SHADOW_RADIUS)
  })
  const shadowStbn = getSTBN(jitterTexture, shadowFrameU)

  // ADR-007: wire shadow consumers per lighting mode
  let aerialShadowNode: Node<'float'> | null = null
  // Step 1: the site-2 PCF radius lane. Diagnostic only, never
  // composited: it lets the receipt say what the radius remap returns per case,
  // which no capture has measured
  let shadowRadiusLaneNode: Node<'vec4'> | null = null
  if (lighting === 'lights') {
    // 3.2b: the light node multiplies direct illuminance by shadow
    // transmittance
    class ParityShadowedLightNode extends CloudShadowedAtmosphereLightNode {
      constructor(light?: AtmosphereLight | null) {
        super(light)
        this.shadowTransmittanceFn = transmittanceFn
        this.shadowRadiusFn = shadowRadiusFn
        this.stbnNode = shadowStbn
      }
    }
    ParityAtmosphereLight.registerNode(ParityShadowedLightNode)
  } else {
    // 3.2a: aerial perspective multiplies direct illuminance by shadow
    // transmittance via a standalone node that reconstructs surface position
    const sceneDepthTex = scenePass.getTextureNode('depth')
    // ONE receiver reconstruction feeds both the transmittance and the radius
    // lane, so they cannot diverge in position, radius or jitter
    const shadowSampleInputs = (): {
      corrected: Node<'vec3'>
      radius: Node<'float'>
      stbn: Node<'float'>
      valid: Node<'float'>
    } => {
      // jg7u (ADR-013 Amendment 5): uv() as-is, as the port's aerial node
      // does. The old v-flip matched a mirrored A, and with both mirrors gone
      // it put receivers on the mirror row (SSIM 0.41, jg7u run 18)
      const d = sceneDepthTex.r.toConst()
      const viewZ = depthToViewZ(d, camera)
      const posView = screenToPositionView(
        uv(),
        d,
        viewZ,
        projectionMatrix(camera),
        inverseProjectionMatrix(camera)
      ) as unknown as Node<'vec3'>
      const posWorld = (
        inverseViewMatrix(camera) as unknown as Mat4NodeLike
      ).mul(vec4(posView, 1)).xyz
      const posECEF = worldToECEFMatrixU.mul(vec4(posWorld, 1)).xyz
      const corrected = posECEF.add(altitudeCorrectionU)
      // Nearly every shadow case takes 3.2a (only one sets 'lights'), so the
      // adaptive radius is supplied HERE as well as on the light node: a zero
      // here point-samples the whole ladder
      return {
        corrected,
        radius: shadowRadiusFn(posWorld),
        stbn: shadowStbn,
        // 1 where this consumer runs, 0 at the far plane. Sky pixels
        // also read radius 0, so without this the receipt would count sky as
        // "not armed" and report false negatives
        valid: d.lessThan(1).select(float(1), float(0))
      }
    }

    aerialShadowNode = Fn(() => {
      const { corrected, radius, stbn } = shadowSampleInputs()
      return transmittanceFn(corrected, radius, stbn)
    })()

    // Built from shadowSampleInputs like the transmittance above, so the
    // receipt cannot report a radius the consumer did not use
    shadowRadiusLaneNode = Fn(() => {
      const { radius, valid } = shadowSampleInputs()
      return vec4(radius, valid, 0, 1)
    })()

    ParityAtmosphereLight.registerNode(AtmosphereLightNode)
  }

  // Both lighting modes need the live shadow-length node for light shafts
  // Only post mode applies the separate surface-shadow multiplier here;
  // lights mode already applies it through ParityShadowedLightNode above
  const aerial = aerialPerspectiveWithCloudShadow(
    scenePass.getTextureNode('output'),
    scenePass.getTextureNode('depth'),
    cloudsPass.cloudShadowLength,
    aerialShadowNode,
    scenePass.getTextureNode('normal')
  )
  aerial.normalNode = scenePass.getTextureNode('normal')
  aerial.lighting = lighting === 'post'

  // ADR-001: clouds.composite(aerial) → tonemap. composite() takes the aerial
  // node directly, so no cast sits between the producer and the call
  const compositeNode = cloudsPass.composite(aerial)
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputNode = compositeNode

  // ADR-011: linear readback pipeline, same composite, no tonemapping
  const linearRT = new RenderTarget(1, 1, { type: HalfFloatType })
  const linearPipeline = new RenderPipeline(renderer, compositeNode)
  linearPipeline.outputColorTransform = false

  // Step 1: the radius lane's own target and pipeline, SEPARATE from
  // the scored linear readback and null on the 'lights' branch. HalfFloat like
  // linearRT: 2^-9 resolution near 3, far from the 0.1 and 3 that matter
  const shadowRadiusRT =
    shadowRadiusLaneNode == null
      ? null
      : new RenderTarget(1, 1, { type: HalfFloatType })
  const shadowRadiusPipeline =
    shadowRadiusLaneNode == null
      ? null
      : new RenderPipeline(renderer, shadowRadiusLaneNode)
  if (shadowRadiusPipeline != null) {
    shadowRadiusPipeline.outputColorTransform = false
  }

  // Mirror of sideA.setSun: every sun consumer on this side (renderLinear syncs
  // nothing, so it is written here too). resetHistory() makes
  // `warmup N` mean N frames FROM COLD
  function resetTemporalHistory(): void {
    cloudsContext.resetHistory()
  }

  function setSun(elevationDeg: number, azimuthDeg: number): void {
    const sunDir = sunDirectionFromElevationAzimuth(
      elevationDeg * DEG,
      azimuthDeg * DEG,
      enuAtAnchor
    )
    atmosphereContext.sunDirectionECEF.value.copy(sunDir)
    cloudsContext.sunDirection.copy(sunDir)
    sunDirectionU.value.copy(sunDir)
  }

  function applyCase(pc: ParityCase): void {
    renderer.setSize(pc.width, pc.height)
    renderer.setPixelRatio(pc.pixelRatio)
    linearRT.setSize(pc.width * pc.pixelRatio, pc.height * pc.pixelRatio)
    // the radius lane is frame-sized like linearRT. Left 1x1, it gave
    // a confident zero over ONE pixel (`classified=1/1`), caught only because
    // the receipt prints its denominator
    shadowRadiusRT?.setSize(pc.width * pc.pixelRatio, pc.height * pc.pixelRatio)
    applyCameraAspect(camera, pc.width / pc.height)
    pc.camera(camera)

    setSun(pc.sun.elevation, pc.sun.azimuth)

    // Atmosphere context uniforms
    atmosphereContext.matrixWorldToECEF.value.copy(pc.worldToECEF)
    atmosphereContext.correctAltitude = true

    // Clouds context
    cloudsContext.worldToECEFMatrix.copy(pc.worldToECEF)
    cloudsContext.correctAltitude = true

    cloudsContext.frame = pc.frame
    cloudsContext.time = pc.time

    // Per-layer shadow flag, outside PARITY_KEYS, mirroring sideA. The
    // layer SET first, then the flag, because applyLayerSet resets `shadow` on
    // deactivated slots
    if (pc.knobs.layers != null) {
      applyLayerSet(cloudsContext.cloudLayers, pc.knobs.layers)
    }
    if (pc.knobs.shadow != null) {
      for (const layer of cloudsContext.cloudLayers) {
        layer.shadow = pc.knobs.shadow
      }
    }
    if (pc.knobs.enabled != null) {
      cloudsContext.enabled = pc.knobs.enabled
    }
    // Graph-time on this side: the setter bumps graphVersion and rebuilds, and
    // is a no-op when the value is unchanged, so this is safe per frame
    if (pc.knobs.debug != null) {
      cloudsContext.debug = asDebugView(pc.knobs.debug)
    }
  }

  function render(): void {
    camera.updateMatrixWorld()
    // Sync shadow uniforms with current frame state
    viewMatrixU.value.copy(camera.matrixWorldInverse)
    cameraNearU.value = camera.near
    renderer.getSize(screenResolutionU.value)
    shadowFrameU.value = cloudsContext.frame
    sunDirectionU.value.copy(cloudsContext.sunDirection)
    ecefToWorldMatrixU.value.copy(cloudsContext.ecefToWorldMatrix)
    worldToECEFMatrixU.value.copy(cloudsContext.worldToECEFMatrix)
    altitudeCorrectionU.value.copy(cloudsContext.altitudeCorrection)
    worldToUnitU.value = 1 / cloudsContext.bottomRadius
    resolutionU.value.set(
      cloudsContext.shadow.mapSize.x,
      cloudsContext.shadow.mapSize.y
    )
    pipeline.render()
  }

  function renderLinear(): void {
    renderer.setRenderTarget(linearRT)
    linearPipeline.render()
    renderer.setRenderTarget(null)
  }

  /**
   * render the site-2 radius lane. Returns false when there is no
   * lane, and the capture REFUSES on that rather than reading zero.
   */
  function renderShadowRadius(): boolean {
    if (shadowRadiusRT == null || shadowRadiusPipeline == null) return false
    renderer.setRenderTarget(shadowRadiusRT)
    shadowRadiusPipeline.render()
    renderer.setRenderTarget(null)
    return true
  }

  function dispose(): void {
    bakedTextures.localWeatherTexture.dispose()
    bakedTextures.turbulenceTexture.dispose()
    bakedTextures.shapeTexture.dispose()
    bakedTextures.shapeDetailTexture.dispose()
    jitterTexture.dispose()
    linearRT.dispose()
    linearPipeline.dispose()
    shadowRadiusRT?.dispose()
    shadowRadiusPipeline?.dispose()
    cloudsPass.dispose()
    atmosphereContext.dispose()
    void renderer.dispose()
  }

  return {
    renderer,
    camera,
    cloudsPass,
    cloudsContext,
    atmosphereContext,
    atmosphereProfile: opts.atmosphereProfile ?? 'reference',
    aerial,
    pipeline,
    linearRT,
    shadowRadiusRT,
    renderShadowRadius,
    sceneResult,
    applyCase,
    resetTemporalHistory,
    setSun,
    render,
    renderLinear,
    dispose
  }
}
