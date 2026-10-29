import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const cli = resolve('examples/parity/scripts/benchmarks/compare.mjs')

function fixture(machine = 'm5') {
  const run = {
    caseName: 'sky-horizon-low-sun',
    width: 1920,
    height: 1080,
    workloadId: 'static-full',
    variantId: 'baseline',
    backend: 'webgpu',
    buildId: 'new',
    repetition: 0,
    orderIndex: 0,
    status: 'ok',
    settings: { temporalUpscale: false },
    samples: {
      gpuMs: [10, 12, 14],
      wallMs: [15, 20, 25],
      probeMs: [0.4, 0.4, 0.4]
    } as { gpuMs: number[]; wallMs: number[]; probeMs?: number[] },
    gpuUnavailableReason: undefined as string | undefined
  }
  return {
    schemaVersion: 1,
    protocolVersion: 'clouds-bench-v1',
    suiteHash: 'same-benchmark-instrument',
    machine: { label: machine, browser: 'Chrome pinned' },
    idleConfirmed: true,
    publishable: true,
    plan: { repeats: 2, sampleFrames: 3, seed: 1337 },
    builds: { old: { commit: 'old123' }, new: { commit: 'new456' } },
    runs: [run, { ...run, repetition: 1, orderIndex: 1 }]
  }
}

function invoke(reports: unknown[], output = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-benchmark-compare-'))
  const paths = reports.map((report, index) => {
    const path = join(dir, `${index}.json`)
    writeFileSync(path, JSON.stringify(report))
    return path
  })
  const out = join(dir, 'comparison')
  const result = spawnSync(
    process.execPath,
    [cli, ...(output ? ['--out', out] : []), ...paths],
    { encoding: 'utf8' }
  )
  return { ...result, out }
}

describe('portable benchmark report integrity', () => {
  it('compares identical workloads across machines without averaging FPS', () => {
    const first = fixture('m5')
    const second = fixture('nvidia')
    second.runs.forEach(run => {
      run.samples = { gpuMs: [5, 6, 7], wallMs: [8, 10, 12] }
    })
    const result = invoke([first, second], true)
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      rows: {
        gpu: { medianMs: number }
        speedupVsFirstMachine: number | null
      }[]
    }
    expect(parsed.rows[0]!.gpu.medianMs).toBe(12)
    expect(parsed.rows[1]!.speedupVsFirstMachine).toBe(2)
    expect(readFileSync(join(result.out, 'comparison.csv'), 'utf8')).toContain(
      'gpuMedianMs'
    )
    log('benchmark machine ratio', {
      expected: 2,
      actual: parsed.rows[1]!.speedupVsFirstMachine
    })
  })

  it('keeps missing GPU timers unavailable instead of using wall time', () => {
    const report = fixture()
    report.runs.forEach(run => {
      run.samples.gpuMs = []
      run.gpuUnavailableReason = 'timestamp-query unavailable'
    })
    const result = invoke([report])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      rows: { gpu: null; wall: { medianMs: number } }[]
    }
    expect(parsed.rows[0]!.gpu).toBeNull()
    expect(parsed.rows[0]!.wall.medianMs).toBe(20)
    log('benchmark unavailable GPU', parsed.rows[0]!)
  })

  it('does not score incomplete repetitions', () => {
    const report = fixture()
    report.runs.pop()
    const result = invoke([report])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      rows: { status: string; gpu: null; wall: null }[]
    }
    expect(parsed.rows[0]).toMatchObject({
      status: 'incomplete',
      gpu: null,
      wall: null
    })
    log('benchmark partial', parsed.rows[0]!)
  })

  it.each([
    'empty',
    'zero',
    'null',
    'duplicate',
    'unexplained missing GPU',
    'partial GPU',
    'partial wall'
  ])('rejects %s samples', problem => {
    const report = fixture()
    if (problem === 'empty') report.runs = []
    if (problem === 'zero') report.runs[0]!.samples.gpuMs = [0]
    if (problem === 'null') report.runs[0]!.samples.gpuMs = [NaN]
    if (problem === 'duplicate') report.runs.push(report.runs[0]!)
    if (problem === 'unexplained missing GPU')
      report.runs[0]!.samples.gpuMs = []
    if (problem === 'partial GPU') report.runs[0]!.samples.gpuMs.pop()
    if (problem === 'partial wall') report.runs[0]!.samples.wallMs.pop()
    const result = invoke([report])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[benchmark compare]')
    log('benchmark invalid samples', { problem, exit: result.status })
  })

  it.each(['plan', 'revision', 'protocol', 'label', 'instrument'])(
    'rejects incompatible %s',
    problem => {
      const first = fixture()
      const second = fixture('m1')
      if (problem === 'plan') second.plan.sampleFrames++
      if (problem === 'revision') second.builds.new.commit = 'different'
      if (problem === 'protocol') second.protocolVersion = 'different'
      if (problem === 'label') second.machine.label = 'm5'
      if (problem === 'instrument') second.suiteHash = 'different'
      const result = invoke([first, second])
      expect(result.status).toBe(1)
      log('benchmark incompatible inputs', { problem, exit: result.status })
    }
  )

  it('refuses zero input files', () => {
    const result = invoke([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage:')
  })

  it('reports validation-only runs and browser differences', () => {
    const first = fixture()
    const second = fixture('m4')
    second.idleConfirmed = false
    second.publishable = false
    second.machine.browser = 'Different Chrome'
    const result = invoke([first, second])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      warnings: string[]
      rows: { speedupVsFirstMachine: number | null }[]
    }
    expect(parsed.warnings).toHaveLength(2)
    expect(parsed.rows[1]!.speedupVsFirstMachine).toBeNull()
    log('benchmark warnings', { warnings: parsed.warnings })
  })
})

