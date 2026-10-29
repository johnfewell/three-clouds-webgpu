// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import {
  Matrix3,
  Matrix4,
  Texture,
  Vector2,
  Vector3,
  type Camera,
  type Data3DTexture,
  type PerspectiveCamera
} from 'three'
import type { Renderer, Storage3DTexture } from 'three/webgpu'

import { getAltitudeCorrectionOffset } from '@takram/three-atmosphere'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

import { CameraUniforms } from './CameraUniforms'
import { CloudLayers, layerStructureKey } from './CloudLayers'
import {
  cirrusDeckDefaults,
  type CirrusDeckParams
} from './experimental/cirrusDeck'
import {
  cloudShapeDefaults,
  cloudShapeKey,
  type CloudShapeParams
} from './experimental/cloudShape'
import { CloudTypes } from './experimental/cloudTypeMap'
import {
  convectiveProfileDefaults,
  type ConvectiveProfileParams
} from './experimental/convectiveProfile'
import {
  evolvingWeatherDefaults,
  type EvolvingWeatherParams
} from './experimental/evolvingWeather'
import type { LightningState } from './experimental/lightning'
import { moonlightCPU } from './experimental/moonlight'
import {
  experimentalDefaults,
  type ExperimentalCloudOptions
} from './experimental/options'
import { ProceduralWeather } from './experimental/proceduralWeather'
import {
  rainShaftDefaults,
  type RainShaftParams
} from './experimental/rainShafts'
import type { QualityGovernor } from './QualityGovernor'
import {
  applyQualityPreset,
  defaults,
  getAppliedQualityPreset,
  type CloudsPresetFields,
  type QualityPreset,
  type QualityPresetTarget,
  type ShadowPresetFields
} from './qualityPresets'
import { PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION } from './referenceMode'
import {
  getSunDistanceFudge,
  type CascadedShadowMaps,
  type FrustumSplitMode
} from './shadow/CascadedShadowMaps'
import { createJitterTexture } from './textures/loadBakedCloudTextures'
import type { ProceduralTextureLike } from './textures/ProceduralTexture'

const _vec3 = new Vector3()
const _vec3b = new Vector3()
// moonlightCPU writes here, so the per-frame callers allocate nothing
const moonlightOut = {
  lightDirection: new Vector3(),
  irradianceRatio: new Vector3()
}
const _mat3a = new Matrix3()
const _geodetic = new Geodetic()

const SPLIT_MODE_NAMES: readonly FrustumSplitMode[] = [
  'uniform',
  'logarithmic',
  'practical'
]

/**
 * Which diagnostic view the resolve pass writes, or `'none'` for the shaded
 * image. A change rebuilds the graph.
 */
export type DebugView =
  | 'none'
  | 'cascades'
  | 'shadowMap'
  | 'uv'
  | 'sampleCount'
  | 'frontDepth'
  | 'shadowLength'
  | 'velocity'
  | 'marchIntervals'

let contextIdCounter = 0
const CLOUDS_CONTEXT_BRAND = Symbol.for('three-clouds-webgpu.CloudsContext')

/**
 * Every knob of the WebGL `CloudsEffect` under its original name, plus this
 * port's additions. One context belongs to one pass: read it as
 * `cloudsPass.cloudsContext`.
 *
 * Most properties are plain numbers you may assign per frame. Graph setters
 * ignore unchanged values, but reapplying a preset restores its overrides
 * A property whose documentation says it rebuilds the graph additionally bumps
 * `graphVersion` and clears temporal history, which is why the graph-shape
 * fields have real setters instead of being plain public fields.
 *
 * @remarks
 * Units: world distances are metres and time is seconds, not an internal clock
 * Requires: register this pass's context as the renderer's getClouds provider
 * Ownership: dispose() releases assigned textures, including borrowed ones
 * Detach borrowed slots before disposal and release the pass separately
 */
export class CloudsContext implements QualityPresetTarget {
  /** Creation order, for telling two contexts apart in a log */
  readonly id = contextIdCounter++

  // Scene-camera uniforms (explicit TSL uniform nodes, NOT the TSL camera builtins)

  /**
   * The camera uniforms the pass binds itself. Fullscreen passes never use the
   * TSL camera builtins, so the scene camera is bound here by
   * {@link updateCamera}.
   */
  readonly cameraUniforms = new CameraUniforms()

  // Cloud layers (CloudLayers extends Array<CloudLayer> of 4)

  /**
   * The four cloud layers, as a fixed four-element array, with heights in
   * metres. Structural changes, such as activating an empty layer, rebuild the
   * graph through {@link checkLayerStructure}. Numeric magnitudes are uniforms
   */
  readonly cloudLayers = CloudLayers.DEFAULT.clone()

  // Texture repeat / offset / velocity, as mutable instances

  /**
   * How often each texture tiles across the sky, per unit of its offset space.
   * Larger numbers mean finer detail. A change mid-flight is a domain change,
   * which is one of the things `windReprojection` rejects history for.
   */
  readonly localWeatherRepeat = new Vector2().setScalar(100)
  readonly shapeRepeat = new Vector3().setScalar(0.0003)
  readonly shapeDetailRepeat = new Vector3().setScalar(0.006)
  readonly turbulenceRepeat = new Vector2().setScalar(20)

  /**
   * The base sampling offset of each texture. Combined with its velocity and
   * `time` into the `derived*` offsets, which is what the shader reads.
   */
  readonly localWeatherOffset = new Vector2()
  readonly shapeOffset = new Vector3()
  readonly shapeDetailOffset = new Vector3()

