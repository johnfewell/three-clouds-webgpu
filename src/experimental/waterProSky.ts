// Water Pro (threejs-water-pro 3.5.1) binds its sky through a structural
// interface: https://docs.threejswaterpro.com/guide/custom-sky.html
// The package is commercial and is not a dependency here, so the seam is
// declared as our own types and none of it is vendored. Glue around
// CloudEnvironmentNode, not ported code

import {
  ClampToEdgeWrapping,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  type Camera,
  type Object3D,
  type Texture
} from 'three'
import {
  clamp,
  cos,
  cubeTexture,
  equirectUV,
  float,
  Fn,
  normalize,
  pmremTexture,
  positionGeometry,
  sin,
  texture,
  uniform,
  uv,
  vec3,
  vec4
} from 'three/tsl'
import { NodeMaterial, QuadMesh, RenderTarget, type Node } from 'three/webgpu'

import type { CloudEnvironmentNode } from './cloudEnvironment'

// The renderer's duck type as QuadMesh.render declares it, taken from the
// signature rather than named: three does not export that interface
export type WaterProSkyRenderer = Parameters<QuadMesh['render']>[0]

/**
 * The seam Water Pro's `WaterSystem.setSky` binds a sky provider to, at 3.5.1.
 *
 * Its optional `getBrightnessNode`, `getSun` and `setActive` are deliberately
 * absent, so Water Pro falls back to a brightness of one, keeps its own sun
 * authoritative, and never asks the provider to gate a render.
 */
export interface WaterProSkyProvider {
  createFogSampler(): (direction: Node) => Node

  createReflectionSampler(): (direction: Node, roughness: Node) => Node

  dispose(): void

  followCamera(camera: Camera): void

  getEnvironmentTexture(): Texture

  getMeshes(): Object3D[]
}

type FogSampler = ReturnType<typeof equirectFogSampler>
type ReflectionSampler = ReturnType<typeof equirectReflectionSampler>

export interface WaterProCloudSkyOptions {
  /**
   * Equirectangular width in texels, and half that in height. The default is
   * four times the cube's face size, so a 64 texel cube becomes 256 by 128.
   */
  readonly width: number

  /**
   * Base microfacet roughness added to what the water surface derives from its
   * own waves, in `[0, 1]`, live. Water Pro's own `Sky` defaults to 0.15 and
   * the floor is kept here: the cube this sharpens is 64 texels a side, so a
   * mirror reflection reads its blocks rather than a sky.
   */
  readonly reflectionRoughness: number
}

export const DEFAULT_WATER_PRO_CLOUD_SKY: WaterProCloudSkyOptions =
  Object.freeze({
    width: 256,
    reflectionRoughness: 0.15
  })

export type WaterProSkySyncReason = 'initial' | 'bake' | 'cube'

export interface WaterProSkySyncInput {
  // What the environment node reports this frame
  bakeCount: number
  cube: Texture | null
  baked: boolean

  // What the last conversion saw
  syncedBakeCount: number
  syncedCube: Texture | null
}

/**
 * Whether this frame should convert the environment cube into the equirect
 * Water Pro samples, and why. Tested in order, as
 * `cloudEnvironmentRefreshDue` is, so the reason a caller reads is the one that
 * fired. `null` is the common answer: there is no image to convert before the
 * first bake, and a frame between bakes has nothing new.
 */
export function waterProSkySyncDue(
  input: WaterProSkySyncInput
): WaterProSkySyncReason | null {
  if (input.cube == null || !input.baked) return null
  if (input.syncedCube == null) return 'initial'
  if (input.bakeCount !== input.syncedBakeCount) return 'bake'
  if (input.cube !== input.syncedCube) return 'cube'
  return null
}

/**
 * The equirectangular settings Water Pro's custom-sky guide requires, applied
 * to the texture a bake renders into. Repeat wrapping closes the atan2 seam at
 * the back of the map, no mip chain keeps a one sample per texel bake from
 * being read at a level it was never filtered for, and linear filtering is what
 * a 256 by 128 bake can afford.
 */
export function applyEquirectSkySettings(target: Texture): void {
  target.mapping = EquirectangularReflectionMapping
  target.wrapS = RepeatWrapping
  target.wrapT = ClampToEdgeWrapping
  target.generateMipmaps = false
  target.minFilter = LinearFilter
  target.magFilter = LinearFilter
}

