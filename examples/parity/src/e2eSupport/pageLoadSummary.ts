// What a parity page looked like when it failed to publish window.__parity
// Pure data and formatting. The Playwright side that fills it in is
// e2e/pageLoad.ts. Kept here so vitest collects its tests (it does not collect
// e2e/)

export interface PageStateSnapshot {
  readonly visibilityState: string
  readonly hasFocus: boolean
  readonly parityPublished: boolean
  /** requestAnimationFrame callbacks seen since navigation */
  readonly rafCount: number
  /** The same counter read again after rafProbeMs */
  readonly rafCountAfterProbe: number
  readonly rafProbeMs: number
  readonly visibilityChanges: readonly (readonly [number, string])[]
  readonly gpu: {
    readonly devicesRequested: number
    readonly lost: { readonly reason: string; readonly message: string } | null
    readonly uncapturedErrors: readonly string[]
  }
}

export interface PageLoadSnapshot {
  readonly caseName: string | null
  readonly url: string
  readonly msSinceNavigation: number | null
  /** The last `[parity][...]` boot line the page logged, if any */
  readonly lastBootStage: string | null
  readonly consoleErrors: readonly string[]
  readonly pendingRequests: readonly {
    readonly url: string
    readonly ageMs: number
  }[]
  /** null when the page did not answer an evaluate within the budget */
  readonly page: PageStateSnapshot | null
}

/** The most specific explanation the snapshot supports, most severe first */
export function likelyStall(s: PageLoadSnapshot): string {
  if (s.page == null) {
    return 'page did not answer evaluate: main thread busy or hung'
  }
  if (s.page.gpu.lost != null) {
    return `GPU device lost (${s.page.gpu.lost.reason}): ${s.page.gpu.lost.message}`
  }
  if (s.page.parityPublished) {
    return 'window.__parity is now published: boot finished late, not hung'
  }
  if (s.page.rafCountAfterProbe === s.page.rafCount) {
    return `requestAnimationFrame is not firing (visibility ${s.page.visibilityState}): the 64-frame boot warm-up cannot finish`
  }
  if (s.pendingRequests.length > 0) {
    return `${s.pendingRequests.length} network request(s) still pending`
  }
  if (s.lastBootStage == null) {
    return 'no boot stage logged: the harness module did not start'
  }
  return `boot stuck after: ${s.lastBootStage}`
}

export function formatPageLoadSummary(s: PageLoadSnapshot): string {
  const lines = [
    `likely: ${likelyStall(s)}`,
    `case: ${s.caseName ?? '(none)'}  url: ${s.url}`,
    `ms since navigation: ${s.msSinceNavigation ?? 'unknown'}`,
    `last boot stage: ${s.lastBootStage ?? '(none logged)'}`
  ]
  if (s.page == null) {
    lines.push('page state: unavailable (evaluate timed out)')
  } else {
    const p = s.page
    const rafRate = ((p.rafCountAfterProbe - p.rafCount) * 1000) / p.rafProbeMs
    lines.push(
      `visibility: ${p.visibilityState}  hasFocus: ${p.hasFocus}  __parity: ${p.parityPublished ? 'published' : 'missing'}`,
      `rAF: ${p.rafCount} callbacks since navigation, ${rafRate.toFixed(1)}/s over the last ${p.rafProbeMs} ms`,
      `visibility changes: ${p.visibilityChanges.length === 0 ? 'none' : p.visibilityChanges.map(([t, v]) => `${Math.round(t)}ms ${v}`).join(', ')}`,
      `GPU: ${p.gpu.devicesRequested} device(s) requested, lost: ${p.gpu.lost == null ? 'no' : `${p.gpu.lost.reason} ${p.gpu.lost.message}`}, uncaptured errors: ${p.gpu.uncapturedErrors.length}`
    )
    for (const e of p.gpu.uncapturedErrors) lines.push(`  gpu error: ${e}`)
  }
  lines.push(`pending requests: ${s.pendingRequests.length}`)
  for (const r of s.pendingRequests) {
    lines.push(`  ${r.url} (${Math.round(r.ageMs)} ms)`)
  }
  lines.push(`console errors: ${s.consoleErrors.length}`)
  for (const e of s.consoleErrors) lines.push(`  ${e}`)
  return lines.join('\n')
}