  /**
   * Wind, in offset units per second. This is the advection the clouds move by,
   * so it is also what `windReprojection` reprojects against.
   */
  readonly localWeatherVelocity = new Vector2()
  readonly shapeVelocity = new Vector3()
  readonly shapeDetailVelocity = new Vector3()

  // Derived offsets: base + velocity × time (seek-safe, no accumulation)

  /** What the shader reads: the base offset plus velocity times `time` */
  readonly derivedLocalWeatherOffset = new Vector2()
  readonly derivedShapeOffset = new Vector3()
  readonly derivedShapeDetailOffset = new Vector3()

  // Texture slots, each a plain texture or a procedural generator, as the
  // reference's accessor pair (CloudsEffect.ts:518-580). The getter returns
  // whichever was set, and uniforms read the `resolved*` getters

  // Two properties per slot because a generator must also be driven (render()
  // each update), and a baked texture has nothing to drive
  private _localWeatherTexture: Texture | null = null
  private _shapeTexture: Data3DTexture | Storage3DTexture | null = null
  private _shapeDetailTexture: Data3DTexture | Storage3DTexture | null = null
  private _turbulenceTexture: Texture | null = null

  private _proceduralLocalWeather: ProceduralTextureLike | null = null
  private _proceduralShape: ProceduralTextureLike<Storage3DTexture> | null =
    null
  private _proceduralShapeDetail: ProceduralTextureLike<Storage3DTexture> | null =
    null
  private _proceduralTurbulence: ProceduralTextureLike | null = null

  /**
   * The local weather map, or the generator that draws it. The getter returns
   * whichever was set, so a procedural texture has to be driven each frame
   * through {@link renderProceduralTextures}. The `resolved*` getters are what
   * the uniforms bind.
   */
  get localWeatherTexture(): Texture | ProceduralTextureLike | null {
    return this._proceduralLocalWeather ?? this._localWeatherTexture
  }

  set localWeatherTexture(value: Texture | ProceduralTextureLike | null) {
    if (value == null || value instanceof Texture) {
      this._proceduralLocalWeather = null
      this._localWeatherTexture = value
    } else {
      this._proceduralLocalWeather = value
      this._localWeatherTexture = value.texture
    }
  }

  /**
   * The base 3D shape volume, or its generator. Same pairing as
   * {@link localWeatherTexture}.
   */
  get shapeTexture():
    | Data3DTexture
    | Storage3DTexture
    | ProceduralTextureLike<Storage3DTexture>
    | null {
    return this._proceduralShape ?? this._shapeTexture
  }

  set shapeTexture(
    value:
      | Data3DTexture
      | Storage3DTexture
      | ProceduralTextureLike<Storage3DTexture>
      | null
  ) {
    if (value == null || value instanceof Texture) {
      this._proceduralShape = null
      this._shapeTexture = value
    } else {
      this._proceduralShape = value
      this._shapeTexture = value.texture
    }
  }

  /**
   * The high-frequency 3D detail volume, or its generator. Only sampled when
   * {@link shapeDetail} is on.
   */
  get shapeDetailTexture():
    | Data3DTexture
    | Storage3DTexture
    | ProceduralTextureLike<Storage3DTexture>
    | null {
    return this._proceduralShapeDetail ?? this._shapeDetailTexture
  }

  set shapeDetailTexture(
    value:
      | Data3DTexture
      | Storage3DTexture
      | ProceduralTextureLike<Storage3DTexture>
      | null
  ) {
    if (value == null || value instanceof Texture) {
      this._proceduralShapeDetail = null
      this._shapeDetailTexture = value
    } else {
      this._proceduralShapeDetail = value
      this._shapeDetailTexture = value.texture
    }
  }

  /**
   * The 2D curl noise the shape noise is displaced by, or its generator. Only
   * sampled when {@link turbulence} is on.
   */
  get turbulenceTexture(): Texture | ProceduralTextureLike | null {
    return this._proceduralTurbulence ?? this._turbulenceTexture
  }

  set turbulenceTexture(value: Texture | ProceduralTextureLike | null) {
    if (value == null || value instanceof Texture) {
      this._proceduralTurbulence = null
      this._turbulenceTexture = value
    } else {
      this._proceduralTurbulence = value
      this._turbulenceTexture = value.texture
    }
  }

  // What the uniforms bind. Always the plain texture, never the generator.

  /** The plain texture behind {@link localWeatherTexture}, generator or not */
  get resolvedLocalWeatherTexture(): Texture | null {
    return this._localWeatherTexture
  }
  /** The plain texture behind {@link shapeTexture}, generator or not */
  get resolvedShapeTexture(): Data3DTexture | Storage3DTexture | null {
    return this._shapeTexture
  }
  /** The plain texture behind {@link shapeDetailTexture}, generator or not */
  get resolvedShapeDetailTexture(): Data3DTexture | Storage3DTexture | null {
    return this._shapeDetailTexture
  }
  /** The plain texture behind {@link turbulenceTexture}, generator or not */
  get resolvedTurbulenceTexture(): Texture | null {
    return this._turbulenceTexture
  }

  /**
   * Fill any procedural texture that still needs it. Each generator clears its
   * own needsRender, so calling this every frame is cheap, as the reference
   * does (CloudsEffect.ts:473-476). Returns whether any generator re-filled
   */
  renderProceduralTextures(renderer: Renderer): boolean {
    let filled = false
    for (const generator of [
      this._proceduralLocalWeather,
      this._proceduralShape,
      this._proceduralShapeDetail,
      this._proceduralTurbulence
    ]) {
      if (generator == null) continue
      filled ||= generator.needsRender
      generator.render(renderer)
    }
    return filled
  }

  // STBN texture, lazily created via createJitterTexture
  private _stbnTexture: Data3DTexture | null = null
  private readonly generatedStbnTextures = new Set<Data3DTexture>()

