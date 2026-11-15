import type { EvalDetail } from './evaluator.mjs'

export interface ReceiptVerdict {
  result: EvalDetail['result']
  reasons: string[]
}

export interface ShadedFractionReceiptBlock {
  skipped?: string
  error?: string
  reasons?: readonly string[]
}

export interface AtlasChannelReceiptBlock {
  error?: string
  reasons?: readonly string[]
}

// A stored metrics.json holds these blocks as plain untyped JSON, so the
// composition accepts whatever the caller read back and the derivers decide
export interface ReceiptBlocks {
  shadedFraction?: unknown
  atlasChannels?: unknown
}

export interface ReceiptReasonDerivers {
  shadedFraction?: (receipt: unknown) => string[]
  atlasChannel?: (receipt: unknown) => string[]
}

export function shadedFractionReasons(
  receipt: ShadedFractionReceiptBlock | null | undefined
): string[]
export function atlasChannelReasons(
  receipt: AtlasChannelReceiptBlock | null | undefined
): string[]
export function composeVerdict(
  metricVerdict: EvalDetail,
  receipts: ReceiptBlocks | null | undefined,
  derive?: ReceiptReasonDerivers
): ReceiptVerdict
