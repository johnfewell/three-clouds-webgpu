// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// A cheap cirrus deck: one textured sheet on a sphere above the volumetric
// layers, read once per pixel and composited by depth against the march
// Cost and trade-offs: docs/EXPERIMENTAL.md under `cirrusDeck`

import { Vector2, type Camera, type Texture } from 'three'
import {
  abs,
  dot,
  float,
  Fn,
  log2,
  max,
  normalize,
  select,
  sqrt,
  texture,
  uniform,
  vec2,
  vec4
} from 'three/tsl'
import type { Node, StructNode, TextureNode, UniformNode } from 'three/webgpu'

import { getGlobeUv } from '../density/globeUv'
import { phaseFunctionTSL } from '../lighting/phaseFunction'
import { RECIPROCAL_PI4 } from '../lighting/sunSkyLight'
import { rayIntersectsGround } from '../march/intersections'

export interface CirrusDeckParams {
  // Metres above the bottom radius. Above every volumetric layer by default,
  // which is what makes "behind the march" the right composite order
  altitude: number
  // Opacity multiplier on the texture. 0 draws no deck, with no rebuild
  strength: number
  // Metres one texture tile spans on the deck
  scale: number
  // Drift in metres per second along the texture's own two axes. Applied to
  // `CloudsContext.time`, so the shader carries no clock
  velocityU: number
  velocityV: number
  // Opacity in the red channel, repeating. Null uses the bundled streaks
  texture: Texture | null
}

export const cirrusDeckDefaults: Readonly<CirrusDeckParams> = Object.freeze({
  altitude: 10000,
  strength: 0.7,
  scale: 40000,
  velocityU: 12,
  velocityV: 0,
  texture: null
})

// The one bend in the LOD: below this cosine a footprint is treated as this
// oblique, so the horizon blurs to the last mips instead of dividing by zero
export const CIRRUS_DECK_MIN_COSINE = 0.02

// The ray's first hit on the deck sphere in front of the camera, or -1 when it
// never reaches the deck because it misses it, or hits the ground or the
// scene first. Positions in metres from the sphere centre
export function cirrusDeckDistanceCPU(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  deckRadius: number,
  bottomRadius: number,
  sceneRayDistance: number
): number {
  const b =
    origin[0] * direction[0] +
    origin[1] * direction[1] +
    origin[2] * direction[2]
  const r2 = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2
  const c = r2 - deckRadius * deckRadius
  const discriminant = b * b - c
  if (discriminant < 0) return -1
  const halfChord = Math.sqrt(discriminant)
  // Inside the deck sphere only the far root is in front. Outside it the near
  // root is the face that looks at the camera
  const t = c < 0 ? -b + halfChord : -b - halfChord
  if (t <= 0) return -1
  // rayIntersectsGround's test, so the deck shares the march's horizon. It
  // also holds for a camera the altitude correction leaves under the sphere
  // From above the deck its entry comes before any ground, so only below it
  const r = Math.sqrt(r2)
  const mu = b / r
  const ground = mu < 0 && r2 * (mu * mu - 1) + bottomRadius ** 2 >= 0
  if (ground && c < 0) return -1
  if (sceneRayDistance > 0 && sceneRayDistance < t) return -1
  return t
}

// The texture LOD for a hit at `distance` metres whose ray meets the deck at
// `cosine`. The footprint is the geometric mean of the two axes: the long axis
// alone over-blurs, the short axis alone aliases at the horizon
export function cirrusDeckLodCPU(
  distance: number,
  cosine: number,
  lodScale: number
): number {
  const oblique = Math.sqrt(Math.max(Math.abs(cosine), CIRRUS_DECK_MIN_COSINE))
  return Math.log2(Math.max((distance * lodScale) / oblique, 1))
}

// Two premultiplied layers, front over back
export function overCPU(
  front: readonly [number, number, number, number],
  back: readonly [number, number, number, number]
): [number, number, number, number] {
  const k = 1 - front[3]
  return [
    front[0] + back[0] * k,
    front[1] + back[1] * k,
    front[2] + back[2] * k,
    front[3] + back[3] * k
  ]
}

