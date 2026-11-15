// Compose a complete verdict from the metric verdict and the hard receipts
// One definition for the capture runner, the committed-results verifier and the
// consumer conformance test, so the three cannot drift apart
// Cite: ADR-011 Amendment 6 (a receipt that fails is a fail whatever SSIM says)

/**
 * The reasons a shaded-fraction receipt contributes. Empty when the block is
 * absent, declared not applicable (`skipped`), or passed
 */
export function shadedFractionReasons(sf) {
  if (sf == null || typeof sf !== 'object') return []
  if (typeof sf.skipped === 'string' && sf.skipped.length > 0) return []
  if (sf.error) {
    return [`shaded-fraction receipt could not be taken: ${sf.error}`]
  }
  return [...(sf.reasons ?? [])]
}

/**
 * The reasons an atlas-channel receipt contributes. An error is the
 * capture's own `error` string, otherwise the receipt's recorded reasons
 */
export function atlasChannelReasons(ac) {
  if (ac == null || typeof ac !== 'object') return []
  if (ac.error) {
    return [`atlas-channel receipt could not be taken: ${ac.error}`]
  }
  return [...(ac.reasons ?? [])]
}

/**
 * The metric verdict with the hard receipts appended in capture order:
 * shaded-fraction first, then atlas-channel. Any receipt reason forces FAIL.
 *
 * `derive` re-reads a receipt's reasons from its own fields, which is what
 * the committed-results verifier does for evidence it did not take itself.
 * Omit it for an in-memory receipt whose reasons the capture already built
 */
export function composeVerdict(metricVerdict, receipts, derive = {}) {
  const ordered = [
    derive.shadedFraction ?? shadedFractionReasons,
    derive.atlasChannel ?? atlasChannelReasons
  ]
  const reasons = [...metricVerdict.reasons]
  let result = metricVerdict.result
  const blocks = [receipts?.shadedFraction, receipts?.atlasChannels]
  blocks.forEach((block, i) => {
    const extra = ordered[i](block)
    if (extra.length > 0) {
      reasons.push(...extra)
      result = 'fail'
    }
  })
  return { result, reasons }
}