  /**
   * The spatial-temporal blue-noise volume the march jitters with, built on
   * first read. Assign your own to sample NVIDIA's STBN as the original does.
   */
  get stbnTexture(): Data3DTexture {
    if (this._stbnTexture == null) {
      this._stbnTexture = createJitterTexture()
      this.generatedStbnTextures.add(this._stbnTexture)
    }
    return this._stbnTexture
  }

  /** The cached jitter volume, without triggering its lazy generation */
  get resolvedStbnTexture(): Data3DTexture | null {
    return this._stbnTexture
  }

  /** Assign `null` to fall back to the generated volume again */
  set stbnTexture(value: Data3DTexture | null) {
    this._stbnTexture = value
  }

  // Participating medium

  /**
   * How much of the weather map becomes cloud. 0 is clear sky, 1 overcast
   * Domain: normally [0, 1], assignment is not validated or clamped
   * Mutation: a per-frame uniform, with no graph rebuild
   */
  coverage = 0.3

  /** Scattering coefficient of the participating medium */
  scatteringCoefficient = 1

  /** Absorption coefficient of the participating medium */
  absorptionCoefficient = 0

  /** How far the turbulence noise displaces the shape noise, in metres */
  turbulenceDisplacement = 350

  // Scattering

  /** Multiplier on the sky's contribution to cloud lighting */
  skyLightScale = 1

  /**
   * Multiplier on light bounced off the ground into cloud bases. 0 turns ground
   * bounce off, which also removes the ground march.
   */
  groundBounceScale = 1

  /** Strength of the powder darkening in dense, shadowed cloud */
  powderScale = 0.8

  /** Height falloff of that powder darkening */
  powderExponent = 150

  // Phase function: graph-time constants, as the reference's @defineFloat
  // SCATTER_ANISOTROPY_* ("defining them as macros improves fps",
  // CloudsMaterial.ts:470–481)

  // As uniforms they could not fold and the octaves cost 5.7 ms against the
  // reference's 0.4 at 2880×1800. As literals they
  // fold as the reference's do
  private _scatterAnisotropy1 = 0.7
  get scatterAnisotropy1(): number {
    return this._scatterAnisotropy1
  }

  set scatterAnisotropy1(v: number) {
    if (this._scatterAnisotropy1 !== v) {
      this._scatterAnisotropy1 = v
      this._graphVersion++
    }
  }

  private _scatterAnisotropy2 = -0.2
  get scatterAnisotropy2(): number {
    return this._scatterAnisotropy2
  }

  set scatterAnisotropy2(v: number) {
    if (this._scatterAnisotropy2 !== v) {
      this._scatterAnisotropy2 = v
      this._graphVersion++
    }
  }

  private _scatterAnisotropyMix = 0.5
  get scatterAnisotropyMix(): number {
    return this._scatterAnisotropyMix
  }

  set scatterAnisotropyMix(v: number) {
    if (this._scatterAnisotropyMix !== v) {
      this._scatterAnisotropyMix = v
      this._graphVersion++
    }
  }

  // Feature toggles

  /** March resolution as a fraction of the frame. Below 1 costs quality */
  resolutionScale = defaults.resolutionScale

  // The convective profile's shape knobs. A plain field, not a setter: they
  // feed uniforms written every frame, so a change costs no graph rebuild
  // Read them only when experimental.convectiveProfile is on
  convectiveProfile: ConvectiveProfileParams = {
    ...convectiveProfileDefaults
  }

  // The rain shafts' shape knobs, same deal: a plain field feeding uniforms
  // written every frame, so a change costs no graph rebuild
  // Read them only when experimental.rainShafts is on
  rainShafts: RainShaftParams = {
    ...rainShaftDefaults
  }

  // The cirrus deck's knobs, the same kind of plain field. `texture` is the
  // one object in it: set your own and the pass reads it on the next frame
  // Read them only when experimental.cirrusDeck is on
  cirrusDeck: CirrusDeckParams = {
    ...cirrusDeckDefaults
  }

  // Evolving weather's knobs in metres and seconds, the same kind of plain
  // field, read by the pass every frame. The evolution follows `time`
  // Read them only when experimental.evolvingWeather is on
  evolvingWeather: EvolvingWeatherParams = {
    ...evolvingWeatherDefaults
  }
  /**
   * The opt-in shape controls: a darker base, a horizon coverage bank, a wind
   * shear and one rounded-to-wispy edge knob. A plain field, like
   * {@link convectiveProfile}, because every magnitude is a graph-time literal
   * (src/experimental/cloudShape.ts). Neutral is all zeros, so an untouched
   * context reads as the reference.
   *
   * `checkCloudShape` polls it, which the pass calls each frame itself
   */
  cloudShape: CloudShapeParams = { ...cloudShapeDefaults }

  /**
   * The lightning flash lighting the cloud from inside, or `null` for none. A
   * plain field, not a setter: its parts feed uniforms written every frame, so a
   * flash costs no graph rebuild. Read it only when experimental.lightning is on.
   *
   * `position` is ECEF metres and belongs inside the cloud volume. `intensity`
   * is 0 whenever no flash is lit. Never reads a clock: the consumer decides
   * when a flash is, and when its envelope has decayed.
   */
  lightning: LightningState | null = null

  private _experimental = experimentalDefaults

  /** Regional cloud-type controls, used when `experimental.cloudTypeMap` is on */
  readonly cloudTypes = new CloudTypes()

  /**
   * Renderer experiments. `cloudFrontRefinement` and `distantShapeDetailFade`
   * default to true, all others to false. See docs/EXPERIMENTAL.md
   *
   * Assign a partial object to preserve other options. Unknown keys and
   * non-boolean values throw. Changes rebuild the graph and reset history
   */
  get experimental(): Readonly<ExperimentalCloudOptions> {
    return this._experimental
  }

