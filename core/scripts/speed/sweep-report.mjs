// Tables for a sweep.mjs report: per scene, each arm's frame GPU ms at the
// fast clock (frame / probe x 0.40 ms), median over repetitions with the
// range, ms saved against `base`, and the passes the saving comes from
// Usage: node core/scripts/speed/sweep-report.mjs sweep.json [--markdown]
import { readFileSync } from 'node:fs'

import { median, PROBE_FAST_MS } from './sweepArgs.mjs'

// three labels its pipelines per build: keep the stable stem
const stem = label =>
  label.replace(/^renderPipeline_|^computePipeline_/, '').replace(/_\d+$/, '')

// Per run: frame and per-pass fast-clock ms, each frame over its own probe
// A pass absent from some frames (shadow updateInterval 2) costs the MEAN over
// all frames, an absent frame counting as 0
export function perRun(run) {
  const perFrame = run.timed.passList.map((list, f) => {
    const sums = {}
    for (const p of list) {
      const k = stem(p.label)
      sums[k] = (sums[k] ?? 0) + p.exclusive
    }
    for (const k of Object.keys(sums))
      sums[k] = (sums[k] / run.timed.probeMs[f]) * PROBE_FAST_MS
    return sums
  })
  const keys = [...new Set(perFrame.flatMap(s => Object.keys(s)))]
  const mean = v => v.reduce((a, b) => a + b, 0) / v.length
  return {
    frame: run.clock.unitsMedian * PROBE_FAST_MS,
    passes: Object.fromEntries(
      keys.map(k => [k, mean(perFrame.map(s => s[k] ?? 0))])
    )
  }
}

// Rows per scene: base first is not assumed, the arm called `base` is the
// reference and an arm's saving is the base's frame minus its own
export function reduce(report) {
  const ok = report.runs.filter(
    r => !r.failed && !r.errors?.length && r.timed != null
  )
  const bad = report.runs.filter(r => r.failed || r.errors?.length)
  const scenes = [...new Set(ok.map(r => r.case))]
  const result = {}
  for (const scene of scenes) {
    const arms = {}
    for (const r of ok.filter(x => x.case === scene))
      (arms[r.arm] ??= []).push({
        ...perRun(r),
        stable: r.clock.stable,
        applied: r.applied
      })
    const base = arms.base
    if (base == null) continue
    const baseFrame = median(base.map(x => x.frame))
    const basePass = k => median(base.map(x => x.passes[k] ?? 0))
    result[scene] = Object.entries(arms)
      .map(([arm, reps]) => {
        const frames = reps.map(x => x.frame)
        const keys = [...new Set(reps.flatMap(x => Object.keys(x.passes)))]
        const passDelta = Object.fromEntries(
          keys
            .map(k => [
              k,
              basePass(k) - median(reps.map(x => x.passes[k] ?? 0))
            ])
            .filter(([, d]) => Math.abs(d) >= 0.1)
            .sort((a, b) => b[1] - a[1])
        )
        return {
          arm,
          n: reps.length,
          frame: median(frames),
          range: [Math.min(...frames), Math.max(...frames)],
          saved: baseFrame - median(frames),
          savedShare: 1 - median(frames) / baseFrame,
          passDelta,
          unstable: reps.filter(x => !x.stable).length,
          graphVersions: [...new Set(reps.map(x => x.applied?.graphVersion))]
            .length
        }
      })
      .sort((a, b) => b.saved - a.saved)
  }
  return { result, bad: bad.length }
}

export function markdown({ result, bad }) {
  const lines = []
  if (bad > 0) lines.push(`${bad} arm runs failed or logged errors (excluded).`)
  for (const [scene, rows] of Object.entries(result)) {
    lines.push(`\n#### ${scene}\n`)
    lines.push(
      '| arm | frame ms | range | saved ms | saved | from passes (ms saved) | unstable |'
    )
    lines.push('|---|---|---|---|---|---|---|')
    for (const r of rows)
      lines.push(
        `| ${r.arm} | ${r.frame.toFixed(2)} | ${r.range[0].toFixed(2)}-${r.range[1].toFixed(2)} | ${r.saved.toFixed(2)} | ${(100 * r.savedShare).toFixed(0)} % | ${Object.entries(
          r.passDelta
        )
          .map(([k, d]) => `${k} ${d.toFixed(2)}`)
          .join(', ')} | ${r.unstable}/${r.n} |`
      )
  }
  return lines.join('\n')
}

// vsync reports carry a loop result rather than sampled frames: the frame
// rate the display showed, the frames it missed, and the longest interval
export function reduceVsync(report) {
  // a loop result only: a timed run has no fps to report, and reading one as
  // zero would state a frame rate nobody measured
  const ok = report.runs.filter(
    r => !r.failed && !r.errors?.length && r.vsync != null
  )
  const bad = report.runs.length - ok.length
  const scenes = [...new Set(ok.map(r => r.case))]
  const result = {}
  for (const scene of scenes) {
    const arms = {}
    for (const r of ok.filter(x => x.case === scene))
      (arms[r.arm] ??= []).push(r.vsync)
    result[scene] = Object.entries(arms)
      .map(([arm, reps]) => ({
        arm,
        n: reps.length,
        fps: median(reps.map(x => x.fps)),
        displayHz: median(reps.map(x => x.displayHz)),
        dropped: median(reps.map(x => x.dropped)),
        droppedShare: median(reps.map(x => x.droppedShare)),
        longestMs: Math.max(...reps.map(x => x.longestMs))
      }))
      .sort((a, b) => b.fps - a.fps)
  }
  return { result, bad }
}

export function markdownVsync({ result, bad }) {
  const lines = []
  if (bad > 0) lines.push(`${bad} arm runs failed or logged errors (excluded).`)
  for (const [scene, rows] of Object.entries(result)) {
    lines.push(`\n#### ${scene}\n`)
    lines.push(
      '| arm | fps | display Hz | dropped frames | dropped | longest interval ms |'
    )
    lines.push('|---|---|---|---|---|---|')
    for (const r of rows)
      lines.push(
        `| ${r.arm} | ${r.fps.toFixed(1)} | ${r.displayHz.toFixed(0)} | ${r.dropped.toFixed(0)} | ${(100 * r.droppedShare).toFixed(1)} % | ${r.longestMs.toFixed(1)} |`
      )
  }
  return lines.join('\n')
}

// Reuse for the tests, and a plain CLI when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2]
  if (file == null) throw new Error('usage: sweep-report.mjs <sweep.json>')
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const vsync = report.method?.vsync === true
  const reduced = vsync ? reduceVsync(report) : reduce(report)
  console.log(
    process.argv.includes('--markdown')
      ? vsync
        ? markdownVsync(reduced)
        : markdown(reduced)
      : JSON.stringify(reduced.result, null, 1)
  )
}
