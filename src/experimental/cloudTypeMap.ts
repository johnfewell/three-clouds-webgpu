// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Port-only and opt-in. Owns the per-location cumuliform scalar of
// docs/design/cloud-types.md 3.4, which the other vocabularies blend against
// Cite the modulated parameters: clouds.glsl:68-73, :105-110, :112-190

import {
  DataTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector4
} from 'three'
import {
  float,
  Fn,
  getCurrentStack,
  saturate,
  texture as tslTexture,
  uniform
} from 'three/tsl'
import type { Node, TextureNode, UniformNode } from 'three/webgpu'

/*
 * Additive per-lane deltas to the eight density parameters, at one point on
 * the morph axis. Every field is omitted-means-zero
 */
export interface CloudTypeArchetype {
  // Higher thresholds cut the noise field down to isolated puffs
  shapeAmount?: [number, number, number, number]
  // Erosion strength at the cloud edge: cauliflower versus smooth sheet
  shapeDetailAmount?: [number, number, number, number]
  // Skews the coverage window up the layer: tall towers versus flat sheets
  shapeAlteringBias?: [number, number, number, number]
  densityScale?: [number, number, number, number]
  // DensityProfile terms: the vertical shape of the layer's density
  expTerm?: [number, number, number, number]
  exponent?: [number, number, number, number]
  linearTerm?: [number, number, number, number]
  constantTerm?: [number, number, number, number]
}

/* `at` is the cumuliform value that selects this vocabulary, 0 to 1 */
export interface CloudTypeAnchor {
  name: string
  at: number
  archetype: CloudTypeArchetype
}

/* The eight parameters the morph modulates. Fixed at graph time */
export const CLOUD_TYPE_PARAMS = [
  'shapeAmount',
  'shapeDetailAmount',
  'shapeAlteringBias',
  'densityScale',
  'expTerm',
  'exponent',
  'linearTerm',
  'constantTerm'
] as const

export type CloudTypeParam = (typeof CLOUD_TYPE_PARAMS)[number]

/*
 * Three vocabularies, each a different direction from the default, so a
 * region between two reads as a third thing. Cirrus is absent on purpose: the
 * design doc 3.4 gives it to a separate cirrus shell
 */
export const cloudTypeAnchors: readonly [
  CloudTypeAnchor,
  CloudTypeAnchor,
  CloudTypeAnchor
] = Object.freeze([
  {
    // One continuous grey deck, barely eroded, flat top and base
    name: 'stratiform',
    at: 0,
    archetype: {
      shapeAmount: [-0.42, -0.42, -0.42, -0.42],
      shapeDetailAmount: [-0.55, -0.55, -0.55, -0.55],
      shapeAlteringBias: [0.22, 0.22, 0.22, 0.22],
      densityScale: [-0.08, -0.08, -0.08, -0.08],
      linearTerm: [0.18, 0.18, 0.18, 0.18],
      constantTerm: [0.06, 0.06, 0.06, 0.06]
    }
  },
  {
    // Rounded lumps in rows: between the two low-cloud types
    name: 'stratocumuliform',
    at: 0.5,
    archetype: {
      shapeAmount: [0.12, 0.12, 0.12, 0.12],
      shapeDetailAmount: [0.2, 0.2, 0.2, 0.2],
      shapeAlteringBias: [-0.04, -0.04, -0.04, -0.04],
      densityScale: [0.1, 0.1, 0.1, 0.1],
      linearTerm: [0.08, 0.08, 0.08, 0.08]
    }
  },
  {
    // Small, high-contrast, hard-edged cells with cauliflower tops
    name: 'cumuliform',
    at: 1,
    archetype: {
      shapeAmount: [0.45, 0.45, 0.45, 0.45],
      shapeDetailAmount: [0.55, 0.55, 0.55, 0.55],
      shapeAlteringBias: [-0.12, -0.12, -0.12, -0.12],
      densityScale: [0.32, 0.32, 0.32, 0.32],
      expTerm: [0.25, 0.25, 0.25, 0.25],
      exponent: [1.6, 1.6, 1.6, 1.6],
      linearTerm: [-0.2, -0.2, -0.2, -0.2]
    }
  }
] as const)

/* One vec4 of per-lane deltas, one entry per anchor */
export type CloudTypeAnchorDeltas = [
  UniformNode<'vec4', Vector4>,
  UniformNode<'vec4', Vector4>,
  UniformNode<'vec4', Vector4>
]

/* Every modulated parameter's delta set, one per anchor */
export type CloudTypeDeltas = Record<CloudTypeParam, CloudTypeAnchorDeltas>

export interface CloudTypeBlendNodes {
  /* The shared scalar of cloud-types.md 3.4: 0 stratiform, 1 cumuliform */
  sampleMorph: (globeUv: Node<'vec2'>) => Node<'float'>
  deltas: CloudTypeDeltas
}

