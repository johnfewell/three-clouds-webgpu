import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { clockStability, toProbeUnits } from './clock.mjs'

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    )
  }
  return value
}

function signature(value) {
  return JSON.stringify(canonical(value))
}

export function median(values) {
  assert(values.length > 0, 'Cannot measure zero samples')
  assert(
    values.every(value => Number.isFinite(value) && value > 0),
    'Invalid timing sample'
  )
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function dimension(run) {
  return [
    run.caseName,
    run.width,
    run.height,
    run.workloadId ?? 'default',
    run.variantId,
    run.backend,
    run.buildId
  ]
}

function validateReport(report) {
  assert.equal(report.schemaVersion, 1, 'Unsupported benchmark schema')
  assert.equal(
    report.protocolVersion,
    'clouds-bench-v1',
    'Unsupported timing protocol'
  )
  assert(
    typeof report.machine?.label === 'string' && report.machine.label.trim(),
    'Missing machine label'
  )
  assert(
    Number.isInteger(report.plan?.repeats) && report.plan.repeats > 0,
    'Invalid repetition count'
  )
  assert(
    Number.isInteger(report.plan.sampleFrames) && report.plan.sampleFrames > 0,
    'Invalid sample count'
  )
  assert(
    Array.isArray(report.runs) && report.runs.length > 0,
    'Report contains zero runs'
  )
  const seen = new Set()
  for (const run of report.runs) {
    assert(['webgl', 'webgpu'].includes(run.backend), 'Invalid backend')
    assert(['old', 'new'].includes(run.buildId), 'Invalid build identity')
    assert(
      typeof report.builds?.[run.buildId]?.commit === 'string',
      'Missing source revision'
    )
    assert(typeof run.caseName === 'string' && run.caseName, 'Missing case')
    assert(
      typeof run.variantId === 'string' && run.variantId,
      'Missing variant'
    )
    assert(
      Number.isInteger(run.width) &&
        run.width > 0 &&
        Number.isInteger(run.height) &&
        run.height > 0,
      'Invalid dimensions'
    )
    assert(
      Number.isInteger(run.repetition) &&
        run.repetition >= 0 &&
        run.repetition < report.plan.repeats,
      'Invalid repetition'
    )
    assert(
      ['ok', 'unsupported', 'failed'].includes(run.status),
      'Invalid run status'
    )
    const key = signature([...dimension(run), run.repetition])
    assert(!seen.has(key), 'Duplicate run/repetition')
    seen.add(key)
    if (run.status !== 'ok') continue
    assert(Array.isArray(run.samples?.wallMs), 'Missing wall samples')
    assert.equal(
      run.samples.wallMs.length,
      report.plan.sampleFrames,
      'Incomplete wall sample batch'
    )
    median(run.samples.wallMs)
    assert(Array.isArray(run.samples.gpuMs), 'Missing GPU sample array')
    if (run.samples.gpuMs.length > 0) {
      assert.equal(
        run.samples.gpuMs.length,
        report.plan.sampleFrames,
        'Incomplete GPU sample batch'
      )
      median(run.samples.gpuMs)
    } else
      assert(
        run.gpuUnavailableReason,
        'Empty GPU samples require an explicit reason'
      )
  }
}

function summarizeGroup(report, group) {
  const run = group[0]
  const ok = group.filter(row => row.status === 'ok')
  const complete =
    group.length === report.plan.repeats && ok.length === group.length
  const gpuComplete = complete && ok.every(row => row.samples.gpuMs.length > 0)
  // Clock state per run (docs/BENCHMARKS.md "Clock state"): recomputed from
  // the raw samples, so a report cannot vouch for itself
  const clocks = ok.map(row => ({
    repetition: row.repetition,
    ...clockStability(
      row.samples.gpuMs.length ? row.samples.gpuMs : row.samples.wallMs,
      row.samples.probeMs
    )
  }))
  const units = gpuComplete
    ? ok.map(row => toProbeUnits(row.samples.gpuMs, row.samples.probeMs))
    : []
  const unitsComplete = complete && units.length > 0 && units.every(Boolean)
  const summarize = name => {
    const perRun = ok.map(row => median(row.samples[name]))
    const frames = ok.flatMap(row => row.samples[name]).sort((a, b) => a - b)
    return {
      medianMs: median(perRun),
      minRepeatMedianMs: Math.min(...perRun),
      maxRepeatMedianMs: Math.max(...perRun),
      p95FrameMs: frames[Math.ceil(frames.length * 0.95) - 1],
      sampleCount: frames.length
    }
  }
  return {
    machine: report.machine.label,
    publishable: report.idleConfirmed === true && report.publishable === true,
    caseName: run.caseName,
    width: run.width,
    height: run.height,
    workloadId: run.workloadId ?? 'default',
    variantId: run.variantId,
    backend: run.backend,
    buildId: run.buildId,
    commit: report.builds[run.buildId].commit,
    repetitions: group.length,
    status: complete
      ? 'ok'
      : group.every(row => row.status === 'unsupported')
        ? 'unsupported'
        : 'incomplete',
    reasons: [
      ...new Set(
        group
          .flatMap(row => [row.reason, row.gpuUnavailableReason])
          .filter(Boolean)
      )
    ],
    gpu: gpuComplete ? summarize('gpuMs') : null,
    gpuUnits: unitsComplete
      ? {
          median: median(units.map(median)),
          minRepeatMedian: Math.min(...units.map(median)),
          maxRepeatMedian: Math.max(...units.map(median)),
          probeMedianMs: median(clocks.map(c => c.probeMedianMs))
        }
      : null,
    clock: {
      normalised: unitsComplete,
      stable: clocks.every(c => c.stable),
      unstable: clocks
        .filter(c => !c.stable)
        .map(c => ({ repetition: c.repetition, reasons: c.reasons }))
    },
    wall: complete ? summarize('wallMs') : null,
    settings: run.settings
  }
}

export function aggregateReport(report) {
  validateReport(report)
  const groups = new Map()
  for (const run of report.runs) {
    const key = signature(dimension(run))
    const group = groups.get(key) ?? []
    if (group.length > 0)
      assert.equal(
        signature(run.settings),
        signature(group[0].settings),
        'Settings changed between repetitions'
      )
    group.push(run)
    groups.set(key, group)
  }
  return [...groups.values()].map(group => summarizeGroup(report, group))
}

function revisionIdentity(builds) {
  return Object.fromEntries(
    Object.entries(builds).map(([key, value]) => [
      key,
      {
        commit: value.commit,
        sourceHash: value.sourceHash,
        lockfileHash: value.lockfileHash
      }
    ])
  )
}

export function compareReports(reports) {
  assert(reports.length > 0, 'No benchmark reports supplied')
  const labels = new Set()
  const rows = []
  const warnings = []
  const first = reports[0]
  for (const report of reports) {
    const reportRows = aggregateReport(report)
    assert(!labels.has(report.machine.label), 'Machine labels must be unique')
    labels.add(report.machine.label)
    assert.equal(
      signature(report.plan),
      signature(first.plan),
      'Incompatible benchmark plans'
    )
    assert.equal(
      signature(revisionIdentity(report.builds)),
      signature(revisionIdentity(first.builds)),
      'Incompatible source revisions'
    )
    assert.equal(
      report.suiteHash,
      first.suiteHash,
      'Incompatible benchmark instrumentation'
    )
    if (report.idleConfirmed !== true || report.publishable !== true)
      warnings.push(
        `${report.machine.label}: validation-only results; idle/performance eligibility not confirmed`
      )
    if (
      signature(report.machine.browserVersion ?? report.machine.browser) !==
      signature(first.machine.browserVersion ?? first.machine.browser)
    )
      warnings.push(
        `${report.machine.label}: browser differs from ${first.machine.label}; not a hardware-only comparison`
      )
    rows.push(...reportRows)
  }
  const baseline = new Map(
    rows.map(row => [signature([row.machine, ...dimension(row)]), row])
  )
  for (const row of rows) {
    const peer = (machine, backend, buildId, variantId) =>
      baseline.get(
        signature([
          machine,
          row.caseName,
          row.width,
          row.height,
          row.workloadId,
          variantId,
          backend,
          buildId
        ])
      )
    // Probe units when both rows have them, ms otherwise. A ramped run makes
    // its row unfit to compare: the ratio is withheld, not computed
    const ratio = other => {
      if (!row.publishable || !other?.publishable) return null
      if (row.gpu == null || other.gpu == null) return null
      if (!row.clock.stable || !other.clock.stable) return null
      return row.gpuUnits && other.gpuUnits
        ? other.gpuUnits.median / row.gpuUnits.median
        : other.gpu.medianMs / row.gpu.medianMs
    }
    row.ratioBasis = row.gpuUnits ? 'probe-units' : 'ms'
    // Ratios are durations divided by duration: >1 means this row is faster
    row.speedupVsOld =
      row.buildId === 'new'
        ? ratio(peer(row.machine, row.backend, 'old', row.variantId))
        : null
    row.speedupVsWebGL =
      row.backend === 'webgpu' && row.variantId === 'baseline'
        ? ratio(peer(row.machine, 'webgl', row.buildId, 'baseline'))
        : null
    row.speedupVsBaseline =
      row.backend === 'webgpu' && row.variantId !== 'baseline'
        ? ratio(peer(row.machine, 'webgpu', row.buildId, 'baseline'))
        : null
    row.speedupVsFirstMachine =
      row.machine !== first.machine.label
        ? ratio(
            peer(first.machine.label, row.backend, row.buildId, row.variantId)
          )
        : null
  }
  for (const row of rows) {
    if (!row.clock.stable)
      warnings.push(
        `${row.machine}: ${row.caseName} ${row.width}x${row.height} ${row.backend}/${row.buildId}/${row.variantId} has an unstable clock; ratios withheld: ${row.clock.unstable.map(u => `rep ${u.repetition}: ${u.reasons.join(', ')}`).join('; ')}`
      )
    if (row.gpu != null && !row.clock.normalised)
      warnings.push(
        `${row.machine}: ${row.caseName} ${row.width}x${row.height} ${row.backend}/${row.buildId}/${row.variantId} has no per-frame clock probe; its ratios are raw ms`
      )
  }
  return {
    schemaVersion: 1,
    warnings,
    machines: reports.map(report => report.machine),
    rows
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

export function formatCsv(result) {
  const columns = [
    'machine',
    'caseName',
    'width',
    'height',
    'workloadId',
    'variantId',
    'backend',
    'buildId',
    'commit',
    'status',
    'repetitions',
    'gpuMedianMs',
    'gpuP95Ms',
    'gpuUnitsMedian',
    'probeMedianMs',
    'clockStable',
    'ratioBasis',
    'wallMedianMs',
    'speedupVsOld',
    'speedupVsWebGL',
    'speedupVsBaseline',
    'speedupVsFirstMachine',
    'reasons'
  ]
  const lines = result.rows.map(row => {
    const values = {
      ...row,
      gpuMedianMs: row.gpu?.medianMs,
      gpuP95Ms: row.gpu?.p95FrameMs,
      gpuUnitsMedian: row.gpuUnits?.median,
      probeMedianMs: row.gpuUnits?.probeMedianMs,
      clockStable: row.clock.stable,
      wallMedianMs: row.wall?.medianMs,
      reasons: row.reasons.join('; ')
    }
    return columns.map(column => csvCell(values[column])).join(',')
  })
  return [columns.join(','), ...lines].join('\n') + '\n'
}

function main(args) {
  const outputIndex = args.indexOf('--out')
  let output = null
  if (outputIndex >= 0) {
    assert(args[outputIndex + 1], '--out requires a directory')
    output = resolve(args[outputIndex + 1])
    args.splice(outputIndex, 2)
  }
  assert(
    args.length > 0 && args.every(arg => !arg.startsWith('--')),
    'Usage: compare.mjs [--out directory] report.json [report.json ...]'
  )
  const result = compareReports(
    args.map(path => JSON.parse(readFileSync(path, 'utf8')))
  )
  if (output != null) {
    mkdirSync(output, { recursive: true })
    writeFileSync(
      resolve(output, 'comparison.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' }
    )
    writeFileSync(resolve(output, 'comparison.csv'), formatCsv(result), {
      flag: 'wx'
    })
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[benchmark compare] ${error.message}`)
    process.exitCode = 1
  }
}