export interface CirrusDeckUniforms {
  altitude: UniformNode<'float', number>
  strength: UniformNode<'float', number>
  // Texture repeats per cube face of the globe uv, from `scale` and the radius
  repeat: UniformNode<'float', number>
  // Drift in texture tiles, wrapped to 0..1 so it never loses precision
  offset: UniformNode<'vec2', Vector2>
  // Texels per metre of footprint at 1 m: pixel angle times texels per metre
  lodScale: UniformNode<'float', number>
  map: TextureNode
}

export function createCirrusDeckUniforms(
  defaultTexture: Texture
): CirrusDeckUniforms {
  return {
    altitude: uniform(cirrusDeckDefaults.altitude).setName(
      'cirrusDeck_altitude'
    ),
    strength: uniform(cirrusDeckDefaults.strength).setName(
      'cirrusDeck_strength'
    ),
    repeat: uniform(1).setName('cirrusDeck_repeat'),
    offset: uniform(new Vector2()).setName('cirrusDeck_offset'),
    lodScale: uniform(0).setName('cirrusDeck_lodScale'),
    map: texture(defaultTexture)
  }
}

// The arc one cube face of getGlobeUv spans, as a fraction of the radius
const FACE_ARC = Math.PI / 2

export interface CirrusDeckFrame {
  bottomRadius: number
  time: number
  // The full-resolution frame height and camera, for the pixel footprint
  height: number
  camera: Camera
}

export function updateCirrusDeckUniforms(
  uniforms: CirrusDeckUniforms,
  params: CirrusDeckParams,
  frame: CirrusDeckFrame,
  defaultTexture: Texture
): void {
  const scale = Math.max(params.scale, 1)
  const radius = frame.bottomRadius + params.altitude
  uniforms.altitude.value = params.altitude
  uniforms.strength.value = params.strength
  uniforms.repeat.value = (FACE_ARC * radius) / scale
  const u = (params.velocityU * frame.time) / scale
  const v = (params.velocityV * frame.time) / scale
  uniforms.offset.value.set(u - Math.floor(u), v - Math.floor(v))
  const map = params.texture ?? defaultTexture
  uniforms.map.value = map
  const image = map.image as { width?: number } | null
  const texels = image?.width ?? 1
  uniforms.lodScale.value =
    (pixelAngle(frame.camera, frame.height) * texels) / scale
}

// Radians one pixel subtends at the centre of a perspective frame. 0 for any
// other camera, which pins the LOD at the base level
export function pixelAngle(camera: Camera, height: number): number {
  const yScale = camera.projectionMatrix.elements[5] ?? 0
  if (!(yScale > 0) || !(height > 0)) return 0
  return 2 / (yScale * height)
}

export interface CirrusDeckDeps {
  uniforms: CirrusDeckUniforms
  bottomRadius: Node<'float'>
  sunDirection: Node<'vec3'>
  getSunSkyIrradiance: (position: Node<'vec3'>) => StructNode
  applyAerialPerspective: (
    cameraPosition: Node<'vec3'>,
    frontPosition: Node<'vec3'>,
    shadowLength: Node<'float'>,
    color: Node<'vec4'>
  ) => Node<'vec4'>
  scatterAnisotropy1: number
  scatterAnisotropy2: number
  scatterAnisotropyMix: number
}

