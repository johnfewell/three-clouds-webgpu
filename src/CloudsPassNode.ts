// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import {
  Box3,
  Matrix4,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type DataArrayTexture,
  type Texture
} from 'three'
import {
  float,
  mrt,
  texture as tslTexture,
  uniform,
  uniformArray
} from 'three/tsl'
import {
  NodeMaterial,
  NodeUpdateType,
  NodeUtils,
  QuadMesh,
  RendererUtils,
  TempNode,
  type ComputeNode,
  type Node,
  type NodeBuilder,
  type NodeFrame,
  type RenderTarget,
  type StorageArrayTexture,
  type StorageTexture,
  type TextureNode,
  type UniformNode
} from 'three/webgpu'

import type { AerialPerspectiveNode } from '@takram/three-atmosphere/webgpu'

import { CloudsContext } from './CloudsContext'
import { inspectCloudsBackend } from './diagnostics'
import {
  createCirrusDeckUniforms,
  updateCirrusDeckUniforms,
  type CirrusDeckUniforms
} from './experimental/cirrusDeck'
import { createCirrusStreaksTexture } from './experimental/cirrusStreaks'
import { CloudEnvironmentNode } from './experimental/cloudEnvironment'
import {
  buildCloudShapeDeps,
  type CloudShapeDeps
} from './experimental/cloudShape'
import { buildComputeCloudsResolve } from './experimental/computeResolve'
import { buildComputeShadowResolve } from './experimental/computeShadowResolve'
import {
  buildConvectiveDeps,
  createConvectiveUniforms,
  updateConvectiveUniforms,
  type ConvectiveDeps,
  type ConvectiveUniforms
} from './experimental/convectiveProfile'
import { EvolvingWeather } from './experimental/evolvingWeather'
import {
  createLightningUniforms,
  updateLightningUniforms,
  type LightningUniforms
} from './experimental/lightning'
import {
  experimentalWarnings,
  type ExperimentalWarning
} from './experimental/options'
import {
  buildRainShaftDeps,
  createRainShaftUniforms,
  updateRainShaftUniforms,
  type RainShaftDeps,
  type RainShaftUniforms
} from './experimental/rainShafts'
import { StaticModeTracker } from './experimental/staticMode'
import { WindHistory } from './experimental/WindHistory'
import {
  createLayerUniforms,
  updateLayerUniforms,
  type LayerUniforms
} from './layerUniforms'
import { buildCloudsFragment } from './march/cloudsFragment'
import {
  createMarchUniforms,
  updateMarchUniforms,
  type MarchUniforms
} from './marchUniforms'
import {
  createParameterUniforms,
  disposePlaceholders,
  updateParameterUniforms,
  type OwnedPlaceholders,
  type ParameterUniforms
} from './parameterUniforms'
import { CloudsCompositeNode, CloudsTextureNode } from './pass/compositeNodes'
import { resolveDebugColor } from './pass/debugViews'
import { hashGraphFlags, supportsQuadOperations } from './pass/graphKey'
import {
  applyMarchFragmentNode,
  buildFragmentDeps,
  buildMarchFactories,
  buildSceneDepthNode,
  type MarchGraphHost
} from './pass/marchGraph'
import { buildShadowPassGraph, type ShadowGraphHost } from './pass/shadowGraph'
import {
  createShadowPassUniforms,
  shadowTemporalAlpha,
  updateShadowPassUniforms,
  type ShadowPassUniforms
} from './pass/shadowUniforms'
import {
  clearHistoryPair,
  createLayerTarget,
  createResolveTarget,
  createShadowAtlasTexture,
  createShadowLengthPlaceholder,
  createShadowTarget
} from './pass/targets'
import {
  buildCloudsResolve,
  CLOUDS_TEMPORAL_ALPHA,
  type CloudsResolveDeps
} from './resolve/cloudsResolve'
import {
  CascadedShadowMaps,
  MAX_CASCADE_COUNT
} from './shadow/CascadedShadowMaps'
import { buildCloudShadowLength } from './shadow/CloudShadowLengthNode'
import {
  cloudShadowAtlasResolution,
  createCloudShadowNode,
  type CloudShadowAtOptions
} from './shadow/cloudShadowNode'
import { MIP_LEVELS } from './shadow/opticalDepthMarch'
import { DEFAULT_SHADOW_RADIUS } from './shadow/shadowRadius'
import { buildShadowCascadeResolve } from './shadow/shadowResolve'
import { ShadowRoundRobin } from './shadow/shadowRoundRobin'

// Re-exported so index.ts and the sibling tests keep importing the pass's
// helpers from the file that has always owned them
export { hashGraphFlags, shadowTemporalAlpha, supportsQuadOperations }

const { resetRendererState, restoreRendererState } = RendererUtils

const sizeScratch = /*#__PURE__*/ new Vector2()
const jitterScratch = /*#__PURE__*/ new Vector2()
const resolutionScratch = /*#__PURE__*/ new Vector2()
/**
 * The only argument {@link clouds} takes. Every knob lives on
 * `cloudsPass.cloudsContext` instead. A null depth node disables scene
 * occlusion, and replacing the node rebuilds the graph
 */
export interface CloudsOptions {
  /**
   * The scene's depth texture node, which the march uses to stop at solid
   * geometry. `null` is valid but disables scene occlusion, so clouds may
   * appear in front of terrain that should hide them
   */
  sceneDepth: TextureNode | null
}

// The one place the atlas's sampling contract is written down: the real
// targets and the pre-allocation placeholder must both come from here. Cite:
// ShadowPass.ts:21–31

// three picks `textureSample` or `textureLoad` at build time, from the texture
// bound then, which is this 1×1 placeholder. DataArrayTexture defaults to
// Nearest, and a later swap to the Linear atlas never recompiles

/**
 * The surface `uniformArray()` exposes to a shader. three does not export a
 * `UniformArrayNode` type from its .d.ts, so the seam is declared structurally:
 * indexing is all the cascade code does with these.
 */
export interface UniformArrayLike<T extends string> {
  element: (index: Node<'int'> | number) => Node<T>
  /** The backing JS array the CPU side writes each frame */
  readonly array: unknown[]
}

// Cite: CloudsEffect.ts:421–431 (AtmosphereShadow)
export interface CloudShadowDescriptor {
  /**
   * The atlas the CPU side points at each update. Read this for identity
   * checks; shaders must bind {@link CloudShadowDescriptor.mapNode} instead.
   */
  map: DataArrayTexture
  /**
   * The atlas as the shader sees it. `map` is reassigned every update
   * (ShadowPass.ts:164-171: history when temporalPass, raw otherwise), and a
   * shader that captured the raw `Texture` would keep the 1x1 placeholder.
   *
   * A TextureNode whose `.value` follows the swap. A captured Texture made the
   * shafts and the BSM hook read zeros from a full atlas
   */
  mapNode: TextureNode
  /** The atlas's resolution in texels, shared with `ctx.shadow.mapSize` */
  readonly mapSize: Vector2
  /**
   * Follows `ctx.shadow.cascadeCount`. NOT readonly and NOT fixed at mint: the
   * descriptor object outlives any cascade-count change, because consumers hold
   * its nodes
   */
  cascadeCount: number
  /**
   * The same count as a node, so consumers can guard the cascade loop at RUNTIME
   * instead of unrolling `cascadeCount` when they build. A consumer built once
   * (every external one, `createCloudShadowTransmittance` in particular) is
   * otherwise frozen at whatever count was current then
   */
  readonly cascadeCountNode: UniformNode<'int', number>
  /** Each cascade's near and far distance, for depth-range selection */
  readonly intervals: UniformArrayLike<'vec2'>

  /** Each cascade's light view-projection matrix */
  readonly matrices: UniformArrayLike<'mat4'>

  /** Each cascade's inverse of {@link matrices} */
  readonly inverseMatrices: UniformArrayLike<'mat4'>

  /** The far plane of the cascade set */
  readonly far: UniformNode<'float', number>

  /** Height of the top of the shadow-mapped volume, in metres */
  readonly topHeight: UniformNode<'float', number>

  /** One over the atlas resolution, for converting between the two */
  readonly texelSize: UniformNode<'vec2', Vector2>
}

/**
 * Refuses an uninitialized, unknown or non-native WebGPU backend from the
 * caller's own stack
 *
 * Call this once after `await renderer.init()` and before constructing the
 * pass:
 *
 * ```ts
 * const renderer = new WebGPURenderer({ forceWebGL: true })
 * await renderer.init()
 * assertWebGPUSupported(renderer) // throws here, where you can catch it
 * ```
 *
 * WHY THIS EXISTS SEPARATELY FROM THE setup() CHECK. CloudsPassNode.setup()
 * also throws on a WebGL backend, and that throw CANNOT refuse construction:
 * setup() runs inside three's node-build try/catch, which catches the error,
 * re-emits it as a `THREE.TSL: Error: ...` console message, and finishes the
 * build without the pass. Measured on a WebGL2 run:
 * the message appears as a console error with a ContextNode.setup stack, the
 * page produces ZERO pageerror events, the renderer reports itself as booted,
 * and the observable result is a silently black frame. A caller relying on the
 * documented "setup() throws" got a black render instead of an exception.
 *
 * Call only after initialization, when `renderer.initialized` is true. A
 * backend object can exist before `init()` and does not establish readiness
 */
export function assertWebGPUSupported(renderer: unknown): void {
  const diagnostic = inspectCloudsBackend(renderer)
  if (diagnostic != null)
    throw new Error(`${diagnostic.message} ${diagnostic.remedy}`)
}

/**
 * The cloud pass owns its march and resolve targets. The scene MRT contains
 * scene color and normals, not the cloud outputs:
 *
 * ```ts
 * scenePass.setMRT(mrt({ output, normal: normalView }))
 * const cloudsPass = clouds({ sceneDepth: scenePass.getTextureNode('depth') })
 * cloudsPass.camera = camera
 * pipeline.outputNode = cloudsPass.composite(aerial)
 * ```
 *
 * The graph order is scene MRT, cloud march, aerial perspective with sky,
 * then cloud composite. WEBGPU.md shows the complete context and aerial
 * wiring. The output nodes exist before the first build and stay live
 *
 * @remarks
 * Requires: initialized native WebGPU, scene camera, cloud and atmosphere providers
 * Mutation: replacing camera or depth rebuilds the graph and resets history
 * Ownership: dispose() releases pass resources, not assigned context textures
 * The renderer, scene, camera and atmosphere remain caller-owned
 */