/**
 * Three's `equirectDirection`, written out rather than imported.
 *
 * The map this provider bakes is read back by three's own `equirectUV` inside
 * `PMREMGenerator`, so the bake has to use the exact inverse of that function
 * and not merely a close one. three added `equirectDirection` in 0.185 and this
 * library's floor is 0.184, where the only way to reach it is to say so here.
 *
 * https://github.com/mrdoob/three.js/blob/r184/src/nodes/utils/EquirectUV.js
 */
function equirectDirection(st: Node<'vec2'>): Node<'vec3'> {
  return Fn(([uvNode]: [Node<'vec2'>]) => {
    const theta = uvNode.x.sub(0.5).mul(2 * Math.PI)
    const phi = uvNode.y.sub(0.5).mul(Math.PI)
    const cosPhi = cos(phi)
    return vec3(cosPhi.mul(cos(theta)), sin(phi), cosPhi.mul(sin(theta)))
  })(st)
}

/**
 * The sharp sky colour along one direction, for Water Pro's fog tint.
 *
 * The level is explicit because the fog sampler runs wherever the water's own
 * control flow puts it, and a derivative-chosen level is undefined outside
 * uniform control flow. Dawn answers with zeros there, which reads as fog that
 * is simply off rather than as a fault.
 */
function equirectFogSampler(equirect: Texture) {
  return Fn(([direction]: [Node<'vec3'>]) =>
    texture(equirect, equirectUV(direction)).level(float(0))
  )
}

/**
 * The prefiltered sky along one direction, for Water Pro's water reflections.
 *
 * `pmremTexture` is three's own prefiltered read of an environment texture, and
 * its level argument is the roughness: EnvironmentNode's radiance context
 * passes `roughness` as the getTextureLevel of an environment node, which is
 * the mapping every PBR material uses. The base roughness is added before it.
 */
function equirectReflectionSampler(
  equirect: Texture,
  baseRoughness: Node<'float'>
) {
  return Fn(([direction, extra]: [Node<'vec3'>, Node<'float'>]) =>
    pmremTexture(equirect, direction, clamp(extra.add(baseRoughness), 0, 1))
  )
}

/**
 * Water Pro's sky, backed by `cloudsPass.environment`.
 *
 * Water Pro samples an equirectangular image, which is `Sky`'s `equirect`
 * parameter, so the environment cube cannot be handed to it as it stands. Each
 * bake is converted into a 2:1 equirect render target that Water Pro then
 * samples for its fog tint and its water reflections, with the clouds in both.
 *
 * ```ts
 * const cloudsPass = clouds({ sceneDepth })
 * cloudsPass.cloudsContext.experimental = { cloudEnvironment: true }
 * const sky = new WaterProCloudSky(cloudsPass.environment)
 * water.setSky(sky)
 * // once per frame, after the renderer has run the clouds pass
 * sky.update(renderer)
 * ```
 *
 * The equirect texture is one object for the provider's life, because Water
 * Pro compares `getEnvironmentTexture()` by reference every frame and reruns
 * its whole `setSky` rebind when it changes. The image behind it is
 * re-rendered and `pmremVersion` bumped instead, which is the signal three's
 * own PMREM reads.
 */
export class WaterProCloudSky implements WaterProSkyProvider {
  private readonly environment: CloudEnvironmentNode
  private readonly settings: WaterProCloudSkyOptions

  private readonly material = new NodeMaterial()
  private readonly quad = new QuadMesh(this.material)
  private readonly roughnessUniform = uniform(0.15).setName(
    'waterProSky_roughness'
  )

  private equirect: RenderTarget
  private cube: Texture | null = null
  private reflectionNode: ReflectionSampler | null = null
  private fogNode: FogSampler | null = null
  private syncedBakeCount = 0
  private bakes = 0
  private lastReason: WaterProSkySyncReason | null = null
  private disposed = false

  constructor(
    environment: CloudEnvironmentNode,
    options: Partial<WaterProCloudSkyOptions> = {}
  ) {
    this.environment = environment
    this.settings = { ...DEFAULT_WATER_PRO_CLOUD_SKY, ...options }
    this.roughnessUniform.value = this.settings.reflectionRoughness
    this.material.name = 'CloudEquirect'
    this.material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    this.quad.name = 'CloudEquirect'
    this.equirect = this.allocateEquirect()
  }

