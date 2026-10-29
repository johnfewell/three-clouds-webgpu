// The N-layer configuration both sides build from
// The rendered default is THREE layers (the fourth DEFAULT slot has zero
// height), so BASE_STATE.layers = 3 keeps the ladder. The reference has no
// layer count: `layers: N` and the fourth layer's values are a HARNESS choice,
// identical on both sides, not ported behaviour

export interface ParityLayerConfig {
  readonly channel: 'r' | 'g' | 'b' | 'a'
  readonly altitude: number
  readonly height: number
  readonly densityScale: number
  readonly shapeAmount: number
  readonly shapeDetailAmount: number
  readonly weatherExponent: number
  readonly shapeAlteringBias: number
  readonly coverageFilterWidth: number
  readonly shadow: boolean
}

// Entries 0-2 are CloudLayers.DEFAULT verbatim (src/CloudLayers.ts:34)
// Entry 3 is the harness addition described above
export const PARITY_LAYER_SET: readonly ParityLayerConfig[] = [
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
    coverageFilterWidth: 0.5,
    shadow: false
  },
  // HARNESS-INVENTED (the reference leaves this slot empty). Modelled on the
  // thin, sparse 'b' cirrus, so it is visible but not dominant, and it spans a
  // THIRD gap (7500+500 -> 12000), which is what case 27 is for
  {
    channel: 'a',
    altitude: 12000,
    height: 400,
    densityScale: 0.002,
    shapeAmount: 0.4,
    shapeDetailAmount: 0,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.5,
    shadow: false
  }
]

// CloudLayer's own field defaults (src/CloudLayer.ts:52-60), used to blank an
// inactive slot to a known state rather than leaving the previous case's values
const CLOUD_LAYER_DEFAULTS = {
  densityScale: 0.2,
  shapeAmount: 1,
  shapeDetailAmount: 1,
  weatherExponent: 1,
  shapeAlteringBias: 0.35,
  coverageFilterWidth: 0.6
} as const

/** What the library renders with no case override: see fact 1 above */
export const DEFAULT_ACTIVE_LAYERS = 3

export const MAX_LAYERS = PARITY_LAYER_SET.length

// A layer slot, structurally: side A's CloudLayer comes from the reference
// package and side B's from the port, and only the shared fields are touched
export interface MutableLayer {
  channel: string
  altitude: number
  height: number
  densityScale: number
  shapeAmount: number
  shapeDetailAmount: number
  weatherExponent: number
  shapeAlteringBias: number
  coverageFilterWidth: number
  shadow: boolean
}

/**
 * Writes the first `count` configs into the slots and NEUTRALISES the rest.
 *
 * Deactivating is height 0, not densityScale 0: the march skips an interval
 * whose min and max heights coincide, so a zero-height layer costs nothing,
 * whereas a zero-density one still walks the interval. That also matches how
 * the reference's own empty fourth slot reads.
 */
export function applyLayerSet(
  layers: ArrayLike<MutableLayer>,
  count: number
): void {
  const active = Math.max(0, Math.min(count, MAX_LAYERS))
  for (let i = 0; i < layers.length; i++) {
    const slot = layers[i]
    if (slot == null) continue
    const config = i < active ? PARITY_LAYER_SET[i] : undefined
    if (config != null) {
      slot.channel = config.channel
      slot.altitude = config.altitude
      slot.height = config.height
      slot.densityScale = config.densityScale
      slot.shapeAmount = config.shapeAmount
      slot.shapeDetailAmount = config.shapeDetailAmount
      slot.weatherExponent = config.weatherExponent
      slot.shapeAlteringBias = config.shapeAlteringBias
      slot.coverageFilterWidth = config.coverageFilterWidth
      slot.shadow = config.shadow
    } else {
      // FULL reset, not just the heights, so the state is a pure function of
      // `count`. A stale channel from an earlier case would bump graphVersion
      // spuriously and could leave the two sides with different channels
      const canonical = PARITY_LAYER_SET[i]
      slot.channel = canonical?.channel ?? 'a'
      slot.altitude = 0
      slot.height = 0
      slot.densityScale = CLOUD_LAYER_DEFAULTS.densityScale
      slot.shapeAmount = CLOUD_LAYER_DEFAULTS.shapeAmount
      slot.shapeDetailAmount = CLOUD_LAYER_DEFAULTS.shapeDetailAmount
      slot.weatherExponent = CLOUD_LAYER_DEFAULTS.weatherExponent
      slot.shapeAlteringBias = CLOUD_LAYER_DEFAULTS.shapeAlteringBias
      slot.coverageFilterWidth = CLOUD_LAYER_DEFAULTS.coverageFilterWidth
      slot.shadow = false
    }
  }
}