describe('clock-state control in comparisons', () => {
  type Report = ReturnType<typeof fixture>
  const withFrames = (report: Report, gpuMs: number[], probeMs?: number[]) => {
    report.plan.sampleFrames = gpuMs.length
    report.runs.forEach(run => {
      run.samples = { gpuMs, wallMs: gpuMs.map(ms => ms + 5), probeMs }
    })
    return report
  }
  const parse = (result: { stdout: string }) =>
    JSON.parse(result.stdout) as {
      warnings: string[]
      rows: {
        ratioBasis: string
        clock: { stable: boolean; normalised: boolean }
        speedupVsFirstMachine: number | null
      }[]
    }

  // perf/2026-10-08-marchcost: the same work at half the clock read as half
  // the speed in ms. Compared in probe units it is the same speed
  it('compares in probe units when both sides carry per-frame probes', () => {
    const fast = withFrames(fixture('m5'), [10, 12, 14], [0.4, 0.4, 0.4])
    const slow = withFrames(fixture('m4'), [20, 24, 28], [0.8, 0.8, 0.8])
    const parsed = parse(invoke([fast, slow]))
    log('same work, half the clock', parsed.rows)
    expect(parsed.rows[1]!.ratioBasis).toBe('probe-units')
    expect(parsed.rows[1]!.speedupVsFirstMachine).toBeCloseTo(1, 9)
  })

  it('withholds ratios from a run whose frame time ramps', () => {
    const flat = [10, 10, 10, 10, 10, 10]
    const ramp = [10, 10, 15, 20, 20, 20]
    const probes = [0.4, 0.4, 0.4, 0.4, 0.4, 0.4]
    const result = invoke([
      withFrames(fixture('m5'), flat, probes),
      withFrames(fixture('m4'), ramp, probes)
    ])
    expect(result.status).toBe(0)
    const parsed = parse(result)
    log('ramped run', { warnings: parsed.warnings })
    expect(parsed.rows[1]!.clock.stable).toBe(false)
    expect(parsed.rows[1]!.speedupVsFirstMachine).toBeNull()
    expect(parsed.warnings.join('\n')).toMatch(/unstable clock.*ramped 2\.00x/)
  })

  it('says so when a report has no per-frame probe', () => {
    const parsed = parse(
      invoke([
        withFrames(fixture('m5'), [10, 12, 14]),
        withFrames(fixture('m4'), [5, 6, 7])
      ])
    )
    expect(parsed.rows[1]!.ratioBasis).toBe('ms')
    expect(parsed.rows[1]!.speedupVsFirstMachine).toBe(2)
    expect(parsed.warnings.join('\n')).toMatch(/no per-frame clock probe/)
  })
})