  /** The equirect Water Pro samples. One reference for the provider's life */
  get environmentTexture(): Texture {
    return this.equirect.texture
  }

  getEnvironmentTexture(): Texture {
    return this.equirect.texture
  }

  get width(): number {
    return this.equirect.width
  }

  get height(): number {
    return this.equirect.height
  }

  get bakeCount(): number {
    return this.bakes
  }

  get lastSyncReason(): WaterProSkySyncReason | null {
    return this.lastReason
  }

  /** False until the first conversion, which needs a cube bake to read */
  get synced(): boolean {
    return this.cube != null
  }

  get reflectionRoughness(): number {
    return this.roughnessUniform.value
  }

  set reflectionRoughness(value: number) {
    this.roughnessUniform.value = value
  }

  private allocateEquirect(): RenderTarget {
    const width = Math.max(2, Math.round(this.settings.width))
    const equirect = new RenderTarget(width, Math.round(width / 2), {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    equirect.texture.name = 'CloudEquirect'
    applyEquirectSkySettings(equirect.texture)
    return equirect
  }

  /**
   * Convert the environment cube if this frame has a new bake, and return why,
   * or null when the frame had nothing new. Call it once per frame, after the
   * renderer has run the pass that bakes the cube: the frame just drawn shows
   * the previous equirect, the same one frame lag any reflection map has.
   */
  update(renderer: WaterProSkyRenderer): WaterProSkySyncReason | null {
    const cube = this.environment.cubeTexture
    const reason = waterProSkySyncDue({
      bakeCount: this.environment.bakeCount,
      cube,
      baked: this.environment.hasBaked,
      syncedBakeCount: this.syncedBakeCount,
      syncedCube: this.cube
    })
    if (reason == null || cube == null) return null

    // Tracked only to decide whether the cube object changed, which a bake into
    // the same cube does not
    this.cube = cube

    // The inverse of three's equirectUV, so the texel a direction lands in is
    // the one that reads it back. The cube is indexed by three world directions
    // (cloudEnvironment.ts:233-238)
    this.material.fragmentNode = Fn(() => {
      const direction = normalize(equirectDirection(uv()))
      // the direction passed as the cube's uv: with none, three falls back to
      // the environment reflection vector, a different direction entirely
      return vec4(cubeTexture(cube, direction).xyz, 1)
    })()
    this.material.needsUpdate = true

    // Saved and restored so a call made mid-frame cannot leave the app's own
    // target bound, the way resetRendererState does inside the pass
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.equirect)
    this.quad.render(renderer)
    renderer.setRenderTarget(previous)

    // three prefilters a texture when pmremVersion moves, which is what makes
    // Water Pro's scene lighting and this provider's reflection sampler read
    // the new bake without either recompiling
    this.equirect.texture.pmremVersion += 1
    this.syncedBakeCount = this.environment.bakeCount
    this.bakes += 1
    this.lastReason = reason
    return reason
  }

  // Water Pro captures one sampler per setSky and keeps it for the provider's
  // life, so each call hands back the same graph rather than a new one
  createFogSampler(): (direction: Node) => Node {
    this.fogNode ??= equirectFogSampler(this.equirect.texture)
    return direction => this.fogNode!(direction as Node<'vec3'>)
  }

  createReflectionSampler(): (direction: Node, roughness: Node) => Node {
    this.reflectionNode ??= equirectReflectionSampler(
      this.equirect.texture,
      this.roughnessUniform
    )
    return (direction, roughness) =>
      this.reflectionNode!(
        direction as Node<'vec3'>,
        roughness as Node<'float'>
      )
  }

  /**
   * Nothing. The backdrop is the scene's own sky, and this provider only
   * supplies what Water Pro samples. Water Pro adds these to the scene and
   * excludes them from its capture pass, so an empty list leaves both alone.
   */
  getMeshes(): Object3D[] {
    return []
  }

  /** Nothing to re-centre, since `getMeshes` is empty. Kept for the interface */
  followCamera(_camera: Camera): void {}

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.equirect.dispose()
    this.cube = null
    this.reflectionNode = null
    this.fogNode = null
    this.material.dispose()
    this.quad.geometry.dispose()
  }
}
