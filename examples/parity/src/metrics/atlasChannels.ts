// Atlas channel-agreement receipt. A packed plate's SSIM follows
// the largest channel, including one no consumer reads
// Cite: ADR-011 Amendment 6 (judge the quantity, then the plate)
// Cite: clouds.frag:279-293, DEBUG_SHOW_SHADOW_MAP
// vec3(frontDepth * 1e-5, meanExtinction * 10, (maxOpticalDepth + tail) * 0.01)
export const ATLAS_CHANNELS = ['r', 'g', 'b'] as const

export type AtlasChannel = (typeof ATLAS_CHANNELS)[number]

export interface AtlasChannelMeans {
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface AtlasChannelGate {
  /** The channels that decide rendering, and therefore the gated ones */
  readonly channels: readonly AtlasChannel[]
  /** Max tolerated |B.mean / A.mean − 1| on each gated channel */
  readonly tolerance: number
  /** Why the ungated channels are ungated. Travels with the evidence */
  readonly reason: string
}

export interface AtlasChannelReceipt {
  readonly A: AtlasChannelMeans
  readonly B: AtlasChannelMeans
  /**
   * B.mean / A.mean for all three, measured even where not gated, so an
   * ungated channel's divergence stays visible in metrics.json
   */
  readonly ratio: Readonly<Record<AtlasChannel, number>>
  /** |ratio − 1| */
  readonly deviation: Readonly<Record<AtlasChannel, number>>
  readonly gated: readonly AtlasChannel[]
  readonly tolerance: number
  readonly reasons: readonly string[]
}

function mean(
  buf: Float32Array,
  width: number,
  height: number,
  channels: number,
  offset: number
): number {
  const n = width * height
  if (!(n > 0)) {
    throw new Error(`atlas channel means need a non-empty plate, got ${n} px`)
  }
  // A short buffer would sum a prefix and report it as the mean, which reads
  // as a real number. Refuse instead
  if (buf.length < n * channels) {
    throw new Error(
      `atlas channel plate truncated: ${buf.length} floats for ${n} px × ${channels}`
    )
  }
  let sum = 0
  for (let i = 0; i < n; i++) sum += buf[i * channels + offset]!
  return sum / n
}

/**
 * Per-channel means of a linear RGBA plate. No gate and no tolerance: this is
 * the measurement, and it is measured for every channel whether or not a case
 * gates it.
 */
export function computeAtlasChannelMeans(
  buf: Float32Array,
  width: number,
  height: number,
  channels = 4
): AtlasChannelMeans {
  return {
    r: mean(buf, width, height, channels, 0),
    g: mean(buf, width, height, channels, 1),
    b: mean(buf, width, height, channels, 2)
  }
}

/**
 * Build the receipt and its reasons together, so a receipt cannot exist
 * without the verdict that was computed for it.
 *
 * A gated channel whose mean is not positive on BOTH sides is refused, not
 * divided: a zero mean is an absent quantity, and 0/0 silently becoming NaN
 * (or Infinity against a nonzero side) would let an empty derivation pass as a
 * measurement.
 */
export function buildAtlasChannelReceipt(
  A: AtlasChannelMeans,
  B: AtlasChannelMeans,
  gate: AtlasChannelGate
): AtlasChannelReceipt {
  const ratio = {} as Record<AtlasChannel, number>
  const deviation = {} as Record<AtlasChannel, number>
  for (const c of ATLAS_CHANNELS) {
    ratio[c] = A[c] > 0 ? B[c] / A[c] : 0
    deviation[c] = Math.abs(ratio[c] - 1)
  }
  const reasons: string[] = []
  if (gate.channels.length === 0) {
    reasons.push(
      'atlas-channel receipt REFUSED: the case gated no channel, so nothing ' +
        'about the atlas is measured'
    )
  }
  for (const c of gate.channels) {
    for (const side of ['A', 'B'] as const) {
      if (!(side === 'A' ? A[c] > 0 : B[c] > 0)) {
        reasons.push(
          `atlas-channel receipt REFUSED: gated channel ${c} has mean ` +
            `${side === 'A' ? A[c] : B[c]} on side ${side}. A channel that ` +
            'carries no signal cannot be gated — gate a channel the view fills'
        )
      }
    }
  }
  if (reasons.length > 0) {
    return {
      A,
      B,
      ratio,
      deviation,
      gated: gate.channels,
      tolerance: gate.tolerance,
      reasons
    }
  }
  for (const c of gate.channels) {
    if (deviation[c] > gate.tolerance) {
      reasons.push(
        `atlas channel ${c}: B/A ${ratio[c].toFixed(4)} ` +
          `(deviation ${(deviation[c] * 100).toFixed(2)} % > ` +
          `${(gate.tolerance * 100).toFixed(2)} %) — ${gate.reason}`
      )
    }
  }
  return {
    A,
    B,
    ratio,
    deviation,
    gated: gate.channels,
    tolerance: gate.tolerance,
    reasons
  }
}

/**
 * Reasons the atlas-channel gate cannot be believed. EMPTY means it passed.
 * The same reasons `buildAtlasChannelReceipt` records, re-derived, so a caller
 * that loaded a receipt from metrics.json re-checks rather than trusts.
 */
export function evaluateAtlasChannelReceipt(
  receipt: AtlasChannelReceipt
): string[] {
  return [...receipt.reasons]
}

/** The one-line receipt for the capture log */
export function formatAtlasChannelReceipt(
  receipt: AtlasChannelReceipt
): string {
  return ATLAS_CHANNELS.map(
    c =>
      `${c} ${receipt.ratio[c].toFixed(4)}` +
      (receipt.gated.includes(c) ? '*' : '')
  ).join(' ')
}