export class CloudsPassNode extends TempNode {
  static get type(): string {
    return 'CloudsPassNode'
  }

  /** Every knob. This is the object an application configures */
  readonly cloudsContext = new CloudsContext()

  /**
   * The sky plus a low-resolution cloud march, as a cube map node. Assign it to
   * `scene.environmentNode` (or sample it) to have reflections carry clouds.
   * Reads back null until `experimental.cloudEnvironment` is on and the graph
   * has been built.
   */
  readonly environment = new CloudEnvironmentNode()

  /**
   * The march render target, shared with the pass. Treat it as read-only: its
   * attachment count follows `lightShafts`, so it is reallocated when that
   * changes.
   */
  layerRT: RenderTarget

  /** The shaded cloud colour the composite reads */
  readonly layerNode: CloudsTextureNode

  /**
   * The march's second attachment: front distance times `worldToUnit` in `.x`
   * and UV velocity in `.yz`. Divide distance by the cloud scale to recover
   * metres, not by the atmosphere's kilometre scale
   */
  readonly depthVelocityNode: CloudsTextureNode
  private _lastLayerLightShafts: boolean

  private _sceneDepth: TextureNode | null
  private _camera: Camera | null = null
  private _inputVersion = 0
  private _assetsReady = true
  private lastBuiltInputVersion = -1

  /** @internal Input revision for composition invalidation */
  get inputVersion(): number {
    return this._inputVersion
  }

  /** @internal Asset readiness never overwrites the caller's enabled intent */
  setAssetsReady(ready: boolean): void {
    if (this._assetsReady === ready) return
    this._assetsReady = ready
    this._inputVersion++
    this.needsUpdate = true
    this.cloudsContext.resetHistory()
  }

  /** @internal Effective rendering state for the pass and its consumers */
  get renderingEnabled(): boolean {
    return this.cloudsContext.enabled && this._assetsReady
  }

  /** The scene depth this pass marches against. Same option as the factory */
  get sceneDepth(): TextureNode | null {
    return this._sceneDepth
  }

  set sceneDepth(value: TextureNode | null) {
    if (this._sceneDepth !== value) {
      this._sceneDepth = value
      this._inputVersion++
      this.needsUpdate = true
      this.cloudsContext.resetHistory()
    }
  }

  private readonly material = new NodeMaterial()
  private readonly mesh = new QuadMesh(this.material)
  private rendererState?: RendererUtils.RendererState
  private lastBuiltVersion = -1
  private preparedShadowFrame = -1
  private preparedShadowTime = NaN
  private preparedShadowVersion = -1
  private preparedShadowCamera: Camera | null = null
  private readonly preparedShadowWorld = new Matrix4()
  private readonly preparedShadowProjection = new Matrix4()
  private readonly preparedShadowSize = new Vector2()

  // History invalidation (Cite: CloudsPass.ts:203–224)
  private _historyInvalid = true
  private readonly _windHistory = new WindHistory()
  private readonly _staticTracker = new StaticModeTracker()
  private _convectiveUniforms: ConvectiveUniforms | null = null
  private _rainShaftUniforms: RainShaftUniforms | null = null
  // The deck's uniforms and its generated default texture, both made the first
  // time the option builds, so the off graph never pays for the texture
  private _cirrusDeckUniforms: CirrusDeckUniforms | null = null
  private _cirrusStreaks: Texture | null = null
  // The opt-in flash state. Unreferenced until experimental.lightning is on, so
  // an unused uniform emits no node and the off graph is unaffected
  private _lightningUniforms: LightningUniforms | null = null

  // The opt-in wind field and cloud life cycles. Its sampler is null unless
  // the option is on. Its knobs are CloudsContext.evolvingWeather
  readonly weatherEvolution = new EvolvingWeather()
  private _computeResolve: { target: RenderTarget; node: ComputeNode }[] = []
  private _resolveUsesCompute = false
  private _shadowResolveUsesCompute = false
  private _computeShadowResolve: { target: RenderTarget; node: ComputeNode }[] =
    []
  private _computeShadowDeps:
    Parameters<typeof buildComputeShadowResolve>[0] | null = null
  private _lastResolveW = 0
  private _lastResolveH = 0

  // Stale-frame warning (AUDIT-2)
  private _lastSeenFrame = -1
  private _staleFrameCount = 0
  private _warnedStaleFrame = false

  // Ids of experimental warnings already emitted, so each is logged once
  private readonly _warnedExperimental = new Set<string>()

  /**
   * The scene camera, which drives the ray directions, the shadow cascades and
   * the altitude correction. Set it before the first render: left null the pass
   * uses a default perspective camera, which is wrong for any other projection.
   */
  get camera(): Camera | null {
    return this._camera
  }

  set camera(value: Camera | null) {
    if (this._camera !== value) {
      this._camera = value
      this._inputVersion++
      this.needsUpdate = true
      this.cloudsContext.resetHistory()
    }
  }
  private _marchUniforms: MarchUniforms | null = null
  private _layerUniforms: LayerUniforms | null = null
  private _parameterUniforms:
    (ParameterUniforms & { placeholders: OwnedPlaceholders }) | null = null

  private readonly shadowMaterial = new NodeMaterial()
  private readonly shadowMesh = new QuadMesh(this.shadowMaterial)
  private shadowRT: RenderTarget | null = null
  private _shadowUniforms: ShadowPassUniforms | null = null
  private _cloudShadow: CloudShadowDescriptor | null = null
  // The atlas every shadow consumer reads while the pass is disabled
  private _litShadowAtlas: DataArrayTexture | null = null
  // shadowMatrices[i] and viewMatrix's view-Z row, each times ecefToWorld *
  // T(-altitudeCorrection), composed once per frame for
  // sampleShadowOpticalDepth's fast path
  private readonly _shadowFromECEF = uniformArray(
    Array.from({ length: MAX_CASCADE_COUNT }, () => new Matrix4()),
    'mat4'
  ).setName('pass_shadowFromECEF') as unknown as UniformArrayLike<'mat4'>
  private readonly _viewZFromECEF = uniform(new Vector4()).setName(
    'pass_viewZFromECEF'
  )
  private readonly _ecefToWorldCorrected = new Matrix4()
  private readonly _altitudeTranslation = new Matrix4()
  private readonly _viewFromECEF = new Matrix4()
  private _cloudShadowLength: Node<'vec2'> | null = null
  // The public cloud shadow builder, one per shadowSampleCount (0 = the
  // sampler's own default)
  private readonly _cloudShadowAtFns = new Map<
    number,
    (
      worldPosition: Node<'vec3'>,
      radius: Node<'float'>,
      jitter: Node<'float'>
    ) => Node<'float'>
  >()

  // Cite: ShadowPass.ts:85–86, 130–141 (shadow temporal resolve)
  private readonly shadowResolveMaterial = new NodeMaterial()
  private readonly shadowResolveMesh = new QuadMesh(this.shadowResolveMaterial)
  private shadowResolveRT: RenderTarget | null = null
  private shadowHistoryRT: RenderTarget | null = null
  private _shadowResolveHistoryTexNode: TextureNode | null = null
  // The OD atlas and velocity buffer as live handles: their targets are
  // recreated outside setup(), and a captured Texture kept sampling a disposed
  // one
  private _shadowOdTexNode: TextureNode | null = null
  private _shadowVelocityTexNode: TextureNode | null = null
  private _shadowVarianceGamma: UniformNode<'float', number> | null = null
  private _shadowTemporalAlpha: UniformNode<'float', number> | null = null
  // shadow.updateInterval: frames since the shadow map was last rendered
  // Starts "due" so the first frame renders whatever the interval
  private _shadowFramesSinceUpdate = Number.MAX_SAFE_INTEGER
  private _shadowHistoryInvalid = true
  private _prevShadowMatrices: Matrix4[] = []
  // shadow.temporalPass as the shadow graph was built. The frame that flips
  // the knob still runs the old program, so its targets must match that one
  private _shadowGraphTemporal: boolean | null = null
  private readonly _shadowRoundRobin = new ShadowRoundRobin()
  private readonly _shadowLayerBox = new Box3()
  private readonly _shadowLayerOrigin = new Vector3()

  // Cite: CloudsEffect.ts:421–431, CloudsPass.ts:158–167
  get cloudShadow(): CloudShadowDescriptor {
    if (this._cloudShadow == null) {
      const ctx = this.cloudsContext
      const n = ctx.shadow.cascadeCount
      // Deliberately Nearest, measured (mail #615, 2026-09-01). With Linear the
      // reads became textureSample and returned ~nothing on hardware: side B's
      // shaded fraction fell from 21.02 % to 2.19 % while SSIM barely moved

      // With Nearest the shadow is present, blocky, within 15 % of A's coverage,
      // and a bare sample can return ~zero. Cite: createShadowAtlasTexture
      const initialMap =
        (this.shadowRT?.texture as DataArrayTexture) ??
        createShadowAtlasTexture(1, 1, n, { renderTarget: false })
      this._cloudShadow = {
        map: initialMap,
        mapNode: tslTexture(initialMap),
        mapSize: ctx.shadow.mapSize,
        cascadeCount: n,
        cascadeCountNode: uniform(n, 'int').setName('cascade_count'),
        // Sized to MAX_CASCADE_COUNT so a cascade change never reallocates, as
        // CloudsMaterial.ts:236-242 does. A new descriptor orphaned captured
        // nodes and every cascade-config case lost its shadow
        intervals: uniformArray<'vec2'>(
          Array.from({ length: MAX_CASCADE_COUNT }, () => new Vector2()),
          'vec2'
        ).setName('cascade_intervals'),
        matrices: uniformArray<'mat4'>(
          Array.from({ length: MAX_CASCADE_COUNT }, () => new Matrix4()),
          'mat4'
        ).setName('cascade_matrices'),
        inverseMatrices: uniformArray<'mat4'>(
          Array.from({ length: MAX_CASCADE_COUNT }, () => new Matrix4()),
          'mat4'
        ).setName('cascade_inverseMatrices'),
        far: uniform(0).setName('cascade_far'),
        topHeight: uniform(0).setName('cascade_topHeight'),
        texelSize: uniform(
          new Vector2(1 / ctx.shadow.mapSize.x, 1 / ctx.shadow.mapSize.y)
        ).setName('cascade_texelSize')
      }
    }
    return this._cloudShadow
  }