  set experimental(options: Partial<ExperimentalCloudOptions>) {
    const next = { ...this._experimental }
    for (const key of Object.keys(
      options
    ) as (keyof ExperimentalCloudOptions)[]) {
      if (
        !Object.hasOwn(experimentalDefaults, key) ||
        typeof options[key] !== 'boolean'
      ) {
        throw new TypeError(`Invalid experimental cloud option: ${key}`)
      }
      next[key] = options[key]
    }
    if (
      Object.keys(next).some(
        key =>
          next[key as keyof typeof next] !==
          this._experimental[key as keyof typeof next]
      )
    ) {
      this._experimental = Object.freeze(next)
      this._graphVersion++
      this.resetHistory()
      this.syncProceduralWeather()
    }
  }

  // The opt-in builds the generator and nothing else does, so the default
  // weather map stays the baked PNG. A texture the caller set always wins, and
  // turning the flag off disposes only what the flag installed
  private _proceduralWeather: ProceduralWeather | null = null

  private syncProceduralWeather(): void {
    if (this._experimental.proceduralWeather) {
      if (this.localWeatherTexture != null) return
      this._proceduralWeather = new ProceduralWeather()
      this.localWeatherTexture = this._proceduralWeather
      return
    }
    const installed = this._proceduralWeather
    if (installed == null) return
    this._proceduralWeather = null
    // Only the slot the flag filled. A texture the caller set after the flag
    // went on is theirs, and clearing it would take their map away
    if (this._proceduralLocalWeather === installed) {
      this.localWeatherTexture = null
    }
    installed.dispose()
  }

  /**
   * The generator the flag installed, or null. Read-only on purpose: the
   * pattern and octave counts are graph time, so changing them means building
   * your own and assigning it to `localWeatherTexture`
   */
  get proceduralWeather(): ProceduralWeather | null {
    return this._proceduralWeather
  }

  private _lightShafts = defaults.lightShafts

  /** Whether cloud shadow length is marched and read by the aerial consumers */
  get lightShafts(): boolean {
    return this._lightShafts
  }

  set lightShafts(v: boolean) {
    if (this._lightShafts !== v) {
      this._lightShafts = v
      this._graphVersion++
      this.resetHistory()
    }
  }

  // Not a quality-preset value: a WebGPU method with no reference counterpart:
  // the shaft march runs once per 2x2 quad, each lane taking every fourth
  // sample (createMarchShadowLengthQuadPartial), a 2x2 box filter at 1/4 cost

  // Needs `subgroups`, else the march runs per fragment. On by default, and NOT
  // bitwise equal to the reference: dE P95 0.056-0.071 against a 2-3x inert floor,
  // about 8% of a shaft case's own A-vs-B dE mean, invisible at DPR 1
  private _lightShaftsHalfResolution = PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION

  /**
   * Whether the shaft march runs once per 2x2 quad rather than per fragment.
   * Needs the `subgroups` feature, on by default. Measured, not identical: dE P95
   * 0.056-0.071 (2-3x the inert floor, ~8% of the case's A-vs-B mean), not
   * visible at DPR 1, and 7.2-20.0 ms per frame at 1280x720 on the shaft cases.
   */
  get lightShaftsHalfResolution(): boolean {
    return this._lightShaftsHalfResolution
  }

  set lightShaftsHalfResolution(v: boolean) {
    if (this._lightShaftsHalfResolution !== v) {
      this._lightShaftsHalfResolution = v
      this._graphVersion++
      this.resetHistory()
    }
  }

  private _haze = defaults.haze

  /** Whether the haze layer is marched alongside the clouds */
  get haze(): boolean {
    return this._haze
  }

  set haze(v: boolean) {
    if (this._haze !== v) {
      this._haze = v
      this._graphVersion++
    }
  }

  // Cite: CloudsPass.ts:257–266 (setter resizes march target + invalidates history)
  private _temporalUpscale = true

  /**
   * Whether the resolve runs at the march resolution and upscales (Bayer,
   * `true`) or at the frame resolution (full-resolution TAA, `false`). The
   * temporal accumulation runs either way. `true` is cheaper and softer,
   * `false` is sharper and costs more.
   */
  get temporalUpscale(): boolean {
    return this._temporalUpscale
  }

  set temporalUpscale(v: boolean) {
    if (this._temporalUpscale !== v) {
      this._temporalUpscale = v
      this._graphVersion++
      this.resetHistory()
    }
  }

  // Graph-shape-changing boolean toggles, whose setters bump graphVersion
  private _shapeDetail = defaults.shapeDetail

  /**
   * Whether the high-frequency detail volume contributes at all. Off is
   * cheaper and smoother at distance, and every layer's `shapeDetailAmount`
   * stops mattering.
   */
  get shapeDetail(): boolean {
    return this._shapeDetail
  }

  set shapeDetail(v: boolean) {
    if (this._shapeDetail !== v) {
      this._shapeDetail = v
      this._graphVersion++
    }
  }

  private _turbulence = defaults.turbulence

  /** Whether the curl noise displaces the shape noise */
  get turbulence(): boolean {
    return this._turbulence
  }

  set turbulence(v: boolean) {
    if (this._turbulence !== v) {
      this._turbulence = v
      this._graphVersion++
    }
  }

  private _debug: DebugView = 'none'

  /**
   * The diagnostic view the resolve writes, or `'none'` for the shaded image
   */
  get debug(): DebugView {
    return this._debug
  }

  set debug(v: DebugView) {
    if (this._debug !== v) {
      this._debug = v
      this._graphVersion++
    }
  }

