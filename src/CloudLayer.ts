// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { DensityProfile, type DensityProfileLike } from './DensityProfile'

const paramKeys = [
  'channel',
  'altitude',
  'height',
  'densityScale',
  'shapeAmount',
  'shapeDetailAmount',
  'weatherExponent',
  'shapeAlteringBias',
  'coverageFilterWidth',
  'shadow',
  'densityProfile'
] as const

/**
 * The shape of the per-layer options object accepted by {@link CloudLayer} and
 * {@link CloudLayers}. Every key is optional; an absent key keeps the current
 * value, so a partial object is a patch rather than a replacement.
 */
export interface CloudLayerLike extends Partial<
  Pick<CloudLayer, Exclude<(typeof paramKeys)[number], 'densityProfile'>>
> {
  /** Partial coefficient patch, omitted or nullish values keep current values */
  densityProfile?: DensityProfileLike
}

function applyOptions(target: CloudLayer, params?: CloudLayerLike): void {
  if (params == null) {
    return
  }
  for (const key of paramKeys) {
    const value = params[key]
    if (value == null) {
      continue
    }
    if (key === 'densityProfile') {
      const profile = params.densityProfile
      const current = target.densityProfile
      current.set(
        profile?.expTerm ?? current.expTerm,
        profile?.exponent ?? current.exponent,
        profile?.linearTerm ?? current.linearTerm,
        profile?.constantTerm ?? current.constantTerm
      )
    } else {
      // TypeScript cannot correlate target[key] with params[key] across the
      // key union (microsoft/TypeScript#32693), so the write goes through a
      // keyed record view. `key` comes from paramKeys, so it always exists.
      ;(target as Record<(typeof paramKeys)[number], unknown>)[key] = value
    }
  }
}

/**
 * Which channel of the local weather texture one layer reads. The four layers
 * default to `r`, `g`, `b` and `a`, so a two-channel weather map still gives
 * two independent layers.
 */
export type TextureChannel = 'r' | 'g' | 'b' | 'a'

/**
 * One of the four cloud layers. A layer owns a height band, the shape and
 * weather weights inside it, and whether it casts a cloud shadow. Four of them
 * are packed into the uniforms every frame and read in one march, so the count
 * is fixed.
 *
 * Altitude and height are in metres, like the scene's world-space distances
 *
 * @remarks
 * Domain: four fixed slots per context, positive height activates a slot
 * Mutation: numeric values are uniforms, structural changes rebuild the graph
 * Ownership: the containing context owns its cloned layers, not GPU resources
 */
export class CloudLayer {
  /** The all-defaults layer every other layer starts from */
  static readonly DEFAULT = /*#__PURE__*/ new CloudLayer()

  /** Local weather channel this layer reads */
  channel: TextureChannel = 'r'

  /** Height of the band's base above the bottom radius, in metres */
  altitude = 0

  /** Thickness of the band, in metres. 0 leaves the lane empty */
  height = 0

  /** Weight of this layer's density in the march */
  densityScale = 0.2

  /** Weight of the base shape noise */
  shapeAmount = 1

  /**
   * Weight of the high-frequency detail noise. Ignored when
   * `CloudsContext.shapeDetail` is off
   */
  shapeDetailAmount = 1

  /** Exponent applied to the weather channel. 1 keeps it unchanged */
  weatherExponent = 1

  /**
   * Bias on the shape-altering parabola, which moves density toward the middle
   * of the band
   */
  shapeAlteringBias = 0.35

  /**
   * Width of the soft ramp where weather crosses the coverage threshold. 0 cuts
   * hard
   */
  coverageFilterWidth = 0.6

  /** Vertical density distribution inside the band */
  densityProfile = new DensityProfile(0, 0, 0.75, 0.25)

  /**
   * Whether this layer casts into the cloud shadow map. Changing whether any
   * layer casts shadows changes the compiled graph
   */
  shadow = false

  /** Build a layer, optionally patching over the defaults */
  constructor(options?: CloudLayerLike) {
    this.set(options)
  }

  /** Patch this layer from a partial object, skipping absent keys */
  set(options?: CloudLayerLike): this {
    applyOptions(this, options)
    return this
  }

  /** A new layer with the same values, density profile copied */
  clone(): CloudLayer {
    return new CloudLayer(this)
  }

  /** Copy every value from another layer, density profile included */
  copy(other: CloudLayer): this {
    this.channel = other.channel
    this.altitude = other.altitude
    this.height = other.height
    this.densityScale = other.densityScale
    this.shapeAmount = other.shapeAmount
    this.shapeDetailAmount = other.shapeDetailAmount
    this.weatherExponent = other.weatherExponent
    this.shapeAlteringBias = other.shapeAlteringBias
    this.coverageFilterWidth = other.coverageFilterWidth
    this.densityProfile.copy(other.densityProfile)
    this.shadow = other.shadow
    return this
  }
}