// The deck hit as (distance, visible): distance clamped to 0 on a miss, and
// visible 0 or 1. Split from the shading so each body stays inside the
// decision-point budget
function createCirrusDeckHit(deps: CirrusDeckDeps) {
  const { uniforms } = deps
  return Fn(
    ([cameraPosition, rayDirection, sceneRayDistance]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>
    ]) => {
      const deckRadius = deps.bottomRadius.add(uniforms.altitude)
      const b = dot(cameraPosition, rayDirection).toVar()
      const r2 = dot(cameraPosition, cameraPosition).toVar()
      const c = r2.sub(deckRadius.mul(deckRadius))
      const discriminant = b.mul(b).sub(c).toVar()
      const halfChord = sqrt(max(discriminant, float(0)))
      const t = select(
        c.lessThan(0),
        b.negate().add(halfChord),
        b.negate().sub(halfChord)
      ).toVar()
      // The march's own ground test, so the deck and the clouds share one
      // horizon whatever height the altitude correction leaves the camera at
      // From above the deck its entry comes before any ground, so only below it
      const groundFirst = rayIntersectsGround(
        cameraPosition,
        rayDirection,
        deps.bottomRadius
      ).and(c.lessThan(0))
      const sceneFirst = sceneRayDistance
        .greaterThan(0)
        .and(sceneRayDistance.lessThan(t))
      const visible = discriminant
        .greaterThanEqual(0)
        .and(t.greaterThan(0))
        .and(groundFirst.not())
        .and(sceneFirst.not())
      // Clamped so a ray that misses still builds a finite position. Its
      // opacity is zeroed below, and a select keeps the flow uniform
      return vec2(max(t, float(0)), select(visible, float(1), float(0)))
    }
  )
}

// The deck's premultiplied colour after the aerial perspective to it
function createCirrusDeckShade(deps: CirrusDeckDeps) {
  const { uniforms } = deps
  return Fn(
    ([cameraPosition, rayDirection, tv, shadowLength]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'vec2'>,
      Node<'float'>
    ]) => {
      const position = rayDirection.mul(tv.x).add(cameraPosition).toVar()
      const normal = normalize(position)
      const cosine = max(
        abs(dot(rayDirection, normal)),
        float(CIRRUS_DECK_MIN_COSINE)
      )
      // Explicit LOD: derivative-free, so it is defined in any control flow
      // and does not blow up across the globe uv's cube seams
      const lod = log2(max(tv.x.mul(uniforms.lodScale).div(sqrt(cosine)), 1))
      const uv = getGlobeUv(position).mul(uniforms.repeat).add(uniforms.offset)
      const coverage = uniforms.map.sample(uv).level(lod).r
      const alpha = coverage.mul(uniforms.strength).mul(tv.y).clamp(0, 1)

      const irradiance = deps.getSunSkyIrradiance(position)
      // struct .get() is not generic over the member table
      const sun = irradiance.get('direct') as Node<'vec3'>
      const sky = irradiance.get('indirect') as Node<'vec3'>
      const phase = phaseFunctionTSL(
        dot(rayDirection, deps.sunDirection),
        float(1),
        float(deps.scatterAnisotropy1),
        float(deps.scatterAnisotropy2),
        float(deps.scatterAnisotropyMix)
      )
      // Single scattering in an optically thin sheet: every crystal sees the
      // full sun, so the radiance is the opacity times the phase-weighted light
      const radiance = sun.mul(phase).add(sky.mul(RECIPROCAL_PI4)).mul(alpha)
      const color = deps.applyAerialPerspective(
        cameraPosition,
        position,
        shadowLength,
        vec4(radiance, alpha)
      )
      return vec4(color.xyz, alpha)
    }
  )
}

// The composite: the deck goes behind the marched clouds unless the clouds the
// ray hit lie beyond it, which only happens from above the deck
export function createCirrusDeckComposite(deps: CirrusDeckDeps) {
  const hit = createCirrusDeckHit(deps)
  const shade = createCirrusDeckShade(deps)
  return Fn(
    ([
      cameraPosition,
      rayDirection,
      sceneRayDistance,
      shadowLength,
      color,
      hitClouds,
      frontDepth
    ]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'vec4'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const tv = hit(cameraPosition, rayDirection, sceneRayDistance).toVar()
      const deck = shade(cameraPosition, rayDirection, tv, shadowLength).toVar()
      const deckInFront = hitClouds
        .greaterThan(0)
        .and(frontDepth.greaterThan(tv.x))
      const cloudOverDeck = vec4(
        color.xyz.add(deck.xyz.mul(color.w.oneMinus())),
        color.w.add(deck.w.mul(color.w.oneMinus()))
      )
      const deckOverCloud = vec4(
        deck.xyz.add(color.xyz.mul(deck.w.oneMinus())),
        deck.w.add(color.w.mul(deck.w.oneMinus()))
      )
      return select(deckInFront, deckOverCloud, cloudOverDeck)
    }
  )
}
