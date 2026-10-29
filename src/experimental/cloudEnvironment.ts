// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
//
// Clouds in the environment map: a low-resolution march of the volume the
// screen pass marches, over the sky, into a cube map. Not ported code, and
// docs/EXPERIMENTAL.md's cloudEnvironment section is where it is explained

import {
  CubeCamera,
  WebGLCubeRenderTarget as CubeRenderTarget,
  HalfFloatType,
  Mesh,
  RGBAFormat,
  Vector3
} from 'three'
import {
  float,
  Fn,
  normalize,
  pmremTexture,
  positionGeometry,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import { NodeMaterial, TempNode, type Node } from 'three/webgpu'

import { sky } from '@takram/three-atmosphere/webgpu'
import { QuadGeometry, radians } from '@takram/three-geospatial'
import {
  interleavedGradientNoise,
  inverseProjectionMatrix,
  inverseViewMatrix
} from '@takram/three-geospatial/webgpu'

import type { CloudsContext } from '../CloudsContext'
import type { LayerUniforms } from '../layerUniforms'
import { getIntersections, rayNearFarFrom } from '../march/intersections'
import type { MarchUniforms } from '../marchUniforms'
import type { ParameterUniforms } from '../parameterUniforms'
import { buildMarchFactories, type MarchGraphHost } from '../pass/marchGraph'

// The environment map's own budget, and deliberately not the screen pass's
// A reflection reaches the map through a blur kernel and a PMREM, so a step
// spent here buys detail no consumer of the map can resolve
export interface CloudEnvironmentSettings {
  readonly size: number

  readonly updateInterval: number

  readonly maxIterationCount: number

  readonly maxIterationCountToSun: number

  readonly distanceThreshold: number

  readonly angularThreshold: number
}

// Cite: SkyEnvironmentNode.ts:26-33, whose size and thresholds this matches so
// the map is a drop-in for the one it bakes
export const DEFAULT_CLOUD_ENVIRONMENT: CloudEnvironmentSettings =
  Object.freeze({
    size: 64,
    updateInterval: 4,
    maxIterationCount: 32,
    maxIterationCountToSun: 6,
    distanceThreshold: 1000,
    angularThreshold: radians(0.1)
  })

export type CloudEnvironmentReason =
  'initial' | 'graph' | 'camera' | 'sun' | 'schedule' | 'forced'

export interface CloudEnvironmentDueInput {
  framesSinceBake: number
  updateInterval: number

  graphChanged: boolean

  cameraMoved: number
  distanceThreshold: number

  sunMoved: number
  angularThreshold: number

  baked: boolean

  forced: boolean
}

// Whether this frame should re-bake, and why. Tested in order rather than as a
// conjunction, so the reason a caller reads is the one that fired

export function cloudEnvironmentRefreshDue(
  input: CloudEnvironmentDueInput
): CloudEnvironmentReason | null {
  if (input.forced) return 'forced'
  if (!input.baked) return 'initial'
  if (input.graphChanged) return 'graph'
  if (input.cameraMoved > input.distanceThreshold) return 'camera'
  if (input.sunMoved > input.angularThreshold) return 'sun'
  if (input.framesSinceBake >= input.updateInterval) return 'schedule'
  return null
}

export interface CloudEnvironmentBakeInput {
  // The renderer's duck type as CubeCamera.update declares it, taken from the
  // signature rather than named: three does not export that interface, and
  // WebGPURenderer satisfies it structurally
  renderer: Parameters<CubeCamera['update']>[0]

  cameraPositionECEF: Vector3

  sunDirectionECEF: Vector3
}

// The environment map, as a node. Constructed with the pass so a consumer can
// capture it before any graph exists, and it reads back null until
// experimental.cloudEnvironment is on and a graph has been built

export class CloudEnvironmentNode extends TempNode {
  static get type(): string {
    return 'CloudEnvironmentNode'
  }

  readonly settings: CloudEnvironmentSettings = DEFAULT_CLOUD_ENVIRONMENT

  private cubeTarget: CubeRenderTarget | null = null
  private cubeCamera: CubeCamera | null = null
  private skyNode: ReturnType<typeof sky> | null = null
  private readonly material = new NodeMaterial()
  private readonly mesh = new Mesh(new QuadGeometry(), this.material)

  private readonly bakedCameraPosition = new Vector3()
  private readonly bakedSunDirection = new Vector3()
  private baked = false
  private staleGraph = false
  private framesSinceBake = 0
  private forced = false
  private bakes = 0
  private lastReason: CloudEnvironmentReason | null = null

  constructor() {
    super('vec3')
    this.material.name = 'CloudEnvironment'
  }

  get size(): number {
    return this.settings.size
  }

  get updateInterval(): number {
    return this.settings.updateInterval
  }

  // The bake target's texture, for a consumer that wants the raw cube rather
  // than this node's prefiltered read. Null until the option is on and a graph
  // exists, and a new object on every rebuild, so it can be watched by reference
  get cubeTexture(): CubeRenderTarget['texture'] | null {
    return this.cubeTarget?.texture ?? null
  }

  get hasBaked(): boolean {
    return this.baked
  }

  get bakeCount(): number {
    return this.bakes
  }

  get lastBakeReason(): CloudEnvironmentReason | null {
    return this.lastReason
  }

  refresh(): void {
    this.forced = true
  }

  override setup(): Node | null {
    if (this.cubeTarget == null) return null
    // The same shape SkyEnvironmentNode returns: a prefiltered read of the
    // cube, so a rough material gets roughness-blurred irradiance
    return pmremTexture(this.cubeTarget.texture)
  }

  // Build the bake graph. Only called with the option on, so the off graph
  // mints no cube target and no second march, and its WGSL is unchanged

  buildGraph(
    ctx: CloudsContext,
    marchU: MarchUniforms,
    layerU: LayerUniforms,
    paramU: ParameterUniforms,
    host: MarchGraphHost
  ): void {
    const { marchClouds, applyAerialPerspective } = buildMarchFactories(
      ctx,
      marchU,
      layerU,
      paramU,
      false,
      host,
      {
        maxIterationCount: float(this.settings.maxIterationCount),
        maxIterationCountToSun: float(this.settings.maxIterationCountToSun),
        cloudFrontRefinement: false,
        shadows: false,
        shapeDetail: false
      }
    )

    // The sky underneath, as SkyEnvironmentNode bakes it: no disc, no stars,
    // because a 64px face would alias them across six seams
    const skyNode = sky()
    skyNode.showSun = false
    skyNode.showMoon = false
    skyNode.showStars = false
    // Null camera, so the ray comes from the cube camera drawing the face
    skyNode.useContextCamera = false
    this.skyNode?.dispose()
    this.skyNode = skyNode

    const cameraPosition = ctx.cameraUniforms.cameraPositionECEF
    const sunDirection = marchU.sunDirection
    // The double assertion is deliberate and the only way through: sky() is a
    // nodeProxy whose types are the proxy's, and the atmosphere package's own
    // .d.ts never narrows it to a Node
    const skyRadiance = skyNode as unknown as Node<'vec3'>

    const environmentFragment = Fn(() => {
      // Cite: clouds.frag:833-835 builds the ray from vUv * 2 - 1, v bottom-up
      // WebGPU's uv() runs top-down, so clip y is 1 - 2v here as it is there
      // The face is one flat quad, so no derivatives to read a mip from
      const clipXY = vec2(uv().x.mul(2).sub(1), float(1).sub(uv().y.mul(2)))
      const viewPosition = (inverseProjectionMatrix(null) as Node<'mat4'>).mul(
        vec4(clipXY, 1, 1)
      ).xyz
      const worldDirection = (inverseViewMatrix(null) as Node<'mat4'>).mul(
        vec4(viewPosition, 0)
      ).xyz
      const rayDirection = normalize(
        marchU.worldToECEFMatrix.mul(vec4(worldDirection, 0)).xyz
      ).toVar()
      const origin = cameraPosition
        .add(marchU.altitudeCorrection)
        .toVar() as Node<'vec3'>
      const cosTheta = sunDirection.dot(rayDirection)

      // Built inside each altitude branch, not shared across them: three r186
      // declares a shared node in the first branch only
      const intersections = () => {
        const ix = getIntersections(
          origin,
          rayDirection,
          marchU.bottomRadius,
          layerU.minHeight,
          layerU.maxHeight,
          layerU.shadowTopHeight
        )
        return {
          ground: ix.get('ground') as Node<'bool'>,
          first: ix.get('first') as Node<'vec4'>,
          second: ix.get('second') as Node<'vec4'>
        }
      }
      const rayNearFar = rayNearFarFrom(intersections)(
        marchU.cameraHeight,
        ctx.cameraUniforms.cameraNear,
        layerU.minHeight,
        layerU.maxHeight,
        marchU.maxRayDistance
      )
      // A ray that hit the ground, or that never reached the layer, has no
      // clouds in it. getRayNearFar leaves near at -1 for both
      const reachesLayer = rayNearFar.x
        .greaterThanEqual(0)
        .and(rayNearFar.y.greaterThan(rayNearFar.x))

      // A ray with no layer in it marches an empty range instead of being
      // branched around, so the loop's own Break ends it on the first step
      const marchRange = reachesLayer.select(rayNearFar, vec2(0, 0))
      // Cite: cloudsFragment.ts:471, the march starts where the ray enters the
      // layer and the entry distance folds into the step size, not the origin
      const marchOrigin = rayDirection.mul(marchRange.x).add(origin)
      const jitter = interleavedGradientNoise(uv().mul(this.settings.size))
      const marched = marchClouds(
        marchOrigin,
        rayDirection,
        marchRange,
        cosTheta,
        jitter as Node<'float'>,
        // One texel per pixel, so the march's own distance term decides the
        // noise mip. The shape volumes are sampled at level 0 by construction,
        // so there is no finer filter here to ask for
        float(1)
      )
      // .a is transmittance, so the sky behind the clouds is what survives them
      const layer = marched.get('layer') as Node<'vec4'>
      // Cite: cloudsFragment.ts:512-513, the front depth is stored from the
      // layer entry in unit space, and the aerial ray starts at the camera
      const frontDepthMetres = rayNearFar.x.add(
        (marched.get('depthVelocity') as Node<'vec4'>).x.div(marchU.worldToUnit)
      )
      // The reference applies aerial perspective to the cloud front only
      // (clouds.frag:940-942), and the shafts are off here so its length is 0
      const lit = applyAerialPerspective(
        origin,
        origin.add(rayDirection.mul(frontDepthMetres)),
        float(0),
        layer
      )
      const transmittance = reachesLayer.select(lit.a, float(1))
      const radiance = reachesLayer.select(lit.xyz, vec3(0))
      return vec4(skyRadiance.mul(transmittance).add(radiance), 1)
    })

    this.material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    this.material.fragmentNode = environmentFragment()
    this.material.needsUpdate = true

    this.cubeTarget?.dispose()
    this.cubeTarget = new CubeRenderTarget(this.settings.size, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    this.cubeCamera = new CubeCamera(0.1, 1000, this.cubeTarget)
    this.baked = false
    this.bakes = 0
    this.staleGraph = true
    // The consumer's material may already hold the node's previous pmrem read
    this.needsUpdate = true
  }

  clear(): void {
    this.cubeCamera = null
    this.cubeTarget?.dispose()
    this.cubeTarget = null
    this.skyNode?.dispose()
    this.skyNode = null
    this.baked = false
    this.bakes = 0
    this.staleGraph = false
    this.lastReason = null
  }

  // Re-bake if the schedule or a trigger says so. The pass calls it once per
  // frame, after that frame's uniforms are synced, so the map and the screen
  // agree on the volume they marched. Returns why it baked, or null.

  bakeIfDue(input: CloudEnvironmentBakeInput): CloudEnvironmentReason | null {
    const cubeTarget = this.cubeTarget
    const cubeCamera = this.cubeCamera
    if (cubeTarget == null || cubeCamera == null) return null

    // Counted before the decision, so a bake on frame N is followed by one on
    // frame N + updateInterval and not N + updateInterval - 1
    this.framesSinceBake += 1
    const reason = cloudEnvironmentRefreshDue({
      framesSinceBake: this.framesSinceBake,
      updateInterval: this.settings.updateInterval,
      graphChanged: this.staleGraph,
      cameraMoved: input.cameraPositionECEF.distanceTo(
        this.bakedCameraPosition
      ),
      distanceThreshold: this.settings.distanceThreshold,
      sunMoved: this.bakedSunDirection.angleTo(input.sunDirectionECEF),
      angularThreshold: this.settings.angularThreshold,
      baked: this.baked,
      forced: this.forced
    })
    this.forced = false
    if (reason == null) return null

    cubeCamera.update(input.renderer, this.mesh)

    this.bakedCameraPosition.copy(input.cameraPositionECEF)
    this.bakedSunDirection.copy(input.sunDirectionECEF)
    this.baked = true
    this.staleGraph = false
    this.framesSinceBake = 0
    this.bakes += 1
    this.lastReason = reason
    // Rebuild the material's pmrem read, which is what a consumer samples
    this.needsUpdate = true
    return reason
  }

  override dispose(): void {
    this.clear()
    this.material.dispose()
    this.mesh.geometry.dispose()
    super.dispose()
  }
}

// Metres one environment-map texel covers at its far end, the aliasing an
// environment map costs. No shader counterpart: a cube face has no derivatives
// to read the screen pass's noise mip from

export function environmentTexelFootprint(
  size: number,
  maxRayDistance: number
): number {
  return (Math.PI / 2 / size) * maxRayDistance
}