  // clouds / shadow shorthand objects, the same shape as qualityPresets

  /**
   * The march-side preset fields. Writing here configures this instance;
   * material parameters use the same setters as their top-level counterparts.
   */
  readonly clouds: CloudsPresetFields = Object.defineProperties(
    { ...defaults.clouds },
    {
      multiScatteringOctaves: {
        get: () => this.multiScatteringOctaves,
        set: (value: number) => {
          this.multiScatteringOctaves = value
        }
      },
      accurateSunSkyLight: {
        get: () => this.accurateSunSkyLight,
        set: (value: boolean) => {
          this.accurateSunSkyLight = value
        }
      },
      accuratePhaseFunction: {
        get: () => this.accuratePhaseFunction,
        set: (value: boolean) => {
          this.accuratePhaseFunction = value
        }
      }
    }
  )

  /** The shadow-side preset fields, flattened the same way */
  readonly shadow: ShadowPresetFields = {
    ...defaults.shadow,
    mapSize: defaults.shadow.mapSize.clone()
  }

  // Shadow cascade maps, created with splitLambda 0.6 (CloudsEffect.ts:250–254)

  /**
   * The cascaded shadow maps, created by the pass. A caller may replace or
   * dispose it, but {@link syncShadowMaps} writes the split settings back into
   * whatever is here every frame, so `shadow.*` stays the only place to set
   * them.
   */
  shadowMaps: CascadedShadowMaps | null = null

  // Atmosphere aliases (lazy-bound)

  /** World space to ECEF. Set this once for your scene's coordinate frame */
  readonly worldToECEFMatrix = new Matrix4()

  /** Inverse of {@link worldToECEFMatrix}, from {@link updateCamera} */
  readonly ecefToWorldMatrix = new Matrix4()

  /** The offset that puts the camera on the ellipsoid, from updateCamera */
  readonly altitudeCorrection = new Vector3()

  /**
   * Normalized ECEF sun direction. The zero default is not a usable sun
   * Requires: synchronize atmosphere and shadow consumers with the same sun
   * Mutation: copy components into this vector before rendering
   */
  readonly sunDirection = new Vector3()

  /** The ellipsoid the projection and altitude correction assume */
  ellipsoid: Ellipsoid = Ellipsoid.WGS84

  /** Sun angular radius in radians, which the sun disc and penumbra use */
  sunAngularRadius = 0.004675

  // Moonlight, read only when experimental.moonlight is on. Same frame as
  // sunDirection, and the app's own clock decides where it points

  /** Normalized ECEF moon direction, required when experimental.moonlight is on */
  readonly moonDirection = new Vector3()

  /**
   * Artistry over the physical moon-to-sun irradiance ratio, which is 2.5e-6
   * at full moon and far below what a fixed exposure shows
   */
  moonGain = 1

  /** The colour the moonlight carries, usually cooler than the sun's */
  readonly moonColor = new Vector3(1, 1, 1)

  /**
   * The march's light direction: the sun's, or the moon's once twilight has
   * faded the sun out. Written by {@link updateMoonlight}
   */
  readonly lightDirection = new Vector3()

  /**
   * The moon's irradiance as a fraction of the sun's, in {@link moonColor}.
   * Written by {@link updateMoonlight}
   */
  readonly moonIrradianceRatio = new Vector3()

  /** Radius at which a ray is treated as hitting the surface, in metres */
  bottomRadius = 6360000

  /** Whether {@link updateCamera} applies the altitude correction offset */
  correctAltitude = true

  /** Camera height above the ellipsoid, in metres, from {@link updateCamera} */
  cameraHeight = 0

  // Frame state

  /**
   * Seconds of cloud motion to show. This is a pure function input, not a
   * clock: set it from your own and never let the library advance it. Wind is
   * derived from it as base offset plus velocity times `time`.
   */
  time = 0

  /**
   * Which frame this is. Must advance every frame while `temporalUpscale` is
   * on, or the resolve reprojects against stale history. See the `time` and
   * `frame` contract in WEBGPU.md.
   * Domain: an integer sample index supplied once per rendered frame
   */
  frame = 0

  /** Whether the context may warn on the console, a stale frame for example */
  warnings = true

  // Cite: AUDIT-3 (enabled false→true calls resetHistory internally)
  private _enabled = true

  /**
   * Whether the pass marches at all. `false` compiles the composite to a
   * pass-through, so it rebuilds the graph and, when turned back on, clears
   * history. The supported switch, where the dropped `skipRendering` is not.
   */
  get enabled(): boolean {
    return this._enabled
  }

  // `enabled` is a graph-shape flag: ADR-003 compiles composite() to a
  // pass-through without the march, so a toggle must bump graphVersion. It
  // once did not, and the frame never changed
  set enabled(v: boolean) {
    if (this._enabled === v) {
      return
    }
    const wasDisabled = !this._enabled
    this._enabled = v
    this._graphVersion++
    if (wasDisabled && v) {
      this.resetHistory()
    }
  }

  // Cite: CloudsMaterial.ts:273–284 (derived from renderer at render time)
  private _logarithmicDepthBuffer = false

  /**
   * Whether `sceneDepth` is a logarithmic depth buffer, which the scene ray
   * distance must undo. Set it to match the renderer.
   */
  get logarithmicDepthBuffer(): boolean {
    return this._logarithmicDepthBuffer
  }

  set logarithmicDepthBuffer(v: boolean) {
    if (this._logarithmicDepthBuffer !== v) {
      this._logarithmicDepthBuffer = v
      this._graphVersion++
    }
  }

  // Graph version, incremented when the TSL graph shape changes
  private _graphVersion = 0
  private _lastLocalWeatherChannels = ''

