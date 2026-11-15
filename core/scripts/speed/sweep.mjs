// Knob sweep on the three package: one page per scene and repetition, every
// arm in rotated order on top of the case's own state, timed per pass with the
// per-frame clock probe. Usage: node core/scripts/speed/sweep.mjs --out out.json
//   [--cases a,b] [--size 2880x1800@2] [--reps 3] [--arms id,id]
//   [--extra combos.json] [--vsync --seconds 8] [--port 5271]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

import {
  clockStability,
  installClockProbe
} from '../../../examples/parity/scripts/benchmarks/clock.mjs'
import {
  armOrder,
  ARMS,
  checkRunInputs,
  DEFAULT_CASES,
  DEFAULT_SIZE,
  median,
  parseSize,
  PROBE_FAST_MS,
  resolveArms,
  timingMode,
  validateExtra
} from './sweepArgs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    cases: { type: 'string', default: DEFAULT_CASES },
    size: { type: 'string', default: DEFAULT_SIZE },
    reps: { type: 'string', default: '3' },
    // ids to time. Absent: the built-in arms, or the combination file's own
    arms: { type: 'string' },
    // combination arms as JSON: [{ id, preset?, set? }]
    extra: { type: 'string' },
    warmup: { type: 'string', default: '40' },
    samples: { type: 'string', default: '30' },
    // a real app loop for a measured window rather than sampled frames
    vsync: { type: 'boolean', default: false },
    seconds: { type: 'string', default: '8' },
    port: { type: 'string', default: '5271' },
    'hard-timeout-min': { type: 'string', default: '42' }
  }
})
if (!values.out) throw new Error('--out is required')
const extra = values.extra == null ? [] : validateExtra(readJson(values.extra))
const armIds = values.arms?.split(',').filter(Boolean)
const arms = armIds == null ? [...ARMS, ...extra] : resolveArms(armIds, extra)
const cases = values.cases.split(',').filter(Boolean)
const size = parseSize(values.size)
const reps = Number(values.reps)
checkRunInputs({ cases, arms, reps })
const timing = timingMode(values)
console.log(
  `sweep: ${cases.length} cases x ${arms.length} arms x ${reps} reps (${timing.mode})`
)

setTimeout(
  () => {
    console.error('HARD TIMEOUT')
    process.exit(3)
  },
  Number(values['hard-timeout-min']) * 60 * 1000
).unref()

const require = createRequire(join(repo, 'examples/parity/package.json'))
const { chromium } = require('@playwright/test')
const port = Number(values.port)
const server = await createServer({
  root: join(repo, 'examples/parity'),
  configFile: join(repo, 'examples/parity/vite.config.ts'),
  logLevel: 'error',
  server: { port, strictPort: true }
})
await server.listen()
const origin = `http://localhost:${port}`
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--enable-unsafe-webgpu',
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync'
  ]
})
const report = {
  createdAt: new Date().toISOString(),
  chrome: browser.version(),
  method: { ...values, size, cases, arms },
  runs: []
}
const save = () =>
  writeFileSync(values.out, JSON.stringify(report, null, 1) + '\n')

// The page's own server, served from the parity package so the case modules
// and the library resolve by package name
async function openCase(caseName) {
  const context = await browser.newContext({
    viewport: { width: size.w / size.dpr, height: size.h / size.dpr },
    deviceScaleFactor: size.dpr
  })
  await context.addInitScript({ path: join(here, 'instrument.js') })
  await context.addInitScript(installClockProbe)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300))
  })
  // the glob must cover the query string too
  await page.route(`${origin}/__speed/**`, route =>
    route.fulfill({
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      },
      body: `<!doctype html><body style="margin:0"><script type="module" src="/@fs${join(here, 'threePage.ts')}"></script>`
    })
  )
  const query = new URLSearchParams({
    case: caseName,
    w: String(size.w),
    h: String(size.h),
    dpr: String(size.dpr)
  })
  await page.goto(`${origin}/__speed/index.html?${query}`)
  await page.waitForFunction(() => window.__speed != null, null, {
    timeout: 180000
  })
  return { context, page, errors }
}

// One arm: apply it, then time by the mode
async function timeArm(page, arm) {
  const applied = await page.evaluate(a => window.__speed.configure(a), arm)
  const timed =
    timing.mode === 'vsync'
      ? await page.evaluate(
          ([wu, s]) => window.__speed.free(wu, s),
          [timing.warmup, timing.seconds]
        )
      : await page.evaluate(
          ([wu, s]) => window.__speed.timed(wu, s),
          [timing.warmup, timing.samples]
        )
  const clock =
    timing.mode === 'vsync' ? null : clockStability(timed.gpuMs, timed.probeMs)
  return { applied, timed, clock }
}

function line(run, arm) {
  const head = `${run.case.padEnd(22)} rep ${run.rep} ${arm.id.padEnd(44)}`
  const errors = run.errors?.length ? ` ERRORS ${run.errors[0]}` : ''
  if (timing.mode === 'vsync') {
    const t = run.timed
    return `${head} ${t.fps.toFixed(1)} fps at ${t.displayHz.toFixed(0)} Hz  dropped ${t.dropped} (${(100 * t.droppedShare).toFixed(1)} %)  longest ${t.longestMs.toFixed(1)} ms${errors}`
  }
  return `${head} gpu ${median(run.timed.gpuMs).toFixed(2)} ms  fast ${(run.clock.unitsMedian * PROBE_FAST_MS).toFixed(2)} ms  ${run.clock.stable ? '' : 'UNSTABLE '}${errors}`
}

async function runCase(caseName, rep, caseIndex) {
  const { context, page, errors } = await openCase(caseName)
  try {
    for (const arm of armOrder(arms, rep, caseIndex)) {
      const run = { case: caseName, size, rep, arm: arm.id }
      try {
        Object.assign(run, await timeArm(page, arm))
      } catch (e) {
        run.failed = e.message
      }
      run.errors = errors.splice(0)
      if (run.errors.length > 0 && run.failed == null)
        run.failed = run.errors[0]
      report.runs.push(run)
      save()
      console.log(line(run, arm))
    }
  } finally {
    await context.close()
  }
}

try {
  for (let rep = 0; rep < reps; rep++)
    for (const [caseIndex, caseName] of cases.entries())
      await runCase(caseName, rep, caseIndex)
} finally {
  await browser.close()
  await server.close()
}
save()

const failed = report.runs.filter(r => r.failed != null)
if (failed.length > 0) {
  console.error(`${failed.length} of ${report.runs.length} arm runs failed`)
  process.exitCode = 1
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
