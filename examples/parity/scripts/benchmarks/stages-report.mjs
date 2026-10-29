#!/usr/bin/env node
// Summarises a stages.mjs report: per case x size x arm, the frame
// time and each stage's MARGINAL cost (adjacent base - knockout), as the
// median over repetitions of each repetition's median, with the IQR
//
//   node stages-report.mjs <report.json> [--markdown]
import { readFile } from 'node:fs/promises'

import { clockStability } from './clock.mjs'

const [file, flag] = process.argv.slice(2)
if (!file)
  throw new Error('usage: stages-report.mjs <report.json> [--markdown]')
const report = JSON.parse(await readFile(file, 'utf8'))
if (!report.runs?.length) throw new Error('report has zero runs')

const median = v => {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const quantile = (v, q) => {
  const s = [...v].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}

// One repetition -> { frame, stages: { knockout label: marginal } }, in ms or,
// with value = probe units, each frame over the ALU probe that followed it
const ms = f => f.ms
const units = f => f.ms / f.probeMs
const probed = run => run.frames.every(f => f.probeMs > 0)
function perRep(run, value = ms) {
  const frames = run.frames
  const base = median(frames.filter(f => f.mode === 'base').map(value))
  const ko = {}
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i]
    const prev = frames[i - 1]
    if (f.mode === 'base' || prev.mode !== 'base') continue
    // A knockout frame whose timestamps were partly unwritten cannot give a
    // frame envelope (it drops later passes); it is excluded, not guessed
    if (f.invalid) continue
    ;(ko[f.mode] ??= []).push(value(prev) - value(f))
  }
  const k = Object.fromEntries(
    Object.entries(ko).map(([m, v]) => [m, median(v)])
  )
  const endOrder = {}
  if (run.side === 'B') {
    const bases = frames.filter(f => f.mode === 'base' && f.stages)
    const keys = new Set(bases.flatMap(f => Object.keys(f.stages)))
    for (const key of keys)
      endOrder[key] = median(
        bases.map(f => ((f.stages[key] ?? 0) * value(f)) / f.ms)
      )
  }
  const z = x => x ?? 0
  const rows =
    run.side === 'A'
      ? {
          scene: z(k.scene),
          shadow: z(k.shadowMap) + z(k.shadowResolve),
          march: z(k.march),
          cloudsResolve: z(k.cloudsResolve),
          'composite+output':
            z(k.composite) -
            z(k.shadowMap) -
            z(k.shadowResolve) -
            z(k.march) -
            z(k.cloudsResolve) +
            z(k.output)
        }
      : {
          // B's scene knockout empties the Stars/Background/ground draws and
          // leaves unwritten timestamps that drop the composite from the
          // envelope, so the end-order estimate is used instead
          scene: z(endOrder.scene),
          shadow: z(k.shadowMap) + z(k.shadowVelocity) + z(k.shadowResolve),
          march: z(k.march),
          cloudsResolve: z(k.cloudsResolve),
          'composite+output': z(k.composite)
        }
  rows.unattributed = base - Object.values(rows).reduce((a, b) => a + b, 0)
  return { frame: base, rows, endOrder }
}

// The ramp guard runs on each repetition's base frames (clock.mjs)
const groups = new Map()
for (const run of report.runs) {
  const key = `${run.case}|${run.width}x${run.height}|${run.arm}`
  const g = groups.get(key) ?? []
  const bases = run.frames.filter(f => f.mode === 'base')
  g.push({
    ...perRep(run),
    units: probed(run) ? perRep(run, units) : null,
    clock: clockStability(
      bases.map(ms),
      probed(run) ? bases.map(f => f.probeMs) : null
    ),
    rep: run.rep
  })
  groups.set(key, g)
}
const ROWS = [
  'frame',
  'march',
  'composite+output',
  'shadow',
  'cloudsResolve',
  'scene',
  'unattributed'
]
const cell = v =>
  `${median(v).toFixed(2)} [${quantile(v, 0.25).toFixed(2)}-${quantile(v, 0.75).toFixed(2)}]`