  // Cite: ADR-005, the shadow length as the aerial consumer sees it. A live
  // node from construction: consumers capture it by value before the
  // pass builds, and a null left the shafts inert on side B

  // Minted on first access and never replaced. It reads the graph flags when
  // the consumer builds and samples a TextureNode that follows the history
  // swap, like cloudShadow.mapNode
  get cloudShadowLength(): Node<'vec2'> {
    if (this._cloudShadowLength == null) {
      const ctx = this.cloudsContext
      this._shadowLengthHistoryTexNode ??= tslTexture(
        this.shadowLengthPlaceholder
      )
      this._cloudShadowLength = buildCloudShadowLength({
        shadowLengthTextureNode: this._shadowLengthHistoryTexNode,
        isLive: () => ctx.lightShafts && this.renderingEnabled
      })
    }
    return this._cloudShadowLength
  }

  /**
   * Cloud shadow at a world position, as the sun transmittance in 0..1: 1 is
   * fully lit, 0 is fully shadowed. Multiply a material's sun-facing term by it
   * and water, vegetation, particles and custom lit surfaces take the shadow
   * the aerial perspective already puts on the ground below them.
   *
   * ```ts
   * material.colorNode = albedo.mul(pass.cloudShadowAt(positionWorld))
   * ```
   *
   * Nothing is built until this is called, so an unused call site cannot change
   * a pixel. The sample is the ground consumer's own transmittance, cascade
   * selection and all. The radius defaults to {@link DEFAULT_SHADOW_RADIUS},
   * not the per-pixel adaptive radius the aerial consumer computes, which
   * `options.radius` takes.
   */
  cloudShadowAt(
    worldPosition: Node<'vec3'>,
    options: CloudShadowAtOptions = {}
  ): Node<'float'> {
    const { radius, jitter, shadowSampleCount } = options
    const sample = this.cloudShadowTransmittanceFn(shadowSampleCount)
    return sample(
      worldPosition,
      radius ?? float(DEFAULT_SHADOW_RADIUS),
      jitter ?? float(0)
    )
  }