const ZERO_LANES: [number, number, number, number] = [0, 0, 0, 0]

// One var per anchor, named so the WGSL tests can prove a sampler is wired. The
// scope suffix is load bearing: the weather and media samplers each build their
// own set inside the same shader, and three renames a duplicate declaration
export const CLOUD_TYPE_TENT_SCOPES = ['weather', 'media'] as const

export type CloudTypeTentScope = (typeof CLOUD_TYPE_TENT_SCOPES)[number]

export function cloudTypeTentNames(
  scope: CloudTypeTentScope,
  suffix?: string | number
): [string, string, string] {
  const postfix = suffix != null && suffix !== '' ? `_${suffix}` : ''
  return [
    `cloudTypeW0_${scope}${postfix}`,
    `cloudTypeW1_${scope}${postfix}`,
    `cloudTypeW2_${scope}${postfix}`
  ]
}

// Destructured rather than mapped: the tuple's known length is what types the
// result as three uniforms instead of an array
const [stratiform, stratocumuliform, cumuliform] = cloudTypeAnchors

function createDeltaNodes(): CloudTypeDeltas {
  const record = {} as CloudTypeDeltas
  for (const param of CLOUD_TYPE_PARAMS) {
    const lane = (anchor: CloudTypeAnchor) =>
      uniform(new Vector4(...ZERO_LANES)).setName(
        `cloudType_${param}_${anchor.name}`
      )
    record[param] = [lane(stratiform), lane(stratocumuliform), lane(cumuliform)]
  }
  return record
}

function createMapTexture(data: Uint8Array, size: number): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.minFilter = LinearMipMapLinearFilter
  tex.magFilter = LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

/*
 * No weights, so every anchor contributes nothing. RGBA because it is the one
 * format the march already samples, and green, blue and alpha stay reserved
 */
function createNeutralMap(): DataTexture {
  const size = 4
  return createMapTexture(new Uint8Array(size * size * 4), size)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

// Value noise on an integer lattice with wrap, bilinear then smoothstep
// Written here rather than imported because it runs once on the CPU while the
// map is built, never in a shader
function tileableValueNoise(cells: number, seed: number) {
  const wrap = (i: number): number => ((i % cells) + cells) % cells
  const hash = (i: number, j: number): number => {
    let h =
      Math.imul(wrap(i) + 1, 374761393) +
      Math.imul(wrap(j) + 1, 668265263) +
      seed
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
  }
  return (x: number, y: number): number => {
    const i0 = Math.floor(x)
    const j0 = Math.floor(y)
    const fx = smoothstep(0, 1, x - i0)
    const fy = smoothstep(0, 1, y - j0)
    const a = hash(i0, j0)
    const b = hash(i0 + 1, j0)
    const c = hash(i0, j0 + 1)
    const d = hash(i0 + 1, j0 + 1)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
  }
}

// The generator's shape is fixed here rather than exposed: the constants below
// were measured on the default map, and the tests pin the properties they buy
const MAP_SIZE = 128
const REGION_CELLS = 4

/*
 * The 3.4 scalar, put through the weather channel's repeat and offset by the
 * samplers. Rank equalising gives it an even spread, since a smoothed random
 * field clusters near its mean and would leave the middle band most of the sky
 */
export function createCloudTypeMap(
  options: { size?: number; cells?: number; seed?: number } = {}
): DataTexture {
  const size = options.size ?? MAP_SIZE
  const cells = options.cells ?? REGION_CELLS
  const seed = options.seed ?? 1
  const field = tileableValueNoise(cells, seed + 1)
  const count = size * size

  const raw = new Float32Array(count)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      raw[y * size + x] = field((x / size) * cells, (y / size) * cells)
    }
  }
  const order = Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => raw[a]! - raw[b]!
  )
  const data = new Uint8Array(count * 4)
  for (let rank = 0; rank < count; rank++) {
    data[order[rank]! * 4] = Math.round(
      255 * (count === 1 ? 0 : rank / (count - 1))
    )
  }
  return createMapTexture(data, size)
}

/*
 * One low-res texture of cumuliform weight plus the three vocabularies the
 * axis interpolates. Neutral by default, so the flag alone changes nothing
 */
export class CloudTypes {
  private _map: DataTexture
  private readonly _mapNode: TextureNode
  private readonly deltas = createDeltaNodes()
  private _blendNodes: CloudTypeBlendNodes | null = null

  constructor(map?: DataTexture) {
    this._map = map ?? createNeutralMap()
    this._mapNode = tslTexture(this._map).setName('cloudTypeMap')
    if (map != null) this.packDeltas()
  }

  get map(): DataTexture {
    return this._map
  }

