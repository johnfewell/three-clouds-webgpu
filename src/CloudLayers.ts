// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import type { Vector3, Vector4 } from 'three'

import { CloudLayer, type CloudLayerLike } from './CloudLayer'
import type { DensityProfileLike } from './DensityProfile'

type NumericKey = keyof {
  [P in keyof CloudLayer as number extends CloudLayer[P] ? P : never]: unknown
}

interface Entry {
  value: number
  flag: 0 | 1
}

// prettier-ignore
const entriesScratch: Entry[] = /*#__PURE__*/ Array.from(
  { length: 8 },
  () => ({ value: 0, flag: 0 })
)
// prettier-ignore
const intervalsScratch = /*#__PURE__*/ Array.from(
  { length: 3 },
  () => ({ min: 0, max: 0 })
)

/** See {@link CloudLayers.structure} */
export interface LayerStructure {
  active: [boolean, boolean, boolean, boolean]
  weatherExponentOne: boolean
  expTermZero: boolean
}

/** The unspecialised shape: every lane live, both terms kept */
export const GENERIC_LAYER_STRUCTURE: LayerStructure = {
  active: [true, true, true, true],
  weatherExponentOne: false,
  expTermZero: false
}

/** A stable string for the cache key and the change poll */
export function layerStructureKey(s: LayerStructure): string {
  return (
    s.active.map(a => (a ? '1' : '0')).join('') +
    (s.weatherExponentOne ? 'w' : '-') +
    (s.expTermZero ? 'e' : '-')
  )
}

function compareEntries(a: Entry, b: Entry): number {
  return a.value !== b.value ? a.value - b.value : a.flag - b.flag
}

/**
 * The four {@link CloudLayer} slots, as an array you index by position. The
 * count is fixed at four because the shader packs them into one `vec4` per
 * field, so a fifth layer would need a different graph.
 *
 * Which channel each layer reads is what makes them independent: the default
 * set takes `r`, `g`, `b` and `a` of the weather map.
 */
export class CloudLayers extends Array<CloudLayer> {
  /**
   * The three authored layers the original ships (two weather-driven bands and
   * one high cirrus) plus a fourth empty slot. Every `CloudsContext` starts
   * from a clone of this, so mutating it is safe.
   */
  static readonly DEFAULT = /*#__PURE__*/ new CloudLayers([
    {
      channel: 'r',
      altitude: 750,
      height: 650,
      densityScale: 0.2,
      shapeAmount: 1,
      shapeDetailAmount: 1,
      weatherExponent: 1,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.6,
      shadow: true
    },
    {
      channel: 'g',
      altitude: 1000,
      height: 1200,
      densityScale: 0.2,
      shapeAmount: 1,
      shapeDetailAmount: 1,
      weatherExponent: 1,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.6,
      shadow: true
    },
    {
      channel: 'b',
      altitude: 7500,
      height: 500,
      densityScale: 0.003,
      shapeAmount: 0.4,
      shapeDetailAmount: 0,
      weatherExponent: 1,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.5
    },
    { channel: 'a' }
  ])

  /** Build the four slots, each patched over {@link CloudLayer}'s defaults */
  constructor(options?: readonly CloudLayerLike[]) {
    super(
      new CloudLayer(options?.[0]),
      new CloudLayer(options?.[1]),
      new CloudLayer(options?.[2]),
      new CloudLayer(options?.[3])
    )
  }

  /** Patch each slot from a partial-per-layer object */
  set(options?: readonly CloudLayerLike[]): this {
    this[0]!.set(options?.[0])
    this[1]!.set(options?.[1])
    this[2]!.set(options?.[2])
    this[3]!.set(options?.[3])
    return this
  }

  /** Return every slot to {@link CloudLayer}'s own defaults */
  reset(): this {
    this[0]!.copy(CloudLayer.DEFAULT)
    this[1]!.copy(CloudLayer.DEFAULT)
    this[2]!.copy(CloudLayer.DEFAULT)
    this[3]!.copy(CloudLayer.DEFAULT)
    return this
  }

  /** A new set with the same four layers, each copied */
  clone(): CloudLayers {
    return new CloudLayers(this)
  }

  copy(other: CloudLayers): this {
    this[0]!.copy(other[0]!)
    this[1]!.copy(other[1]!)
    this[2]!.copy(other[2]!)
    this[3]!.copy(other[3]!)
    return this
  }

  /**
   * The four channels as one string such as `'rgba'`. Polled by
   * `CloudsContext.checkLocalWeatherChannels` because the swizzle is compiled
   * in, so changing a layer's channel rebuilds the march.
   */
  get localWeatherChannels(): string {
    return (
      this[0]!.channel + this[1]!.channel + this[2]!.channel + this[3]!.channel
    )
  }