  // One builder per tap count, minted on demand: the march uniforms are created
  // here rather than in setup(), because a consumer reads this before the pass
  // builds and a null there left the shafts inert on side B
  private cloudShadowTransmittanceFn(
    shadowSampleCount?: number
  ): (
    worldPosition: Node<'vec3'>,
    radius: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'float'> {
    const count = shadowSampleCount ?? 0
    const cached = this._cloudShadowAtFns.get(count)
    if (cached != null) return cached
    const ctx = this.cloudsContext
    this._marchUniforms ??= createMarchUniforms(ctx)
    this._parameterUniforms ??= createParameterUniforms(ctx)
    const marchU = this._marchUniforms
    const paramU = this._parameterUniforms
    const descriptor = this.cloudShadow
    const fn = createCloudShadowNode(
      {
        descriptor,
        viewMatrix: ctx.cameraUniforms.viewMatrix,
        cameraNear: ctx.cameraUniforms.cameraNear,
        sunDirection: marchU.sunDirection,
        bottomRadius: marchU.bottomRadius,
        ecefToWorldMatrix: marchU.ecefToWorldMatrix,
        worldToECEFMatrix: marchU.worldToECEFMatrix,
        altitudeCorrection: marchU.altitudeCorrection,
        worldToUnit: marchU.worldToUnit,
        temporalJitter: paramU.temporalJitter,
        resolution: cloudShadowAtlasResolution(descriptor)
      },
      shadowSampleCount != null ? { shadowSampleCount } : {}
    )
    this._cloudShadowAtFns.set(count, fn)
    return fn
  }

  // Resolve pass ping-pong (Cite: CloudsPass.ts:134–157)

  /**
   * The resolve and history targets, swapped each frame. `historyRT` holds the
   * image the composite reads. Both are null until the first resolve, so read
   * {@link outputTextureNode} instead of reaching in here.
   */
  resolveRT: RenderTarget | null = null
  historyRT: RenderTarget | null = null
  private _outputTexNode: TextureNode | null = null
  private readonly resolveMaterial = new NodeMaterial()
  private readonly resolveMesh = new QuadMesh(this.resolveMaterial)
  private _resolveWidth: UniformNode<'float', number> | null = null
  private _resolveHeight: UniformNode<'float', number> | null = null
  private _varianceGamma: UniformNode<'float', number> | null = null
  private _temporalAlpha: UniformNode<'float', number> | null = null

  /**
   * The resolved cloud image, as the composite sees it: the history texture
   * after a resolve, the raw march otherwise. One node whose value follows the
   * history swap, so a consumer built early keeps reading the live image.
   */
  get outputTextureNode(): TextureNode {
    const tex =
      this.historyRT != null
        ? this.historyRT.textures[0]!
        : this.layerRT.textures[0]!
    if (this._outputTexNode == null) {
      this._outputTexNode = tslTexture(tex)
    } else {
      this._outputTexNode.value = tex
    }
    return this._outputTexNode
  }

  private _historyTexNode: TextureNode | null = null

  // Shadow-length temporal resolve: the second attachment of the resolve /
  // history pair (Cite: cloudsResolve.frag SHADOW_LENGTH branches). This node
  // follows historyRT.textures[1] across the swap; consumers sample it
  private _shadowLengthHistoryTexNode: TextureNode | null = null
  private readonly shadowLengthPlaceholder = createShadowLengthPlaceholder()
  private _resolveLightShafts: boolean | null = null

  constructor(options: CloudsOptions) {
    super('vec4')
    this.updateBeforeType = NodeUpdateType.FRAME
    this._sceneDepth = options.sceneDepth

    this._lastLayerLightShafts = this.cloudsContext.lightShafts
    this.layerRT = createLayerTarget(this._lastLayerLightShafts)
    this.layerNode = new CloudsTextureNode(this, 0)
    this.depthVelocityNode = new CloudsTextureNode(this, 1)

    this.material.name = 'CloudsPass'
    this.mesh.name = 'CloudsPass'
    this.shadowMaterial.name = 'ShadowPass'
    this.shadowMesh.name = 'ShadowPass'
    this.shadowResolveMaterial.name = 'ShadowResolve'
    this.shadowResolveMesh.name = 'ShadowResolve'
    this.resolveMaterial.name = 'CloudsResolve'
    this.resolveMesh.name = 'CloudsResolve'

    // Cite: CloudsEffect.ts:250–254
    this.cloudsContext.shadowMaps = new CascadedShadowMaps({
      cascadeCount: this.cloudsContext.shadow.cascadeCount,
      mapSize: this.cloudsContext.shadow.mapSize.clone(),
      splitLambda: this.cloudsContext.shadow.splitLambda
    })

    this.cloudsContext.registerResetHistory(() => this._resetHistoryImpl())
  }

  override customCacheKey(): number {
    return NodeUtils.hash(
      hashGraphFlags(
        this.renderingEnabled,
        this.sceneDepth == null,
        this.cloudsContext.graphFlags()
      ),
      this.inputVersion
    )
  }

  private graphNeedsRebuild(): boolean {
    return (
      this.cloudsContext.graphVersion !== this.lastBuiltVersion ||
      this.inputVersion !== this.lastBuiltInputVersion
    )
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    const { renderer } = frame
    if (renderer != null) {
      this.renderFrame(renderer, this.camera ?? frame.camera, false)
    }
    return undefined
  }

  /**
   * Prepare the current sample's shadow atlas before forward-lit scene captures.
   * Set time/frame/camera first and hold those inputs through the main render.
   * This does not march clouds or advance their colour history, and the following
   * updateBefore reuses the atlas. resetHistory invalidates that reuse.
   */
  prepareShadow(
    renderer: NonNullable<NodeFrame['renderer']>,
    camera: Camera | null = this.camera
  ): void {
    assertWebGPUSupported(renderer)
    this.renderFrame(renderer, camera, true)
  }

  private shadowPrepared(
    renderer: NonNullable<NodeFrame['renderer']>,
    camera: Camera
  ): boolean {
    const ctx = this.cloudsContext
    return (
      this.preparedShadowFrame === ctx.frame &&
      this.preparedShadowTime === ctx.time &&
      this.preparedShadowVersion === ctx.graphVersion &&
      this.preparedShadowCamera === camera &&
      this.preparedShadowWorld.equals(camera.matrixWorld) &&
      this.preparedShadowProjection.equals(camera.projectionMatrix) &&
      this.preparedShadowSize.equals(renderer.getDrawingBufferSize(sizeScratch))
    )
  }

  private rememberShadow(
    renderer: NonNullable<NodeFrame['renderer']>,
    camera: Camera
  ): void {
    const ctx = this.cloudsContext
    this.preparedShadowFrame = ctx.frame
    this.preparedShadowTime = ctx.time
    this.preparedShadowVersion = ctx.graphVersion
    this.preparedShadowCamera = camera
    this.preparedShadowWorld.copy(camera.matrixWorld)
    this.preparedShadowProjection.copy(camera.projectionMatrix)
    renderer.getDrawingBufferSize(this.preparedShadowSize)
  }

  private isStaticFrame(
    ctx: CloudsContext,
    camera: Camera,
    size: ReturnType<CloudsPassNode['frameDimensions']>
  ): boolean {
    const ready =
      this.historyRT != null &&
      this.shadowRT != null &&
      !this._historyInvalid &&
      !this._shadowHistoryInvalid
    return this._staticTracker.isStatic(ctx, camera, size, ready)
  }

  private skipStaticFrame(
    renderer: NonNullable<NodeFrame['renderer']>,
    camera: Camera,
    shadowOnly: boolean
  ): void {
    if (shadowOnly) {
      this.rememberShadow(renderer, camera)
    } else {
      this.preparedShadowFrame = -1
    }
  }

  private handleEarlyShadow(
    renderer: NonNullable<NodeFrame['renderer']>,
    camera: Camera,
    shadowOnly: boolean
  ): boolean {
    if (!shadowOnly) return false
    if (this.shadowPrepared(renderer, camera)) return true
    if (this.graphNeedsRebuild()) {
      this.buildGraph(renderer.hasFeature('subgroups'))
    }
    return false
  }

  private renderMarchAndResolve(
    renderer: NonNullable<NodeFrame['renderer']>,
    camera: Camera,
    size: ReturnType<CloudsPassNode['frameDimensions']>
  ): void {
    const ctx = this.cloudsContext
    this.preparedShadowFrame = -1
    renderer.setRenderTarget(this.layerRT)
    this.mesh.render(renderer)

    // Cite: CloudsPass.ts:193–200 (one pass resolves colour and shadow length)
    this.renderResolvePass(renderer, size.fullW, size.fullH)
    // The same two vectors the uniforms were just synced from, so the map
    // and the frame agree on where they are
    this.environment.bakeIfDue({
      renderer,
      cameraPositionECEF: ctx.cameraUniforms.cameraPositionECEF.value,
      sunDirectionECEF: ctx.sunDirection
    })
    ctx.cameraUniforms.copyReprojectionMatrix(camera)
    this._staticTracker.recordRender(ctx, camera, size)
  }

  private renderFrame(
    renderer: NonNullable<NodeFrame['renderer']>,
    camera: Camera | null,
    shadowOnly: boolean
  ): void {
    const ctx = this.cloudsContext

    if (this.graphNeedsRebuild()) {
      this.needsUpdate = true
    }

    // Cite: CloudsEffect.ts:473–476. Fill procedural textures before either
    // the shadow pass or primary march samples them. Each generator clears its
    // own needsRender flag, so the unconditional per-frame call becomes a no-op
    if (this._assetsReady && ctx.renderProceduralTextures(renderer)) {
      this._staticTracker.reset()
    }

    if (!this.renderingEnabled || camera == null) {
      this.preparedShadowFrame = -1
      this.showLitShadowAtlas()
      return
    }

    const size = this.frameDimensions(renderer)

    // TODO(port): Position the sun on the top atmosphere sphere. (CloudsEffect.ts:380)
    const shadowStructureChanged = ctx.checkShadowStructure()
    ctx.checkGroundBounce()
    ctx.checkCloudShape()
    // Cite: CloudsMaterial.ts:273–284 (detect renderer's log depth setting)
    ctx.logarithmicDepthBuffer =
      (renderer as unknown as { logarithmicDepthBuffer?: boolean })
        .logarithmicDepthBuffer === true

    if (this.isStaticFrame(ctx, camera, size)) {
      this.skipStaticFrame(renderer, camera, shadowOnly)
      return
    }

    if (!shadowOnly) {
      this.checkStaleFrame()
      this.checkExperimentalWarnings(ctx)
    }

    if (this.handleEarlyShadow(renderer, camera, shadowOnly)) return
    const prepared = this.shadowPrepared(renderer, camera)
    ctx.syncShadowMaps()
    ctx.updateCamera(camera)
    const shadowDue =
      !prepared && this.fitShadowMapsIfDue(ctx, camera, shadowStructureChanged)

    this.syncFrameUniforms(camera, size)
    if (!shadowOnly) this.updateWindHistory(ctx)

    this.rendererState = resetRendererState(
      renderer,
      this.rendererState as RendererUtils.RendererState
    )

    try {
      // Cite: CloudsEffect.ts:481 (shadow pass precedes every scene receiver)
      if (!prepared) this.shadowPassForFrame(ctx, renderer, shadowDue)
      if (shadowOnly) {
        this.rememberShadow(renderer, camera)
        return
      }
      this.renderMarchAndResolve(renderer, camera, size)
    } finally {
      restoreRendererState(renderer, this.rendererState)
    }
  }

  private frameDimensions(renderer: NonNullable<NodeFrame['renderer']>): {
    fullW: number
    fullH: number
    marchW: number
    marchH: number
  } {
    const ctx = this.cloudsContext
    const size = renderer.getDrawingBufferSize(sizeScratch)
    const fullW = Math.ceil(size.x * ctx.resolutionScale)
    const fullH = Math.ceil(size.y * ctx.resolutionScale)
    // Cite: CloudsPass.ts:205–225 (shared by early shadows and the colour pass)
    const divisor = ctx.temporalUpscale ? 4 : 1
    const marchW = Math.ceil(fullW / divisor)
    const marchH = Math.ceil(fullH / divisor)
    this.layerRT.setSize(marchW, marchH)
    return { fullW, fullH, marchW, marchH }
  }

  private syncFrameUniforms(
    camera: Camera,
    {
      fullW,
      fullH,
      marchW,
      marchH
    }: ReturnType<CloudsPassNode['frameDimensions']>
  ): void {
    const ctx = this.cloudsContext
    // Cite: CloudsMaterial.ts:338–358
    if (ctx.temporalUpscale) {
      const resW = marchW * 4
      const resH = marchH * 4
      resolutionScratch.set(resW, resH)
      ctx.cameraUniforms.update(camera, ctx.worldToECEFMatrix, {
        frame: ctx.frame,
        resolution: resolutionScratch,
        jitterOut: jitterScratch
      })
    } else {
      ctx.cameraUniforms.update(camera, ctx.worldToECEFMatrix)
    }

    if (this._marchUniforms != null) {
      updateMarchUniforms(this._marchUniforms, ctx)
    }
    if (this._layerUniforms != null) {
      updateLayerUniforms(this._layerUniforms, ctx)
    }
    this.weatherEvolution.update(ctx)
    if (this._parameterUniforms != null) {
      this.updateParameterUniformsForFrame(
        this._parameterUniforms,
        ctx,
        marchW,
        marchH,
        fullW,
        fullH
      )
    }
    // Written here and not only where the graph is built: ctx.convectiveProfile
    // is a plain field, so nothing bumps graphVersion for a knob and a
    // graph-time write would leave every slider inert after the first frame
    if (this._convectiveUniforms != null) {
      updateConvectiveUniforms(this._convectiveUniforms, ctx.convectiveProfile)
    }
    if (this._rainShaftUniforms != null) {
      updateRainShaftUniforms(this._rainShaftUniforms, ctx.rainShafts)
    }
    if (this._lightningUniforms != null) {
      updateLightningUniforms(this._lightningUniforms, ctx.lightning)
    }
    if (this._cirrusDeckUniforms != null && this._cirrusStreaks != null) {
      updateCirrusDeckUniforms(
        this._cirrusDeckUniforms,
        ctx.cirrusDeck,
        {
          bottomRadius: ctx.bottomRadius,
          time: ctx.time,
          height: fullH,
          camera
        },
        this._cirrusStreaks
      )
    }
  }

  // Written here and not only where the graph is built: ctx.lightning is a plain
  // field, so a consumer can strike and clear a flash without a rebuild, and a
  // graph-time write alone would leave every later frame stale
  private lightningUniforms(ctx: CloudsContext): LightningUniforms {
    this._lightningUniforms ??= createLightningUniforms(ctx.lightning)
    updateLightningUniforms(this._lightningUniforms, ctx.lightning)
    return this._lightningUniforms
  }

  private updateWindHistory(ctx: CloudsContext): void {
    if (ctx.experimental.windReprojection) this._windHistory.update(ctx)
  }

  // Cite: CloudsMaterial.ts:273–284 (backend detection)

  // A second line of defence, not the refusal: three turns a throw from setup()
  // into a console message and carries on. Callers refuse via
  // assertWebGPUSupported, and this only logs loudly if they never called it
  private assertWebGPUBackend(builder: NodeBuilder): void {
    const diagnostic = inspectCloudsBackend(builder.renderer, false)
    if (diagnostic != null)
      throw new Error(`${diagnostic.message} ${diagnostic.remedy}`)
  }

  override setup(builder: NodeBuilder): Node | null | undefined {
    this.assertWebGPUBackend(builder)
    // prepareShadow already built these materials for the same owned sample
    if (
      this.preparedShadowFrame === this.cloudsContext.frame &&
      this.preparedShadowVersion === this.cloudsContext.graphVersion
    )
      return this.layerNode
    return this.buildGraph(supportsQuadOperations(builder))
  }

  private buildGraph(quadOperations: boolean): Node {
    const ctx = this.cloudsContext
    const graphRebuild = this.lastBuiltVersion >= 0 && this.graphNeedsRebuild()

    this.ensureLayerRT(ctx.lightShafts)

    // The descriptor survives a cascade-count change (arrays at
    // MAX_CASCADE_COUNT, count synced per update), since replacing it orphaned
    // consumers' captures. graphFlags() rebuilds the graph itself

    this._marchUniforms ??= createMarchUniforms(ctx)
    this._layerUniforms ??= createLayerUniforms()
    this._parameterUniforms ??= createParameterUniforms(ctx)

    const marchU = this._marchUniforms
    const layerU = this._layerUniforms
    const paramU = this._parameterUniforms

    updateLayerUniforms(layerU, ctx)

    const {
      marchClouds,
      applyAerialPerspective,
      stbn,
      marchShadowLength,
      marchShadowLengthQuadPartial,
      approximateHaze,
      marchRainShafts,
      compositeCirrusDeck
    } = buildMarchFactories(
      ctx,
      marchU,
      layerU,
      paramU,
      ctx.lightShaftsHalfResolution && quadOperations,
      this.marchGraphHost()
    )

    const getRayDistanceToScene = buildSceneDepthNode(
      ctx,
      paramU,
      this.sceneDepth,
      this.camera
    )

    const deps = buildFragmentDeps(
      ctx,
      marchU,
      layerU,
      paramU,
      this._windHistory,
      () => this.cloudShadow,
      {
        marchClouds,
        applyAerialPerspective,
        getRayDistanceToScene,
        stbn,
        marchShadowLength,
        marchShadowLengthQuadPartial,
        approximateHaze,
        marchRainShafts,
        compositeCirrusDeck
      }
    )

    applyMarchFragmentNode(this.material, ctx, buildCloudsFragment(deps))
    this.buildCloudEnvironment(ctx, marchU, layerU, paramU)

    this.buildShadowGraph(ctx, marchU, layerU, paramU)
    this.buildShadowResolveGraph(ctx)
    this.buildResolveGraph(ctx, paramU)
    this.buildShadowLengthNode()

    // checkShadowStructure()'s reset is consumed by the old program before the
    // rebuild reaches setup(). Re-arm here so the new graph starts from cleared
    // targets, since at alpha 0.01 a stale frame lingers
    if (graphRebuild) this.reArmHistoriesForRebuild()
    this.lastBuiltVersion = ctx.graphVersion
    this.lastBuiltInputVersion = this.inputVersion
    return this.layerNode
  }

  // The seams between the pass and its graph modules, and nothing more. The
  // shadow descriptor is a thunk, so a build that never marches shadows does
  // not mint it. The convective deps stay a method, they own their uniform
  private marchGraphHost(): MarchGraphHost {
    return {
      ensureShadowRT: (w, h, d) => this.ensureShadowRT(w, h, d),
      cloudShadow: () => this.cloudShadow,
      shadowFromECEF: this._shadowFromECEF,
      viewZFromECEF: this._viewZFromECEF,
      windHistory: this._windHistory,
      weatherEvolution: this.weatherEvolution,
      convectiveDeps: (ctx, layerU, paramU) =>
        this.convectiveDeps(ctx, layerU, paramU),
      cloudShapeDeps: ctx => this.cloudShapeDeps(ctx),
      rainShaftDeps: (ctx, layerU, paramU) =>
        this.rainShaftDeps(ctx, layerU, paramU),
      lightningUniforms: this.lightningUniforms(this.cloudsContext),
      cirrusDeckUniforms: ctx => this.cirrusDeckUniforms(ctx)
    }
  }

  // The env bake is a second graph, not a variant of this one: its own step
  // budget and its own cube camera, on the same uniforms so it cannot drift
  // from the frame. Null-safe both ways, so the off graph is untouched
  private buildCloudEnvironment(
    ctx: CloudsContext,
    marchU: MarchUniforms,
    layerU: LayerUniforms,
    paramU: ParameterUniforms
  ): void {
    if (!ctx.experimental.cloudEnvironment) {
      this.environment.clear()
      return
    }
    this.environment.buildGraph(
      ctx,
      marchU,
      layerU,
      paramU,
      this.marchGraphHost()
    )
  }

  private shadowGraphHost(): ShadowGraphHost {
    return {
      material: this.shadowMaterial,
      ensureShadowRT: (w, h, d) => this.ensureShadowRT(w, h, d),
      shadowRT: () => this.shadowRT,
      odTexNode: () => this._shadowOdTexNode,
      weatherEvolution: this.weatherEvolution,
      convectiveDeps: (ctx, layerU, paramU) =>
        this.convectiveDeps(ctx, layerU, paramU),
      cloudShapeDeps: ctx => this.cloudShapeDeps(ctx)
    }
  }

  // The graph itself lives in pass/shadowGraph.ts. This owns the lazily-created
  // state it reads and writes, and keeps the allocation order unchanged
  private buildShadowGraph(
    ctx: CloudsContext,
    marchU: MarchUniforms,
    layerU: LayerUniforms,
    paramU: ParameterUniforms
  ): void {
    this._shadowUniforms ??= createShadowPassUniforms(ctx)
    this._shadowGraphTemporal = ctx.shadow.temporalPass
    const odTexNode = buildShadowPassGraph(
      ctx,
      marchU,
      layerU,
      paramU,
      this._shadowUniforms,
      this.shadowGraphHost()
    )
    this._shadowOdTexNode ??= odTexNode
  }

  // Null unless experimental.convectiveProfile is on, and null emits no nodes
  // at all. That, rather than a zeroed version of this, is what keeps the off
  // graph byte-identical to main
  private convectiveDeps(
    ctx: CloudsContext,
    layerU: LayerUniforms,
    paramU: ParameterUniforms
  ): ConvectiveDeps | null {
    if (!ctx.experimental.convectiveProfile) return null
    this._convectiveUniforms ??= createConvectiveUniforms(ctx.convectiveProfile)
    updateConvectiveUniforms(this._convectiveUniforms, ctx.convectiveProfile)
    return buildConvectiveDeps(
      {
        expTerms: layerU.densityProfileExpTerms,
        exponents: layerU.densityProfileExponents,
        linearTerms: layerU.densityProfileLinearTerms,
        constantTerms: layerU.densityProfileConstantTerms
      },
      layerU.minLayerHeights,
      layerU.maxLayerHeights,
      paramU.localWeatherRepeat,
      this._convectiveUniforms
    )
  }

  // Four seams, each null when its own magnitude is zero, and null emits no
  // nodes at all. That, rather than a zeroed version, is what keeps the default
  // graph byte-identical to the reference (cloudShape.digest.test.ts)
  private cloudShapeDeps(ctx: CloudsContext): CloudShapeDeps {
    return buildCloudShapeDeps(ctx.cloudShape, ctx.cloudLayers.structure.active)
  }

  // Null unless experimental.rainShafts is on, and null emits no nodes
  // The cells come from ctx.convectiveProfile, so a shaft sits under the tower
  // those numbers place rather than under a second set of cells
  private rainShaftDeps(
    ctx: CloudsContext,
    layerU: LayerUniforms,
    paramU: ParameterUniforms
  ): RainShaftDeps | null {
    if (!ctx.experimental.rainShafts) return null
    this._rainShaftUniforms ??= createRainShaftUniforms(ctx.rainShafts)
    updateRainShaftUniforms(this._rainShaftUniforms, ctx.rainShafts)
    return buildRainShaftDeps(
      this._rainShaftUniforms,
      paramU.localWeatherRepeat,
      layerU.minHeight,
      ctx.convectiveProfile
    )
  }

  // Null unless experimental.cirrusDeck is on, and null emits no nodes
  private cirrusDeckUniforms(ctx: CloudsContext): CirrusDeckUniforms | null {
    if (!ctx.experimental.cirrusDeck) return null
    this._cirrusStreaks ??= createCirrusStreaksTexture()
    this._cirrusDeckUniforms ??= createCirrusDeckUniforms(this._cirrusStreaks)
    return this._cirrusDeckUniforms
  }

  private ensureLayerRT(lightShafts: boolean): void {
    if (lightShafts === this._lastLayerLightShafts) return
    this._lastLayerLightShafts = lightShafts
    const w = this.layerRT.width
    const h = this.layerRT.height
    this.layerRT.dispose()
    this.layerRT = createLayerTarget(lightShafts)
    this.layerRT.setSize(w, h)
    this.layerNode.value = this.layerRT.textures[0]!
    this.depthVelocityNode.value = this.layerRT.textures[1]!
    if (this._outputTexNode != null && this.historyRT == null) {
      this._outputTexNode.value = this.layerRT.textures[0]!
    }
  }

  // Cite: CloudsMaterial.ts:338–358
  private updateParameterUniformsForFrame(
    paramU: ParameterUniforms & { placeholders: OwnedPlaceholders },
    ctx: CloudsContext,
    marchW: number,
    marchH: number,
    fullW: number,
    fullH: number
  ): void {
    updateParameterUniforms(paramU, ctx)
    if (ctx.temporalUpscale) {
      const resW = marchW * 4
      const resH = marchH * 4
      paramU.resolution.value.set(resW, resH)
      paramU.temporalJitter.value.copy(jitterScratch)
      // NOTE(port): Not exactly
      paramU.mipLevelScale.value = 0.25
      paramU.targetUvScale.value.set(resW / fullW, resH / fullH)
    } else {
      paramU.resolution.value.set(marchW, marchH)
      paramU.temporalJitter.value.set(0, 0)
      paramU.mipLevelScale.value = 1
      paramU.targetUvScale.value.set(1, 1)
    }
  }

  // Cite: shadowResolve.frag (76 lines), per-cascade temporal resolve
  private buildShadowResolveGraph(ctx: CloudsContext): void {
    if (!ctx.shadow.temporalPass || this._shadowUniforms == null) return
    const su = this._shadowUniforms
    const sz = ctx.shadow.mapSize
    const n = ctx.shadow.cascadeCount
    this.ensureShadowRT(sz.x, sz.y, n)
    this.ensureShadowResolveTargets(sz.x, sz.y, n)

    this._shadowVarianceGamma ??= uniform(1).setName(
      'shadowResolve_varianceGamma'
    )
    this._shadowTemporalAlpha ??= uniform(shadowTemporalAlpha(ctx)).setName(
      'shadowResolve_temporalAlpha'
    )

    this._shadowResolveHistoryTexNode ??= tslTexture(
      this.shadowHistoryRT!.texture
    )
    this._shadowOdTexNode ??= tslTexture(this.shadowRT!.texture)
    // The velocity is the shadow march target's second attachment
    this._shadowVelocityTexNode ??= tslTexture(this.shadowRT!.textures[1])

    const resolveDeps = {
      // Live handles, not raw Textures, see the field declarations. These two
      // were captured at build time and kept sampling disposed targets after a
      // cascade-count change (wh9a)
      odBuffer: this._shadowOdTexNode,
      velocityBuffer: this._shadowVelocityTexNode,
      // The node's .value follows swapShadowBuffers(); a raw Texture would alias
      // the target being written after the first swap (WebGPU usage error)
      historyBuffer: this._shadowResolveHistoryTexNode,
      texelSize: this.cloudShadow.texelSize,
      varianceGamma: this._shadowVarianceGamma,
      temporalAlpha: this._shadowTemporalAlpha,
      resolution: su.shadowResolution,
      cascadeIndex: su.cascadeIndex
    }
    this._computeShadowDeps = resolveDeps
    for (const { node } of this._computeShadowResolve) node.dispose()
    this._computeShadowResolve = []
    this.shadowResolveMaterial.fragmentNode =
      buildShadowCascadeResolve(resolveDeps)
    this.shadowResolveMaterial.name = 'ShadowResolve'
    this.shadowResolveMaterial.needsUpdate = true
  }

  // Cite: CloudsEffect.ts:481, ShadowPass.ts:124–141. updateInterval
  // (port-only) skips the shadow pass (~1.5–2 ms at 3 × 512²) between updates,
  // cheap because the map accumulates over ~1/alpha frames anyway

  // A cascade or size change, a history reset or the first frame forces a
  // render. Interval 1 is the reference's every-frame behaviour
  private isShadowUpdateDue(
    ctx: CloudsContext,
    shadowStructureChanged: boolean
  ): boolean {
    const interval = Math.max(1, Math.floor(ctx.shadow.updateInterval))
    return (
      interval === 1 ||
      shadowStructureChanged ||
      this._shadowHistoryInvalid ||
      this._shadowFramesSinceUpdate >= interval
    )
  }

  // On a frame without a shadow render the cascade fit stays too, so the map,
  // matrices and intervals remain a consistent set (see
  // refreshShadowComposition), and returns whether this frame renders
  private fitShadowMapsIfDue(
    ctx: CloudsContext,
    camera: Camera,
    shadowStructureChanged: boolean
  ): boolean {
    const due = this.isShadowUpdateDue(ctx, shadowStructureChanged)
    if (due) {
      ctx.updateShadowMaps(camera)
    }
    return due
  }

  private shadowPassForFrame(
    ctx: CloudsContext,
    renderer: NonNullable<NodeFrame['renderer']>,
    due: boolean
  ): void {
    if (due) {
      this.renderShadowPass(ctx, renderer)
      this._shadowFramesSinceUpdate = 1
    } else {
      this.refreshShadowComposition(ctx)
      this._shadowFramesSinceUpdate++
    }
  }

  // A skipped frame still recomposes the ECEF matrices with this frame's view
  // matrix and altitude correction. The cascade matrices stay the ones the map
  // was rendered with
  private refreshShadowComposition(ctx: CloudsContext): void {
    if (this._cloudShadow == null) return
    this.composeShadowFromECEF(
      ctx,
      this._cloudShadow.matrices.array as Matrix4[]
    )
  }

  private renderShadowPass(
    ctx: CloudsContext,
    renderer: NonNullable<NodeFrame['renderer']>
  ): void {
    if (ctx.shadowMaps == null || this._shadowUniforms == null) return

    const cascadeCount = ctx.shadow.cascadeCount
    const mapSize = ctx.shadow.mapSize
    this.ensureShadowRT(mapSize.x, mapSize.y, cascadeCount)

    updateShadowPassUniforms(this._shadowUniforms, ctx)
    if (this._shadowTemporalAlpha != null) {
      this._shadowTemporalAlpha.value = shadowTemporalAlpha(ctx)
    }
    const su = this._shadowUniforms
    const only = this.planShadowRoundRobin(ctx, cascadeCount)

    const temporal = this.shadowTemporalBuilt(ctx)
    // Ensure previous-frame matrix storage
    while (this._prevShadowMatrices.length < cascadeCount) {
      this._prevShadowMatrices.push(new Matrix4())
    }

    // Pass 1: OD march per cascade. With temporalPass the same pass writes the
    // depth velocity as a second attachment (shadow.frag:24-35, which
    // writes colour and velocity in one draw), so there is no velocity pass
    for (let i = 0; i < cascadeCount; i++) {
      if (only != null && i !== only) continue
      su.inverseShadowMatrix.value.copy(
        ctx.shadowMaps.cascades[i]!.inverseMatrix
      )
      su.mipLevel.value = MIP_LEVELS[i] ?? 2
      if (temporal) {
        su.reprojectionMatrix.value.copy(this._prevShadowMatrices[i]!)
        su.cascadeIndex.value = i
      }
      renderer.setRenderTarget(this.shadowRT, i)
      this.shadowMesh.render(renderer)
    }

    // Cite: ShadowPass.ts:130–141 (temporal resolve)
    if (temporal) {
      this.ensureShadowResolveTargets(mapSize.x, mapSize.y, cascadeCount)

      // Pass 3: resolve per cascade. A reset clears both ping-pong targets and
      // runs the ordinary resolve, as the reference harness does, so the result
      // does not depend on the setup path
      if (this._shadowHistoryInvalid) {
        clearHistoryPair(
          renderer,
          this.shadowHistoryRT,
          this.shadowResolveRT,
          cascadeCount
        )
      }
      this.renderShadowResolve(renderer, cascadeCount, only)
      this._shadowHistoryInvalid = false

      // Cite: ShadowPass.ts:105–112, 134–138 (store reprojection + swap)
      this.storeShadowReprojection(ctx, only)
      this.swapShadowBuffers()
    }
    if (ctx.experimental.shadowRoundRobin) {
      this._shadowRoundRobin.record(
        ctx.shadowMaps.cascades,
        cascadeCount,
        ctx.sunDirection,
        only
      )
    }
    // Without the temporal pass there is no history to clear, and a flag left
    // standing would force the map on every frame under shadow.updateInterval
    this._shadowHistoryInvalid = false

    this.updateCloudShadowDescriptor(ctx)
  }

  // The one cascade this update renders under experimental.shadowRoundRobin, or
  // null for all. The compute resolve covers every layer at once, so it opts out
  private planShadowRoundRobin(
    ctx: CloudsContext,
    cascadeCount: number
  ): number | null {
    if (!ctx.experimental.shadowRoundRobin || ctx.experimental.computeResolve) {
      this._shadowRoundRobin.invalidate()
      return null
    }
    return this._shadowRoundRobin.plan(
      ctx.shadowMaps!.cascades,
      cascadeCount,
      ctx.sunDirection,
      this._shadowHistoryInvalid
    )
  }

  private renderShadowResolve(
    renderer: NonNullable<NodeFrame['renderer']>,
    cascadeCount: number,
    only: number | null = null
  ): void {
    const deps = this._computeShadowDeps
    if (this.cloudsContext.experimental.computeResolve && deps != null) {
      if (
        !this._computeShadowResolve.some(
          entry => entry.target === this.shadowResolveRT
        )
      ) {
        for (const { node } of this._computeShadowResolve) node.dispose()
        this._computeShadowResolve = [
          this.shadowResolveRT!,
          this.shadowHistoryRT!
        ].map(target => ({
          target,
          node: buildComputeShadowResolve(
            deps,
            target.texture as StorageArrayTexture
          )
        }))
      }
      const node = this._computeShadowResolve.find(
        entry => entry.target === this.shadowResolveRT
      )!.node
      node.dispatchSize = [
        Math.ceil(this.shadowResolveRT!.width / 8),
        Math.ceil(this.shadowResolveRT!.height / 8),
        cascadeCount
      ]
      void renderer.compute(node)
      return
    }
    for (let i = 0; i < cascadeCount; i++) {
      // A reused cascade carries its history over exactly, never re-resolved
      // against a march that did not run this update
      if (only != null && i !== only) {
        this.copyShadowHistoryLayer(renderer, i)
        continue
      }
      this._shadowUniforms!.cascadeIndex.value = i
      renderer.setRenderTarget(this.shadowResolveRT, i)
      this.shadowResolveMesh.render(renderer)
    }
  }

  // A disabled pass renders no shadow maps, and consumers kept a
  // frozen cloud shadow from the last atlas. A zero atlas reads optical depth 0
  // everywhere, and the next enabled frame points back at the real atlas
  private showLitShadowAtlas(): void {
    const desc = this._cloudShadow
    // Only for a DISABLED pass: a missing camera keeps the last atlas
    if (this.renderingEnabled || desc == null) return
    if (this._litShadowAtlas == null) {
      this._litShadowAtlas = createShadowAtlasTexture(1, 1, MAX_CASCADE_COUNT, {
        renderTarget: false
      })
      this._litShadowAtlas.needsUpdate = true
    }
    desc.map = this._litShadowAtlas
    desc.mapNode.value = this._litShadowAtlas
  }

  // Cite: CloudsPass.ts:158–167, ShadowPass.ts:164–171 (outputBuffer)
  private updateCloudShadowDescriptor(ctx: CloudsContext): void {
    if (this._cloudShadow == null) return
    const desc = this._cloudShadow
    const cascades = ctx.shadowMaps!.cascades

    // Cite: ShadowPass.ts:164–171 (resolved output when temporalPass)
    if (this.shadowTemporalBuilt(ctx) && this.shadowHistoryRT != null) {
      desc.map = this.shadowHistoryRT.texture as DataArrayTexture
    } else {
      desc.map = this.shadowRT!.texture as DataArrayTexture
    }
    // The shader reads through the node, not through `map` (see mapNode's doc)
    desc.mapNode.value = desc.map

    // Follows ctx rather than staying at whatever it was when the descriptor was
    // minted: the descriptor outlives cascade-count changes
    desc.cascadeCount = ctx.shadow.cascadeCount
    desc.cascadeCountNode.value = desc.cascadeCount

    const intervals = desc.intervals.array as Vector2[]
    const matrices = desc.matrices.array as Matrix4[]
    const inverseMatrices = desc.inverseMatrices.array as Matrix4[]
    for (let i = 0; i < desc.cascadeCount; i++) {
      intervals[i]!.copy(cascades[i]!.interval)
      matrices[i]!.copy(cascades[i]!.matrix)
      inverseMatrices[i]!.copy(cascades[i]!.inverseMatrix)
    }
    desc.far.value = ctx.shadowMaps!.far
    desc.topHeight.value = this._layerUniforms?.shadowTopHeight.value ?? 0
    desc.texelSize.value.set(1 / ctx.shadow.mapSize.x, 1 / ctx.shadow.mapSize.y)

    this.composeShadowFromECEF(ctx, matrices)
  }

  // The composed matrices the marches sample shadows through. `viewMatrix` is
  // the camera's, as cameraUniforms holds it, and `ecefToWorldMatrix` and
  // `altitudeCorrection` are the context's for this frame
  private composeShadowFromECEF(ctx: CloudsContext, matrices: Matrix4[]): void {
    const correction = ctx.altitudeCorrection
    this._altitudeTranslation.makeTranslation(
      -correction.x,
      -correction.y,
      -correction.z
    )
    this._ecefToWorldCorrected.multiplyMatrices(
      ctx.ecefToWorldMatrix,
      this._altitudeTranslation
    )
    const composed = this._shadowFromECEF.array as Matrix4[]
    for (let i = 0; i < MAX_CASCADE_COUNT; i++) {
      composed[i]!.multiplyMatrices(matrices[i]!, this._ecefToWorldCorrected)
    }
    const viewMatrix = ctx.cameraUniforms.viewMatrix.value
    const e = this._viewFromECEF.multiplyMatrices(
      viewMatrix,
      this._ecefToWorldCorrected
    ).elements
    // Row 2 (z) of a column-major mat4: elements[col * 4 + row]
    this._viewZFromECEF.value.set(e[2], e[6], e[10], e[14])
  }

  private shadowTemporalBuilt(ctx: CloudsContext): boolean {
    return this._shadowGraphTemporal ?? ctx.shadow.temporalPass
  }

  private ensureShadowRT(width: number, height: number, depth: number): void {
    // With temporalPass the march pass also writes the depth velocity (a second
    // attachment), so the target's shape follows that flag too
    const withVelocity = this.shadowTemporalBuilt(this.cloudsContext)
    if (this.shadowRT != null) {
      const img = (this.shadowRT.texture as DataArrayTexture).image
      if (
        this.shadowRT.width === width &&
        this.shadowRT.height === height &&
        img.depth === depth &&
        this.shadowRT.textures.length === (withVelocity ? 2 : 1)
      ) {
        return
      }
      this.shadowRT.dispose()
    }
    this.shadowRT = createShadowTarget(
      width,
      height,
      depth,
      false,
      withVelocity
    )
    // Re-point every node that samples the atlas, or they keep the disposed one
    // until setup() happens to run again, which it does not on a runtime
    // cascade-count change (wh9a)
    if (this._shadowOdTexNode != null) {
      this._shadowOdTexNode.value = this.shadowRT.texture
    }
    if (withVelocity && this._shadowVelocityTexNode != null) {
      this._shadowVelocityTexNode.value = this.shadowRT.textures[1]!
    }
    // cloudShadow.map/.mapNode are not set here: the target depends on
    // temporalPass, and updateCloudShadowDescriptor settles it at the end of
    // every renderShadowPass
  }

  private ensureShadowResolveTargets(
    width: number,
    height: number,
    depth: number
  ): void {
    this.updateShadowResolveBackend(width, height, depth)
    if (this.shadowResolveRT == null) {
      this.shadowResolveRT = createShadowTarget(
        width,
        height,
        depth,
        this._shadowResolveUsesCompute
      )
      this.shadowHistoryRT = createShadowTarget(
        width,
        height,
        depth,
        this._shadowResolveUsesCompute
      )
      this._shadowHistoryInvalid = true
    } else {
      // Depth matters like width/height: at the old layer count pass 3 writes a
      // missing layer, WebGPU rejects the command buffer, and the history atlas
      // reads zero for good
      const img = (this.shadowResolveRT.texture as DataArrayTexture).image
      if (
        this.shadowResolveRT.width !== width ||
        this.shadowResolveRT.height !== height ||
        img.depth !== depth
      ) {
        this.shadowResolveRT.dispose()
        this.shadowHistoryRT?.dispose()
        this.shadowResolveRT = createShadowTarget(
          width,
          height,
          depth,
          this._shadowResolveUsesCompute
        )
        this.shadowHistoryRT = createShadowTarget(
          width,
          height,
          depth,
          this._shadowResolveUsesCompute
        )
        this._shadowHistoryInvalid = true
      }
    }
    // Both branches above can have replaced the history target underneath the
    // node the resolve pass samples. swapShadowBuffers re-points it too, but
    // only on the frames it runs, and the invalid-history frame returns early
    if (this._shadowResolveHistoryTexNode != null) {
      this._shadowResolveHistoryTexNode.value = this.shadowHistoryRT!.texture
    }
  }

  private updateShadowResolveBackend(
    width: number,
    height: number,
    depth: number
  ): void {
    const compute = this.cloudsContext.experimental.computeResolve
    if (compute === this._shadowResolveUsesCompute) return
    this.shadowResolveRT?.dispose()
    this.shadowHistoryRT?.dispose()
    this.shadowResolveRT = createShadowTarget(width, height, depth, compute)
    this.shadowHistoryRT = createShadowTarget(width, height, depth, compute)
    this._shadowResolveUsesCompute = compute
    this._shadowHistoryInvalid = true
  }

  // Cite: ShadowPass.ts:114–122
  private swapShadowBuffers(): void {
    const tmp = this.shadowResolveRT
    this.shadowResolveRT = this.shadowHistoryRT
    this.shadowHistoryRT = tmp
    if (this._shadowResolveHistoryTexNode != null) {
      this._shadowResolveHistoryTexNode.value = this.shadowHistoryRT!.texture
    }
  }

  private copyShadowHistoryLayer(
    renderer: NonNullable<NodeFrame['renderer']>,
    layer: number
  ): void {
    const src = this.shadowHistoryRT!.texture
    const { width, height } = this.shadowResolveRT!
    this._shadowLayerBox.min.set(0, 0, layer)
    this._shadowLayerBox.max.set(width, height, layer + 1)
    this._shadowLayerOrigin.set(0, 0, layer)
    renderer.copyTextureToTexture(
      src,
      this.shadowResolveRT!.texture,
      this._shadowLayerBox,
      this._shadowLayerOrigin
    )
  }

  // Cite: ShadowPass.ts:105–112. Under round-robin only the rendered cascade
  // moves on, so each reuses the matrix of its own last render
  private storeShadowReprojection(
    ctx: CloudsContext,
    only: number | null = null
  ): void {
    const cascadeCount = ctx.shadow.cascadeCount
    while (this._prevShadowMatrices.length < cascadeCount) {
      this._prevShadowMatrices.push(new Matrix4())
    }
    for (let i = 0; i < cascadeCount; i++) {
      if (only != null && i !== only) continue
      this._prevShadowMatrices[i]!.copy(ctx.shadowMaps!.cascades[i]!.matrix)
    }
  }

  private ensureResolveTargets(ctx: CloudsContext): void {
    this._resolveWidth ??= uniform(1).setName('resolve_width')
    this._resolveHeight ??= uniform(1).setName('resolve_height')
    this._varianceGamma ??= uniform(2).setName('resolve_varianceGamma')
    this._temporalAlpha ??= uniform(CLOUDS_TEMPORAL_ALPHA).setName(
      'resolve_temporalAlpha'
    )

    // The pair carries the shadow length as a second attachment only while
    // light shafts are on; a change re-allocates it (and re-arms the history,
    // as the rebuild boundary does for every accumulator)
    if (
      this.resolveRT == null ||
      this._resolveLightShafts !== ctx.lightShafts ||
      this._resolveUsesCompute !== ctx.experimental.computeResolve
    ) {
      this.resolveRT?.dispose()
      this.historyRT?.dispose()
      this.resolveRT = createResolveTarget(
        'Clouds.resolve',
        ctx.lightShafts,
        ctx.experimental.computeResolve
      )
      this.historyRT = createResolveTarget(
        'Clouds.history',
        ctx.lightShafts,
        ctx.experimental.computeResolve
      )
      this._resolveUsesCompute = ctx.experimental.computeResolve
      this._resolveLightShafts = ctx.lightShafts
      this._historyInvalid = true
    }
  }

  private buildResolveInputs(
    ctx: CloudsContext,
    paramU: ParameterUniforms
  ): CloudsResolveDeps {
    this._historyTexNode ??= tslTexture(this.historyRT!.textures[0])
    this._historyTexNode.value = this.historyRT!.textures[0]!
    // The consumer's node may already exist over the placeholder (the
    // cloudShadowLength getter): point it at the real history now, and
    // swapResolveBuffers keeps it pointed from here on
    this._shadowLengthHistoryTexNode ??= tslTexture(
      this.shadowLengthPlaceholder
    )
    this._shadowLengthHistoryTexNode.value = ctx.lightShafts
      ? this.historyRT!.textures[1]!
      : this.shadowLengthPlaceholder

    return {
      cloudHistoryValid: ctx.experimental.windReprojection
        ? this._windHistory.cloudValid
        : undefined,
      shadowHistoryValid: ctx.experimental.windReprojection
        ? this._windHistory.shadowValid
        : undefined,
      colorBuffer: this.layerRT.textures[0]!,
      depthVelocityBuffer: this.layerRT.textures[1]!,
      colorHistoryNode: this._historyTexNode,
      resolveWidth: this._resolveWidth!,
      resolveHeight: this._resolveHeight!,
      frame: paramU.frame,
      varianceGamma: this._varianceGamma!,
      temporalAlpha: this._temporalAlpha!
    }
  }

  private buildComputeResolveGraph(
    ctx: CloudsContext,
    resolveDeps: CloudsResolveDeps
  ): void {
    for (const { node } of this._computeResolve) node.dispose()
    this._computeResolve = []
    if (ctx.experimental.computeResolve && ctx.debug === 'none') {
      this._computeResolve = [this.resolveRT!, this.historyRT!].map(target => ({
        target,
        node: buildComputeCloudsResolve(
          resolveDeps,
          ctx.lightShafts
            ? {
                shadowLengthBuffer: this.layerRT.textures[2]!,
                shadowLengthHistoryNode: this._shadowLengthHistoryTexNode!
              }
            : null,
          ctx.temporalUpscale,
          target.textures[0]! as StorageTexture,
          ctx.lightShafts ? (target.textures[1] as StorageTexture) : undefined
        )
      }))
    }
  }

  // Cite: CloudsPass.ts:134-157,193-200
  private buildResolveGraph(
    ctx: CloudsContext,
    paramU: ParameterUniforms
  ): void {
    this.ensureResolveTargets(ctx)
    const resolveDeps = this.buildResolveInputs(ctx, paramU)
    this.buildComputeResolveGraph(ctx, resolveDeps)
    const resolved = buildCloudsResolve(
      resolveDeps,
      ctx.lightShafts
        ? {
            shadowLengthBuffer: this.layerRT.textures[2]!,
            shadowLengthHistoryNode: this._shadowLengthHistoryTexNode!
          }
        : null,
      ctx.temporalUpscale
    )
    const color = resolveDebugColor(ctx, resolved, this.layerRT.textures[1]!)
    this.resolveMaterial.fragmentNode =
      resolved.shadowLength != null
        ? mrt({ output: color, shadowLength: resolved.shadowLength })
        : color
    this.resolveMaterial.needsUpdate = true
  }

  private renderResolvePass(
    renderer: NonNullable<NodeFrame['renderer']>,
    fullW: number,
    fullH: number
  ): void {
    if (this.resolveRT == null || this.historyRT == null) return

    // Cite: CloudsPass.ts:203–224 (resize invalidates history)
    if (fullW !== this._lastResolveW || fullH !== this._lastResolveH) {
      if (this._lastResolveW !== 0) {
        this._historyInvalid = true
        this.cloudsContext.cameraUniforms.resetPreviousMatrices()
      }
      this._lastResolveW = fullW
      this._lastResolveH = fullH
    }

    if (fullW !== this.resolveRT.width || fullH !== this.resolveRT.height) {
      this.resolveRT.setSize(fullW, fullH)
      this.historyRT.setSize(fullW, fullH)
    }
    if (this._resolveWidth != null) {
      this._resolveWidth.value = fullW
      this._resolveHeight!.value = fullH
    }

    if (this._historyInvalid) {
      this._historyInvalid = false
      // Do not skip the resolve: skipping swapped to an unwritten buffer and
      // emitted the plate from two renders ago
      clearHistoryPair(renderer, this.historyRT, this.resolveRT)
    }

    const compute = this._computeResolve.find(
      entry => entry.target === this.resolveRT
    )?.node
    if (compute != null) {
      compute.dispatchSize = [Math.ceil(fullW / 8), Math.ceil(fullH / 8), 1]
      void renderer.compute(compute)
    } else {
      renderer.setRenderTarget(this.resolveRT)
      this.resolveMesh.render(renderer)
    }

    this.swapResolveBuffers()
  }

  // The reference resolves every frame with no history-invalid concept. Variance clipping turns a zero-filled history,
  // which it gets by allocation, into ~the current march

  // resetHistory() has no reference analogue and leaves the previous image, so
  // the zero fill is reproduced here. It also makes the first frame after boot
  // deterministic

  // Re-arm every history at the actual rebuild boundary. The old graph
  // consumed checkShadowStructure()'s flag, so the new one started "valid", and
  // at alpha 0.01 that frame held shadow-cascades-2x512 at 0.9334

  // With this and the both-target clear, both paths pass 0.95 on hardware
  private reArmHistoriesForRebuild(): void {
    this._resetHistoryImpl()
  }

  // Cite: CloudsPass.ts:174–183
  private swapResolveBuffers(): void {
    const tmp = this.resolveRT
    this.resolveRT = this.historyRT
    this.historyRT = tmp
    // Update the TextureNodes so the shaders read from the new history textures
    const history = this.historyRT!
    if (this._historyTexNode != null) {
      this._historyTexNode.value = history.textures[0]!
    }
    if (this._outputTexNode != null) {
      this._outputTexNode.value = history.textures[0]!
    }
    if (
      this._shadowLengthHistoryTexNode != null &&
      history.textures[1] != null
    ) {
      this._shadowLengthHistoryTexNode.value = history.textures[1]
    }
  }

  // Cite: ADR-005 (shadow length read-back node)
  private buildShadowLengthNode(): void {
    // Minted by the getter on first access, never here: a consumer
    // built before this pass must hold the same node. Touching the getter only
    // guarantees it exists when no consumer has asked yet
    void this.cloudShadowLength
  }

  private _resetHistoryImpl(): void {
    this._staticTracker.reset()
    this.preparedShadowFrame = -1
    this._windHistory.reset()
    // The shadow length shares the colour pair (one resolve pass, two
    // attachments), so one flag re-arms both
    this._historyInvalid = true
    // The shadow history was missing here, and a warm accumulator the caller
    // believes is cold reads as a converged measurement. The flag makes the
    // next shadow pass store and swap without blending
    this._shadowHistoryInvalid = true
    this.cloudsContext.cameraUniforms.resetPreviousMatrices()
  }

  private checkStaleFrame(): void {
    const ctx = this.cloudsContext
    if (!ctx.temporalUpscale) {
      this._staleFrameCount = 0
      this._warnedStaleFrame = false
      return
    }
    if (ctx.frame === this._lastSeenFrame) {
      this._staleFrameCount++
    } else {
      this._lastSeenFrame = ctx.frame
      this._staleFrameCount = 1
      this._warnedStaleFrame = false
    }
    if (
      this._staleFrameCount >= 16 &&
      !this._warnedStaleFrame &&
      ctx.warnings
    ) {
      console.warn(
        'three-clouds-webgpu: temporalUpscale is on but clouds.frame has not advanced for 16 renders — set clouds.frame every frame (WEBGPU.md "time and frame")'
      )
      this._warnedStaleFrame = true
    }
  }

  /**
   * Warn once per experimental option that is on but cannot do anything.
   *
   * These are documented limitations, not defects, so they are surfaced rather
   * than fixed: without this, an option reads as enabled and silently does
   * nothing (docs/EXPERIMENTAL.md). Gated on `warnings`, like the stale-frame
   * warning above, and warned once per id so a per-frame check cannot flood.
   */
  private checkExperimentalWarnings(ctx: CloudsContext): void {
    const active = experimentalWarnings({
      experimental: ctx.experimental,
      debug: ctx.debug,
      castsShadow: ctx.cloudLayers.castsShadow,
      localWeatherVelocity: ctx.localWeatherVelocity,
      lightShafts: ctx.lightShafts
    })
    // Forget the ones that cleared, so a problem that comes back warns again
    const current = new Set(active.map(warning => warning.id))
    for (const id of this._warnedExperimental) {
      if (!current.has(id)) this._warnedExperimental.delete(id)
    }
    if (!ctx.warnings) return
    for (const warning of active) {
      this.warnExperimentalOnce(warning)
    }
  }

  private warnExperimentalOnce(warning: ExperimentalWarning): void {
    if (this._warnedExperimental.has(warning.id)) return
    console.warn(warning.message)
    this._warnedExperimental.add(warning.id)
  }

  private readonly compositeNodes = new Map<
    Node<'vec4'> | AerialPerspectiveNode,
    CloudsCompositeNode
  >()

  /** Whether the pass retains any undisposed composite destinations */
  get hasComposite(): boolean {
    return this.compositeNodes.size > 0
  }

  /**
   * Build the node that mixes the resolved clouds into `dst`. The same
   * destination reuses its node until disposed, distinct destinations get
   * independent composites. Assign the result to the composer's output.
   *
   * `AerialPerspectiveNode` is accepted because ADR-001 wires the takram aerial
   * node into this call, and that class extends an untyped `TempNode`, so it is
   * assignable to NEITHER `Node<'vec4'>` nor `Node`: its `setup()` return is
   * incompatible with Three.js Node declarations. Every consumer had to cast
   * at the call site to pass the node the docs tell them to pass.
   *
   * Ownership: dispose a composite to release its destination, or dispose the pass
   */
  composite(dst: Node<'vec4'> | AerialPerspectiveNode): CloudsCompositeNode {
    const cached = this.compositeNodes.get(dst)
    if (cached != null) return cached
    const composite = new CloudsCompositeNode(this, dst)
    const release = (): void => {
      this.compositeNodes.delete(dst)
      composite.removeEventListener('dispose', release)
    }
    composite.addEventListener('dispose', release)
    this.compositeNodes.set(dst, composite)
    return composite
  }

  /** Clear the temporal accumulation. Same as `cloudsContext.resetHistory()` */
  resetHistory(): void {
    this.cloudsContext.resetHistory()
  }

  get staticTracker(): StaticModeTracker {
    return this._staticTracker
  }

  /**
   * Release pass-owned targets, materials and effects, not the context's textures
   * Ownership: dispose the context separately after detaching borrowed textures
   */
  override dispose(): void {
    for (const composite of this.compositeNodes.values()) composite.dispose()
    this._staticTracker.reset()
    for (const { node } of this._computeResolve) node.dispose()
    for (const { node } of this._computeShadowResolve) node.dispose()
    if (this._parameterUniforms != null) {
      disposePlaceholders(this._parameterUniforms.placeholders)
    }
    this.layerRT.dispose()
    this.shadowRT?.dispose()
    this.shadowResolveRT?.dispose()
    this.shadowHistoryRT?.dispose()
    this.resolveRT?.dispose()
    this.historyRT?.dispose()
    this.shadowLengthPlaceholder.dispose()
    this._cirrusStreaks?.dispose()
    this._litShadowAtlas?.dispose()
    this.weatherEvolution.dispose()
    this.environment.dispose()
    this.material.dispose()
    this.shadowMaterial.dispose()
    this.shadowResolveMaterial.dispose()
    this.resolveMaterial.dispose()
    this.mesh.geometry.dispose()
    this.shadowMesh.geometry.dispose()
    this.shadowResolveMesh.geometry.dispose()
    this.resolveMesh.geometry.dispose()
    super.dispose()
  }
}

/**
 * Create the cloud pass. The one factory of the package, so
 * `instanceof CloudsPassNode` holds for every cloud graph.
 *
 * ```ts
 * const cloudsPass = clouds({ sceneDepth })
 * cloudsPass.cloudsContext.time = elapsed
 * cloudsPass.cloudsContext.frame = frameIndex
 * ```
 *
 * Nothing is uploaded until the first render: the pass initializes itself, so
 * there is no `initialize()` to call and no size to pass.
 *
 * @remarks
 * Requires: register this pass's context with the renderer before rendering
 * Ownership: the caller must release the pass and its context separately
 */
export const clouds = (options: CloudsOptions): CloudsPassNode =>
  new CloudsPassNode(options)