  /**
   * How many times the graph shape has changed. The pass folds this into its
   * cache key, so a rebuilt node is a different program. Watch it to know when
   * a rebuild happened.
   */
  get graphVersion(): number {
    return this._graphVersion
  }

  // The layer set's graph-time shape (CloudLayers.structure), polled like the
  // weather channels and seeded from the layers so an untouched context
  // reports no change on its first poll
  private _prevLayerStructure = layerStructureKey(this.cloudLayers.structure)

  /**
   * Poll the layer set's graph-time shape and rebuild if it moved. Returns
   * whether it did. The pass calls this itself each frame, so an application
   * only needs it when it changes a layer outside its own render loop.
   */
  checkLayerStructure(): boolean {
    const current = layerStructureKey(this.cloudLayers.structure)
    if (current !== this._prevLayerStructure) {
      this._prevLayerStructure = current
      this._graphVersion++
      return true
    }
    return false
  }

  // The shape controls are plain fields, so their graph-time state is polled
  // like the layer structure. Seeded from them, so an untouched context reports
  // no change on its first poll
  private _prevCloudShape = cloudShapeKey(this.cloudShape)

  /**
   * Poll the four shape controls and rebuild if any moved. Every magnitude is a
   * graph-time literal, so this covers a value changing while its feature is
   * already on, not only the zero crossing.
   */
  checkCloudShape(): boolean {
    const current = cloudShapeKey(this.cloudShape)
    if (current !== this._prevCloudShape) {
      this._prevCloudShape = current
      this._graphVersion++
      this.resetHistory()
      return true
    }
    return false
  }

  /**
   * Poll which weather channels the four layers read and rebuild if that
   * changed, since the channel swizzle is compiled in
   */
  checkLocalWeatherChannels(): boolean {
    const current = this.cloudLayers.localWeatherChannels
    if (current !== this._lastLocalWeatherChannels) {
      this._lastLocalWeatherChannels = current
      this._graphVersion++
      return true
    }
    return false
  }

  // CloudLayer.shadow is a plain property with no owner to notify, so it is
  // polled like checkLocalWeatherChannels. Seeded from the layers,
  // since CloudLayers.DEFAULT casts shadows on two of its four layers
  private _prevCastsShadow = this.cloudLayers.castsShadow

  private _prevShadowCascadeCount = defaults.shadow.cascadeCount
  private _prevShadowTemporalJitter = defaults.shadow.temporalJitter
  private _prevShadowTemporalPass = defaults.shadow.temporalPass

  /**
   * Poll the shadow fields that are compiled rather than uniform, and clear
   * history if any moved. {@link syncShadowMaps} covers the rest of
   * `shadow.*`.
   */
  checkShadowStructure(): boolean {
    let changed = false
    if (this.shadow.cascadeCount !== this._prevShadowCascadeCount) {
      this._prevShadowCascadeCount = this.shadow.cascadeCount
      changed = true
    }
    if (this.shadow.temporalJitter !== this._prevShadowTemporalJitter) {
      this._prevShadowTemporalJitter = this.shadow.temporalJitter
      changed = true
    }
    if (this.shadow.temporalPass !== this._prevShadowTemporalPass) {
      this._prevShadowTemporalPass = this.shadow.temporalPass
      changed = true
    }
    if (this.cloudLayers.castsShadow !== this._prevCastsShadow) {
      this._prevCastsShadow = this.cloudLayers.castsShadow
      changed = true
    }
    if (changed) {
      this._graphVersion++
      this.resetHistory()
    }
    return changed
  }

  /**
   * Copy `shadow.splitLambda`, `shadow.splitMode`, `shadow.maxFar`,
   * `shadow.farScale`, `shadow.cascadeCount` and `shadow.mapSize` into
   * {@link shadowMaps}. The pass calls this once per shadow pass, so the
   * `shadow.*` fields are the only place those values need to be set.
   */
  syncShadowMaps(): void {
    if (this.shadowMaps == null) return
    this.shadowMaps.splitLambda = this.shadow.splitLambda
    this.shadowMaps.splitMode =
      SPLIT_MODE_NAMES[this.shadow.splitMode] ?? 'practical'
    this.shadowMaps.maxFar = this.shadow.maxFar
    this.shadowMaps.farScale = this.shadow.farScale
    this.shadowMaps.cascadeCount = this.shadow.cascadeCount
    if (!this.shadowMaps.mapSize.equals(this.shadow.mapSize)) {
      this.shadowMaps.mapSize.copy(this.shadow.mapSize)
    }
  }

  /**
   * Weather is a pure function of `time`. Set `time` from your own clock.
   * Computes derived offsets: base + velocity × time. Call once per frame
   * before the march pass reads the offset uniforms.
   */
  updateOffsets(): void {
    this.derivedLocalWeatherOffset
      .copy(this.localWeatherOffset)
      .addScaledVector(this.localWeatherVelocity, this.time)
    this.derivedShapeOffset
      .copy(this.shapeOffset)
      .addScaledVector(this.shapeVelocity, this.time)
    this.derivedShapeDetailOffset
      .copy(this.shapeDetailOffset)
      .addScaledVector(this.shapeDetailVelocity, this.time)
  }

  /**
   * Per-frame camera update: ECEF transform, altitude correction, cameraHeight.
   * Call once per frame before the march pass. Mirrors
   * CloudsEffect.updateSharedUniforms() and CloudsMaterial.copyCameraSettings()
   * from the reference.
   */
  updateCamera(camera: Camera): void {
    this.ecefToWorldMatrix.copy(this.worldToECEFMatrix).invert()

    const cameraPositionECEF = camera
      .getWorldPosition(_vec3)
      .applyMatrix4(this.worldToECEFMatrix)

    if (this.correctAltitude) {
      getAltitudeCorrectionOffset(
        cameraPositionECEF,
        this.bottomRadius,
        this.ellipsoid,
        this.altitudeCorrection
      )
    } else {
      this.altitudeCorrection.setScalar(0)
    }

    try {
      this.cameraHeight = _geodetic.setFromECEF(cameraPositionECEF).height
    } catch {
      // Unable to project position to the ellipsoid surface, keep previous value
    }
  }

