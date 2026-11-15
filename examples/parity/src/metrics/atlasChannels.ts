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
  /**
   * The case's own explanation of WHY the gated channels are gated
   * (cases/index.ts `atlasChannelGate.reason`), stored so a re-derivation of a
   * divergence line can carry the same sentence. Absent on receipts captured
   * before this field existed, which then fall back to their stored reason text
   */
  readonly reasonTail?: string
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
      reasonTail: gate.reason,
      reasons
    }
  }
  for (const c of gate.channels) {
    if (deviation[c] > gate.tolerance) {
      reasons.push(
        atlasChannelDivergenceReason(
          c,
          ratio[c],
          deviation[c],
          gate.tolerance,
          gate.reason
        )
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
    reasonTail: gate.reason,
    reasons
  }
}

/**
 * ONE wording for a gated channel's divergence, so the capture that records a
 * receipt and the verify-time re-derivation of that receipt cannot disagree
 * about a failure.
 *
 * `tail` is the case's own explanation of why the channel is gated. The numbers
 * are always the caller's: a re-derivation recomputes them from the stored
 * means, and only the explanatory sentence is carried across
 */
export function atlasChannelDivergenceReason(
  channel: AtlasChannel,
  ratio: number,
  deviation: number,
  tolerance: number,
  tail: string
): string {
  return (
    `atlas channel ${channel}: B/A ${ratio.toFixed(4)} ` +
    `(deviation ${(deviation * 100).toFixed(2)} % > ${(tolerance * 100).toFixed(2)} %) — ${tail}`
  )
}

/** The tail a re-derived line carries when no explanation is available */
export const ATLAS_DIVERGENCE_TAIL =
  'the channels that decide optical depth disagree'

/**
 * The explanatory tail a stored divergence line carries after its dash.
 *
 * The line also NAMES its channel and numbers, and those are checked against
 * the recomputed ones before their tail is trusted: a stale or mistyped
 * sentence whose channel or numbers disagree is REPORTED, never silently
 * carried, because the sentence would then describe a different failure
 */
export function carriedReasonTail(
  receipt: {
    gated?: readonly AtlasChannel[]
    reasons?: readonly string[]
  },
  channel: AtlasChannel,
  ratio: number,
  deviation: number
): { tail: string; conflict: string | null } {
  const lines = (receipt.reasons ?? []).filter(
    (text): text is string => typeof text === 'string' && text.length > 0
  )
  if (lines.length === 0) return { tail: ATLAS_DIVERGENCE_TAIL, conflict: null }
  // By its own name: a receipt with fewer lines than gated channels still
  // pairs, and a line naming ANOTHER channel is refused below rather than
  // read as "no sentence recorded"
  const byName = lines.find(text =>
    text.startsWith(`atlas channel ${channel}:`)
  )
  if (byName == null) {
    const first = lines[0] as string
    return {
      tail: ATLAS_DIVERGENCE_TAIL,
      conflict: refusal(
        first,
        channel,
        ratio,
        deviation,
        `names channel ${positionalName(first) ?? 'another one'}`
      )
    }
  }
  const line = byName
  const score = /^atlas channel (\w): B\/A (\d+\.\d+) \(deviation (\d+\.\d+) %/
  const scored = score.exec(line ?? '')
  // The stored sentence must describe THIS measurement before its explanation
  // can be carried: a renamed channel or a number that no longer recomputes is
  // reported as a refusal, never silently re-worded
  if (scored == null) {
    return {
      tail: ATLAS_DIVERGENCE_TAIL,
      conflict: refusal(
        line,
        channel,
        ratio,
        deviation,
        'is not a divergence line'
      )
    }
  }
  const [, named, storedRatio, storedDeviation] = scored
  if (named !== channel) {
    return {
      tail: ATLAS_DIVERGENCE_TAIL,
      conflict: refusal(
        line,
        channel,
        ratio,
        deviation,
        `names channel ${named}`
      )
    }
  }
  const numbers =
    storedRatio === ratio.toFixed(4) &&
    storedDeviation === (deviation * 100).toFixed(2)
  if (!numbers) {
    return {
      tail: ATLAS_DIVERGENCE_TAIL,
      conflict: refusal(
        line,
        channel,
        ratio,
        deviation,
        'records other numbers'
      )
    }
  }
  // The dash is searched from AFTER the scored prefix: the score itself
  // contains a dash-free em segment, but a tail may not
  const dash = (line ?? '').indexOf(' — ', scored[0].length)
  return {
    tail: dash < 0 ? ATLAS_DIVERGENCE_TAIL : (line ?? '').slice(dash + 3),
    conflict: null
  }
}

function positionalName(line: string): string | null {
  return /^atlas channel (\w):/.exec(line)?.[1] ?? null
}

function refusal(
  recorded: string | undefined,
  channel: AtlasChannel,
  ratio: number,
  deviation: number,
  why: string
): string {
  return (
    `atlas-channel receipt REFUSED: its stored ${channel} line ${why} ` +
    `(recorded "${recorded ?? ''}", the recomputed measurement is channel ` +
    `${channel} B/A ${ratio.toFixed(4)} deviation ${(deviation * 100).toFixed(2)} %)`
  )
}

/**
 * Reasons the atlas-channel gate cannot be believed. EMPTY means it passed.
 *
 * The rule and the numbers are RE-DERIVED from the stored means and tolerance,
 * so a stale verdict cannot pass by being written down. The one thing carried
 * from the stored line is the case's explanatory tail, because that sentence is
 * a per-case declaration (cases/index.ts) that metrics.json holds and the gate
 * declaration does not travel with the numbers
 */
export function evaluateAtlasChannelReceipt(
  receipt: AtlasChannelReceipt
): string[] {
  if (!Array.isArray(receipt.gated) || receipt.gated.length === 0) {
    return [
      'atlas-channel receipt REFUSED: the capture gated no channel, so ' +
        'nothing about the atlas was measured'
    ]
  }
  if (typeof receipt.tolerance !== 'number' || !(receipt.tolerance > 0)) {
    return [
      `atlas-channel receipt REFUSED: tolerance ${JSON.stringify(receipt.tolerance)} is not a positive fraction of the channel mean`
    ]
  }
  const refused: string[] = []
  for (const c of receipt.gated as AtlasChannel[]) {
    if (!(receipt.ratio?.[c] > 0)) {
      refused.push(
        `atlas-channel receipt REFUSED: gated channel ${c} has no signal on side A (ratio ${JSON.stringify(receipt.ratio?.[c])})`
      )
    }
  }
  if (refused.length > 0) return refused
  const reasons: string[] = []
  for (const c of receipt.gated as AtlasChannel[]) {
    // The measurement, not the stored ratio: B.mean / A.mean over the means
    // the receipt recorded, so an edited ratio cannot re-word the verdict
    const ratio =
      receipt.A[c] > 0 && receipt.B[c] > 0 ? receipt.B[c] / receipt.A[c] : 0
    const deviation = Math.abs(ratio - 1)
    if (!(deviation <= receipt.tolerance)) {
      const { tail, conflict } = carriedReasonTail(receipt, c, ratio, deviation)
      if (conflict != null) return [conflict]
      const declared = receipt.reasonTail
      reasons.push(
        atlasChannelDivergenceReason(
          c,
          ratio,
          deviation,
          receipt.tolerance,
          typeof declared === 'string' && declared.length > 0 ? declared : tail
        )
      )
    }
  }
  return reasons
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