  /*
   * Author the map. Only the texture node's value moves, so an already-built
   * graph picks the swap up. Until this is called the deltas stay zero
   */
  setMap(map: DataTexture): this {
    this._map = map
    this._mapNode.value = map
    this.packDeltas()
    return this
  }

  /* Push the anchor table into the delta uniforms */
  packDeltas(): void {
    for (const param of CLOUD_TYPE_PARAMS) {
      const perAnchor = this.deltas[param]
      for (let index = 0; index < cloudTypeAnchors.length; index++) {
        const lanes = cloudTypeAnchors[index]!.archetype[param] ?? ZERO_LANES
        perAnchor[index]!.value.set(lanes[0], lanes[1], lanes[2], lanes[3])
      }
    }
  }

  /*
   * The nodes the density samplers consume, over the weather channel's own
   * repeat and offset so the map has no tiling of its own. Explicit mip level:
   * an implicit-LOD sample in the march loop returns zeros on Dawn
   */
  blendNodes(repeat: Node<'vec2'>, offset: Node<'vec2'>): CloudTypeBlendNodes {
    // Built once: the primary and shadow graphs both read these, and a second
    // Fn instance would emit a second copy of the map sample
    if (this._blendNodes != null) return this._blendNodes
    const map = this._mapNode
    const sampleMorph = Fn(([globeUv]: [Node<'vec2'>]) =>
      saturate(map.sample(globeUv.mul(repeat).add(offset)).level(float(0)).r)
    ) as unknown as (globeUv: Node<'vec2'>) => Node<'float'>
    this._blendNodes = { sampleMorph, deltas: this.deltas }
    return this._blendNodes
  }

  dispose(): void {
    this._map.dispose()
  }
}

interface StackWithParent {
  parent?: StackWithParent | null
  _tentCounters?: Map<string, number>
}

function nextTentIndex(scope: CloudTypeTentScope): number {
  const stack = getCurrentStack()
  if (stack == null) return 0
  let curr: StackWithParent = stack as StackWithParent
  while (curr.parent != null) {
    curr = curr.parent
  }
  curr._tentCounters ??= new Map<string, number>()
  const index = curr._tentCounters.get(scope) ?? 0
  curr._tentCounters.set(scope, index + 1)
  return index
}

/*
 * The three tent weights, which sum to one, so the blend is convex and morph
 * 0 really is the stratiform one. A plain helper, not an Fn: TSL does not model
 * an Fn returning a tuple. Call it ONCE per sampler body and reuse the three
 */
export function cloudTypeTentWeights(
  morph: Node<'float'>,
  scope: CloudTypeTentScope,
  suffix?: string | number
): [Node<'float'>, Node<'float'>, Node<'float'>] {
  const index = suffix ?? nextTentIndex(scope)
  const names = cloudTypeTentNames(scope, index === 0 ? undefined : index)
  const centred = morph.sub(0.5).mul(2)
  return [
    saturate(centred.negate()).toVar(names[0]),
    saturate(float(1).sub(centred.abs())).toVar(names[1]),
    saturate(centred).toVar(names[2])
  ]
}

/*
 * `base + the tent-weighted sum of the three anchors' deltas`. Straight-line
 * arithmetic inlined at eight call sites per step, so not a WGSL call
 */
export function blendCloudTypeParameter(
  base: Node<'vec4'>,
  weights: [Node<'float'>, Node<'float'>, Node<'float'>],
  d0: Node<'vec4'>,
  d1: Node<'vec4'>,
  d2: Node<'vec4'>
): Node<'vec4'> {
  return base
    .add(weights[0].mul(d0))
    .add(weights[1].mul(d1))
    .add(weights[2].mul(d2))
}

/* CPU twin of the tent weights */
export function cpuCloudTypeTentWeights(
  morph: number
): [number, number, number] {
  const centred = (morph - 0.5) * 2
  return [clamp01(-centred), clamp01(1 - Math.abs(centred)), clamp01(centred)]
}

/* CPU twin of blendCloudTypeParameter, for one modulated parameter */
export function cpuBlendCloudTypeParameter(
  base: [number, number, number, number],
  morph: number,
  param: CloudTypeParam,
  anchors: readonly CloudTypeArchetype[]
): [number, number, number, number] {
  const weights = cpuCloudTypeTentWeights(morph)
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let lane = 0; lane < 4; lane++) {
    let sum = base[lane]!
    for (let index = 0; index < anchors.length; index++) {
      sum += weights[index]! * (anchors[index]![param]?.[lane] ?? 0)
    }
    out[lane] = sum
  }
  return out
}

/* The anchor table as the blend consumes it: one archetype per anchor */
export const cloudTypeArchetypes: readonly CloudTypeArchetype[] = Object.freeze(
  cloudTypeAnchors.map(anchor => anchor.archetype)
)