  /**
   * Retargets {@link lightDirection} and {@link moonIrradianceRatio} for the
   * frame. Idempotent and cheap, so every per-frame caller may run it: with
   * the option off it copies the sun's direction and leaves the ratio zero,
   * which is the reference's light
   */
  updateMoonlight(): void {
    moonlightCPU(
      this.sunDirection,
      this.moonDirection,
      this.cameraUniforms.cameraPositionECEF.value,
      this.experimental.moonlight ? this.moonGain : 0,
      this.moonColor,
      moonlightOut
    )
    this.lightDirection.copy(moonlightOut.lightDirection)
    this.moonIrradianceRatio.copy(moonlightOut.irradianceRatio)
  }

  // Cite: CloudsEffect.ts:380–396
  updateShadowMaps(camera: Camera): void {
    // This runs before the uniform sync, so the light it reads would otherwise
    // be the previous frame's. Idempotent, so the sync recomputing it is free
    this.updateMoonlight()
    if (this.shadowMaps == null) return

    const cameraPositionECEF = _vec3
      .copy(camera.getWorldPosition(_vec3b))
      .applyMatrix4(this.worldToECEFMatrix)

    const surfaceNormal = this.ellipsoid.getSurfaceNormal(
      cameraPositionECEF,
      _vec3b
    )
    // The cascades fit the light the march shadows along, so they follow the
    // moon once twilight has handed the light over
    const lightDirection =
      this.lightDirection.lengthSq() > 0
        ? this.lightDirection
        : this.sunDirection
    const distance = getSunDistanceFudge(lightDirection, surfaceNormal)

    // Rotation only, as CloudsEffect.ts:389-395 applies it with applyMatrix3:
    // applyMatrix4's translation turned the sun toward the anchor in any frame
    // not centred on the earth, which no ladder case has
    _mat3a.setFromMatrix4(this.ecefToWorldMatrix)
    const sunDirectionWorld = _vec3b
      .copy(lightDirection)
      .applyMatrix3(_mat3a)
      .normalize()

    this.shadowMaps.update(
      camera as PerspectiveCamera,
      sunDirectionWorld,
      distance
    )
  }

  // Cite: CloudsMaterial.ts:297–299 (intended condition, not the source bug)
  private _prevGroundBounce =
    this.groundBounceScale > 0 && this.clouds.maxIterationCountToGround > 0

  /**
   * Whether the ground-bounce march runs, which needs
   * {@link groundBounceScale} positive and `clouds.maxIterationCountToGround`
   * above zero. Polled by {@link checkGroundBounce}.
   */
  get groundBounce(): boolean {
    return (
      this.groundBounceScale > 0 && this.clouds.maxIterationCountToGround > 0
    )
  }

  /** Rebuild if {@link groundBounce} flipped, since it changes the march */
  checkGroundBounce(): boolean {
    const current = this.groundBounce
    if (current !== this._prevGroundBounce) {
      this._prevGroundBounce = current
      this._graphVersion++
      return true
    }
    return false
  }

  /**
   * Every graph-shape fact as one plain object, which is what
   * {@link CloudsPassNode.customCacheKey} hashes. Useful to a caller that wants
   * to know whether a change is a uniform write or a rebuild.
   */
  graphFlags(): {
    shapeDetail: boolean
    turbulence: boolean
    lightShafts: boolean
    lightShaftsHalfResolution: boolean
    haze: boolean
    temporalUpscale: boolean
    accurateSunSkyLight: boolean
    accuratePhaseFunction: boolean
    multiScatteringOctaves: number
    scatterAnisotropy1: number
    scatterAnisotropy2: number
    scatterAnisotropyMix: number
    localWeatherChannels: string
    layerStructure: string
    shadowCascadeCount: number
    shadowTemporalJitter: boolean
    shadowTemporalPass: boolean
    castsShadow: boolean
    groundBounce: boolean
    logarithmicDepthBuffer: boolean
    debug: DebugView
    experimentalFlags: number
    cloudShape: string
  } {
    return {
      shapeDetail: this.shapeDetail,
      turbulence: this.turbulence,
      lightShafts: this.lightShafts,
      lightShaftsHalfResolution: this.lightShaftsHalfResolution,
      haze: this.haze,
      temporalUpscale: this.temporalUpscale,
      accurateSunSkyLight: this.accurateSunSkyLight,
      accuratePhaseFunction: this.accuratePhaseFunction,
      multiScatteringOctaves: this.multiScatteringOctaves,
      scatterAnisotropy1: this.scatterAnisotropy1,
      scatterAnisotropy2: this.scatterAnisotropy2,
      scatterAnisotropyMix: this.scatterAnisotropyMix,
      localWeatherChannels: this.cloudLayers.localWeatherChannels,
      layerStructure: layerStructureKey(this.cloudLayers.structure),
      shadowCascadeCount: this.shadow.cascadeCount,
      shadowTemporalJitter: this.shadow.temporalJitter,
      shadowTemporalPass: this.shadow.temporalPass,
      // the Beer-shadow-map branch is gated on this, so it is in the
      // cache key too. graphVersion alone only sets needsUpdate, and three can
      // serve the old program if the key does not move
      castsShadow: this.cloudLayers.castsShadow,
      groundBounce: this.groundBounce,
      logarithmicDepthBuffer: this.logarithmicDepthBuffer,
      debug: this.debug,
      experimentalFlags: Object.values(this.experimental).reduce(
        (bits, enabled, index) => bits | (Number(enabled) << index),
        0
      ),
      cloudShape: cloudShapeKey(this.cloudShape)
    }
  }

