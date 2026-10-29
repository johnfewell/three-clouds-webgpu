import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const cli = resolve('examples/parity/scripts/benchmarks/stages-report.mjs')

// A repetition alternates base and march-knockout frames, as stages.mjs
// records them. Work is in probe units, the clock sets the ms
function rep(
  arm: string,
  index: number,
  { probe = 0.4, rampFrom = Infinity, frames = 30 } = {}
) {
  const out = []
  for (let f = 0; f < 2 * frames; f++) {
    const base = f % 2 === 0
    const clock = f >= rampFrom ? probe * 2 : probe
    const work = base ? 100 : 60
    out.push({
      mode: base ? 'base' : 'march',
      ms: work * clock,
      skipped: base ? 0 : 1,
      probeMs: clock
    })
  }
  return {
    case: 'sky-horizon-low-sun',
    width: 2560,
    height: 1440,
    arm,
    rep: index,
    side: 'A',
    frames: out,
    clock: { aluAfterHeat: 0.4, aluAfter: 0.4, bwAfter: 0.65 }
  }
}

function report(runs: ReturnType<typeof rep>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'stages-report-'))
  const file = join(dir, 'report.json')
  writeFileSync(file, JSON.stringify({ runs, counts: [] }))
  const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as {
    summary: {
      arm: string
      median: Record<string, number>
      unitsMedian: Record<string, number> | null
      unstable: { rep: number; reasons: string[] }[]
    }[]
  }
}

describe('stages-report clock control', () => {
  // A repetition caught in the slow clock state doubles every ms value. In ms
  // the march marginal moves with it, in probe units it does not
  it('reports marginals in probe units that cancel a clock state', () => {
    const { summary } = report([
      rep('A', 0),
      rep('A', 1, { probe: 0.8 }),
      rep('A', 2)
    ])
    const a = summary[0]!
    log('march marginal', [{ ms: a.median.march, units: a.unitsMedian?.march }])
    expect(a.unitsMedian?.march).toBeCloseTo(40, 6)
    expect(a.unstable).toEqual([])
  })

  it('flags the repetition whose clock changed mid-run', () => {
    const { summary } = report([rep('A', 0), rep('A', 1, { rampFrom: 30 })])
    const a = summary[0]!
    log('unstable', a.unstable)
    expect(a.unstable.map(u => u.rep)).toEqual([1])
    expect(a.unstable[0]!.reasons.join()).toMatch(/ramped 2\.00x/)
  })

  it('still reads an old report without per-frame probes', () => {
    const old = rep('A', 0)
    old.frames.forEach(f => delete (f as { probeMs?: number }).probeMs)
    const { summary } = report([old])
    expect(summary[0]!.unitsMedian).toBeNull()
    expect(summary[0]!.median.march).toBeCloseTo(16, 6)
  })
})