  /**
   * Whether ANY layer casts a cloud shadow.
   *
   * This exact predicate gates a graph-time variant (CloudsPassNode compiles
   * the Beer-shadow-map branch into shadeSample only when it holds), so it is
   * what CloudsContext.checkShadowStructure tracks
   *
   * Deliberately not per-layer: WHICH layers cast reaches the shader through the
   * packed `shadowLayerMask` uniform, so a change there needs no rebuild. Only
   * the existence of a caster changes the compiled shape.
   */
  get castsShadow(): boolean {
    return (
      this[0]!.shadow || this[1]!.shadow || this[2]!.shadow || this[3]!.shadow
    )
  }

  /**
   * The graph-time shape of the layer set: which of the four lanes
   * hold a layer, and whether two terms of the per-layer maths are identities
   * on every active lane. CloudsPassNode compiles these facts into the march
   * as literals. The magnitudes stay uniforms, so only a change here rebuilds.
   *
   * - A lane with `height <= 0` is empty: its weather density is 0 for every
   *   height but the layer's own altitude, so it is compiled as a literal 0.
   * - `weatherExponent === 1` on every active lane drops `pow(weather, e)`.
   * - `densityProfile.expTerm === 0` on every active lane drops
   *   `expTerm * exp(exponent * h)` from the density profile.
   */
  get structure(): LayerStructure {
    // Polled every frame (CloudsContext.checkLayerStructure): loops, no
    // intermediate arrays
    const active: LayerStructure['active'] = [false, false, false, false]
    let weatherExponentOne = true
    let expTermZero = true
    for (let i = 0; i < 4; ++i) {
      const layer = this[i]!
      if (!(layer.height > 0)) continue
      active[i] = true
      if (layer.weatherExponent !== 1) weatherExponentOne = false
      if (layer.densityProfile.expTerm !== 0) expTermZero = false
    }
    return { active, weatherExponentOne, expTermZero }
  }

  /**
   * Write one numeric field from all four layers into a `vec4`. This is how the
   * per-layer values reach the shader.
   */
  packValues<K extends NumericKey>(key: K, result: Vector4): Vector4 {
    return result.set(
      this[0]![key],
      this[1]![key],
      this[2]![key],
      this[3]![key]
    )
  }

  /**
   * Write `a + b` from all four layers into a `vec4`, for the band tops, which
   * are stored as an altitude plus a height
   */
  packSums<A extends NumericKey, B extends NumericKey>(
    a: A,
    b: B,
    result: Vector4
  ): Vector4 {
    return result.set(
      this[0]![a] + this[0]![b],
      this[1]![a] + this[1]![b],
      this[2]![a] + this[2]![b],
      this[3]![a] + this[3]![b]
    )
  }

  /** One {@link DensityProfile} field from all four layers, into a `vec4` */
  packDensityProfiles<K extends keyof DensityProfileLike>(
    key: K,
    result: Vector4
  ): Vector4 {
    return result.set(
      this[0]!.densityProfile[key],
      this[1]!.densityProfile[key],
      this[2]!.densityProfile[key],
      this[3]!.densityProfile[key]
    )
  }

  // Redundant, but need to avoid creating garbage here as this runs every frame
  /**
   * The three height ranges the march steps through, from the eight band
   * endpoints sorted and interval-coded. Bands may overlap and be out of order;
   * this returns the merged ranges, at most three of them
   */
  packIntervalHeights(minIntervals: Vector3, maxIntervals: Vector3): void {
    for (let i = 0; i < 4; ++i) {
      const layer = this[i]!
      let entry = entriesScratch[i]!
      entry.value = layer.altitude
      entry.flag = 0
      entry = entriesScratch[i + 4]!
      entry.value = layer.altitude + layer.height
      entry.flag = 1
    }
    entriesScratch.sort(compareEntries)

    // Reference: https://dilipkumar.medium.com/interval-coding-pattern-068c36197cf5
    let intervalIndex = 0
    let balance = 0
    for (let entryIndex = 0; entryIndex < entriesScratch.length; ++entryIndex) {
      const { value, flag } = entriesScratch[entryIndex]!
      if (balance === 0 && entryIndex > 0) {
        const interval = intervalsScratch[intervalIndex++]!
        interval.min = entriesScratch[entryIndex - 1]!.value
        interval.max = value
      }
      balance += flag === 0 ? 1 : -1
    }
    for (; intervalIndex < 3; ++intervalIndex) {
      const interval = intervalsScratch[intervalIndex]!
      interval.min = 0
      interval.max = 0
    }

    let interval = intervalsScratch[0]!
    minIntervals.x = interval.min
    maxIntervals.x = interval.max
    interval = intervalsScratch[1]!
    minIntervals.y = interval.min
    maxIntervals.y = interval.max
    interval = intervalsScratch[2]!
    minIntervals.z = interval.min
    maxIntervals.z = interval.max
  }
}