const summary = []
for (const [key, reps] of groups) {
  const [caseName, size, arm] = key.split('|')
  const values = Object.fromEntries(
    ROWS.map(r => [r, reps.map(x => (r === 'frame' ? x.frame : x.rows[r]))])
  )
  // clock probes per repetition, and A's second (time-clustered)
  // state, which the ALU probe does not see: repetitions whose frame medians
  // differ by more than 10 % are flagged, never blended silently
  const clocks = report.runs
    .filter(r => `${r.case}|${r.width}x${r.height}|${r.arm}` === key)
    .map(r => r.clock)
    .filter(Boolean)
  const frames = values.frame
  const bimodal = Math.max(...frames) / Math.min(...frames) > 1.1
  const unitValues = reps.every(x => x.units)
    ? Object.fromEntries(
        ROWS.map(r => [
          r,
          reps.map(x => (r === 'frame' ? x.units.frame : x.units.rows[r]))
        ])
      )
    : null
  summary.push({
    bimodal,
    unstable: reps
      .filter(x => !x.clock.stable)
      .map(x => ({ rep: x.rep, reasons: x.clock.reasons })),
    unitsMedian: unitValues
      ? Object.fromEntries(ROWS.map(r => [r, median(unitValues[r])]))
      : null,
    unitsCells: unitValues
      ? Object.fromEntries(ROWS.map(r => [r, cell(unitValues[r])]))
      : null,
    clock: clocks.length
      ? {
          aluAfterHeat: median(clocks.map(c => c.aluAfterHeat)),
          aluAfter: median(clocks.map(c => c.aluAfter)),
          bwAfter: median(clocks.map(c => c.bwAfter))
        }
      : null,
    case: caseName,
    size,
    arm,
    n: reps.length,
    median: Object.fromEntries(ROWS.map(r => [r, median(values[r])])),
    cells: Object.fromEntries(ROWS.map(r => [r, cell(values[r])]))
  })
}

const counts = report.counts ?? []
if (flag === '--markdown') {
  const bySize = new Map()
  for (const s of summary) {
    const k = `${s.case} @ ${s.size}`
    ;(bySize.get(k) ?? bySize.set(k, []).get(k)).push(s)
  }
  for (const [k, list] of bySize) {
    const a = list.find(s => s.arm === 'A')
    console.log(`\n#### ${k}\n`)
    console.log(
      `| stage | ${list.map(s => `${s.arm} (n=${s.n})`).join(' | ')} |`
    )
    console.log(`|---|${list.map(() => '---').join('|')}|`)
    for (const r of ROWS)
      console.log(`| ${r} | ${list.map(s => s.cells[r]).join(' | ')} |`)
    if (list.some(s => s.clock))
      console.log(
        `| clock alu heat/after, bw after | ${list.map(s => (s.clock ? `${s.clock.aluAfterHeat.toFixed(3)}/${s.clock.aluAfter.toFixed(3)}, ${s.clock.bwAfter.toFixed(3)}` : '-')).join(' | ')} |`
      )
    if (list.every(s => s.unitsCells)) {
      for (const r of ROWS)
        console.log(
          `| ${r}, probe units | ${list.map(s => s.unitsCells[r]).join(' | ')} |`
        )
      if (a)
        console.log(
          `| **B/A frame, probe units** | ${list.map(s => (s.unitsMedian.frame / a.unitsMedian.frame).toFixed(2) + 'x').join(' | ')} |`
        )
    }
    if (list.some(s => s.unstable.length))
      console.log(
        `| **UNSTABLE CLOCK (reps)** | ${list.map(s => (s.unstable.length ? `${s.unstable.length}/${s.n}: ${s.unstable[0].reasons.join(', ')}` : '')).join(' | ')} |`
      )
    if (list.some(s => s.bimodal))
      console.log(
        `| **BIMODAL (reps >10% apart)** | ${list.map(s => (s.bimodal ? 'YES' : '')).join(' | ')} |`
      )
    if (a)
      console.log(
        `| **B/A frame** | ${list.map(s => (s.median.frame / a.median.frame).toFixed(2) + 'x').join(' | ')} |`
      )
    const [c, sz] = k.split(' @ ')
    const [w, h] = sz.split('x').map(Number)
    const cs = counts.filter(
      x => x.case === c && x.width === w && x.height === h
    )
    for (const x of cs)
      console.log(
        `\ncounts ${x.side}: per march pixel steps ${x.perPixel.steps.toFixed(3)}, shape ${x.perPixel.shape.toFixed(3)}, detail ${x.perPixel.detail.toFixed(3)} (${x.width}x${x.height}, ${x.marchedPixels} marched px)`
      )
  }
} else console.log(JSON.stringify({ summary, counts }, null, 1))