  /**
   * The last preset applied. The setter writes every field that preset names,
   * so assigning a preset is the way to switch quality rather than copying
   * fields yourself. Explicit overrides leave this name unchanged, and applying
   * the same preset again restores its values. Unknown names throw `RangeError`.
   * Mutation: changed graph fields rebuild, equal values preserve graph/history
   */
  get qualityPreset(): QualityPreset {
    return getAppliedQualityPreset(this) ?? 'high'
  }

  set qualityPreset(name: QualityPreset) {
    applyQualityPreset(this, name)
  }

  /**
   * The auto-quality governor registered by `createQualityGovernor`, or null.
   * Opt-in: nothing steps until the host arms it and feeds frame times.
   * `applyReferenceMode` disarms it, restoring the captured settings.
   */
  qualityGovernor: QualityGovernor | null = null

  // Graph-shape-changing setters, which bump graphVersion
  private _multiScatteringOctaves = defaults.clouds.multiScatteringOctaves

  /** How many octaves of multiple scattering are summed. 0 is single */
  get multiScatteringOctaves(): number {
    return this._multiScatteringOctaves
  }

  set multiScatteringOctaves(v: number) {
    if (this._multiScatteringOctaves !== v) {
      this._multiScatteringOctaves = v
      this._graphVersion++
    }
  }

  private _accurateSunSkyLight = defaults.clouds.accurateSunSkyLight

  /**
   * Whether the ground-bounce irradiance reads the atmosphere LUT per sample
   * (`true`) or a once-per-frame interpolation (`false`). Accurate costs more
   * and changes little.
   */
  get accurateSunSkyLight(): boolean {
    return this._accurateSunSkyLight
  }

  set accurateSunSkyLight(v: boolean) {
    if (this._accurateSunSkyLight !== v) {
      this._accurateSunSkyLight = v
      this._graphVersion++
    }
  }

  private _accuratePhaseFunction = defaults.clouds.accuratePhaseFunction

  /**
   * Whether the phase function uses the accurate approximation (`true`) or the
   * cheaper dual-lobe one (`false`)
   */
  get accuratePhaseFunction(): boolean {
    return this._accuratePhaseFunction
  }

  set accuratePhaseFunction(v: boolean) {
    if (this._accuratePhaseFunction !== v) {
      this._accuratePhaseFunction = v
      this._graphVersion++
    }
  }

  // History reset hook: passes register a callback here
  private _resetHistoryCallback: (() => void) | null = null

  /** Register the pass's history-clearing callback. Called by the pass */
  registerResetHistory(callback: () => void): void {
    this._resetHistoryCallback = callback
  }

  /**
   * Drop the temporal accumulation, so the next frame reads no history. Call
   * it after anything that invalidates the previous frame's image: a jump in
   * position, a swap of the weather textures, or a change to a graph-shape
   * property, which already calls it for you.
   */
  resetHistory(): void {
    this._resetHistoryCallback?.()
  }

  /**
   * Release generated jitter volumes and any texture still assigned here
   * Assigned textures are disposed even when borrowed, so transfer ownership
   * deliberately or detach borrowed slots before calling
   */
  dispose(): void {
    // Dispose whichever form each slot holds: a generator owns its texture, so
    // disposing the resolved texture directly would leak the generator's own
    // handle to it
    ;(this._proceduralLocalWeather ?? this._localWeatherTexture)?.dispose()
    ;(this._proceduralShape ?? this._shapeTexture)?.dispose()
    ;(this._proceduralShapeDetail ?? this._shapeDetailTexture)?.dispose()
    ;(this._proceduralTurbulence ?? this._turbulenceTexture)?.dispose()
    if (this._stbnTexture != null)
      this.generatedStbnTextures.add(this._stbnTexture)
    for (const texture of this.generatedStbnTextures) texture.dispose()
    this.generatedStbnTextures.clear()
    this.localWeatherTexture = null
    this.shapeTexture = null
    this.shapeDetailTexture = null
    this.turbulenceTexture = null
    this._stbnTexture = null
  }
}

Object.defineProperty(CloudsContext.prototype, CLOUDS_CONTEXT_BRAND, {
  value: true
})

const cloudsContextError =
  'getCloudsContext: no CloudsContext in the TSL context. ' +
  'Make sure the clouds pass is added to the scene.'

const duplicateContextError =
  'getCloudsContext: detected two different CloudsContext class instances. ' +
  'This usually means two copies of three-clouds-webgpu are loaded.'

export function isForeignCloudsContext(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    Reflect.get(value, CLOUDS_CONTEXT_BRAND) === true &&
    !(value instanceof CloudsContext)
  )
}

/**
 * Read the {@link CloudsContext} out of a TSL context, for a node that needs
 * the knobs without holding the pass. Throws when the pass is not in the graph,
 * and when two copies of this package are loaded, which is the usual cause of
 * the second message.
 */
export function getCloudsContext(ctx: Record<string, unknown>): CloudsContext {
  const fn = ctx['getClouds']
  if (typeof fn !== 'function') {
    throw new Error(cloudsContextError)
  }
  const result = (fn as () => unknown)()
  if (!(result instanceof CloudsContext)) {
    if (isForeignCloudsContext(result)) {
      throw new Error(duplicateContextError)
    }
    throw new Error(cloudsContextError)
  }
  return result
}
