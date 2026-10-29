#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import { chromiumLaunchOptions } from '../src/e2eSupport/chromeFlags.mjs'
import { buildProvenance, resolvedPackageRoot } from './buildDigest.mjs'
import {
  e2eInputsKey,
  e2eReceiptVerdict,
  ensureFreshBuild,
  readE2eReceipt
} from './freshBuild.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_ROOT = join(__dirname, '..')
const PROJECT_ROOT = join(EXAMPLE_ROOT, '..', '..')
const OUTPUT_DIR = join(PROJECT_ROOT, 'test-results', 'probes')
const OUTPUT_PATH = join(OUTPUT_DIR, 'local-weather-intermediate.json')
const PORT = 4197
const BASE_URL = `http://127.0.0.1:${PORT}`

function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  }).trim()
}

// The measured bytes are whatever the dev server resolves through the parity
// workspace link, maybe not the build just made (run 3 was voided that way)
// buildDigest.mjs holds the digest rule, and this runner REFUSES a mismatch
const PACKAGE_NAME = 'three-clouds-webgpu'

const plan = {
  probe: 'local-weather-intermediate',
  gpu: 'hardware-only',
  order: [
    'reference package hash() vs TSL over n=12288..21888 and point+0.5 lattices',
    'UV input control for the package-resolved LocalWeather render paths',
    'reference package LocalWeather target vs built port LocalWeather target',
    'arm 4: single worley per shader, c in 8..128 x offset 0/0.5, A prelude vs B TSL twin, input echo control',
    'arm 5: full composition float intermediates, self-consistency vs the package targets on both sides',
    'arm 6: mid fbm at 1..4 octaves as separate shaders; 4-octave alone vs together-with-low',
    'arm 6b: worley8(p+0.5) and worley16(p) evaluated INSIDE the giant mid-composition shader vs alone (arm 4), per side; manual-vs-function fbm within the side',
    'arm 7: argmin cell + winning jitter rows (8,0.5) and (16,0), twin-vs-plain control on each side',
    'arm 8: hash-argument assembly at the wrapped z-1 cell, rows (16,0) (8,0) (8,0.5): jitter/n/fract/hash0 + three association orders per side',
    'arm 9: all 27 per-cell jitters per side at (16,0) and (8,0.5), mix(h0,h1,0.0) control, noise-function vs inline-body control',
    'arm 10: the z-1 cell jitter AS CONSUMED INSIDE the 27-cell march vs the same cell standalone, per side, rows (16,0) and (8,0.5)',
    'arm 11: cellCount as a RUNTIME uniform vs a literal — q, n, jitter, fract, hash(n+0) per side, rows (16,0) and (8,0.5)',
    'arm 12 (side A only): the full worley UNROLLED INLINE in main() and in a loop-free function vs the port and vs the reference loop function, rows (16,0) and (8,0.5)'
  ],
  outputs: OUTPUT_PATH,
  servedPackageRoot: resolvedPackageRoot(EXAMPLE_ROOT, PACKAGE_NAME),
  committedParityResultsTouched: false
}

// SHA-256 of NOTHING. A key over zero matched files hashes the empty string and
// looks like a "moved" key (an unquoted zsh variable did it twice). A zero-file
// hash is a failed measurement, so it is refused
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

// The e2e receipt's verdict for THIS tree and whether the per-run override is
// armed, recorded in the probe receipt. The override is dispositioned
// here: this probe drives the generators directly and never marches
function e2eReceiptState() {
  const key = e2eInputsKey(PROJECT_ROOT)
  if (key === EMPTY_SHA256) {
    throw new Error(
      'e2e inputs key hashed ZERO files — a failed measurement, not a key'
    )
  }
  const verdict = e2eReceiptVerdict(readE2eReceipt(PROJECT_ROOT), key)
  return {
    inputsKey: key,
    verdict: verdict.status,
    detail: verdict.detail,
    overrideArmed: process.env.PARITY_SKIP_E2E_RECEIPT === '1'
  }
}

if (process.env.PARITY_GPU !== 'hardware') {
  console.log(
    JSON.stringify({ dryRun: true, ...plan, e2e: e2eReceiptState() }, null, 2)
  )
  console.log('Set PARITY_GPU=hardware only after the fleet bench handoff.')
  process.exit(0)
}

const commit = gitOutput(['rev-parse', 'HEAD'])
const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'])
const dirty = gitOutput(['status', '--porcelain']) !== ''
if (dirty) {
  throw new Error('Refusing hardware evidence from a dirty worktree')
}

ensureFreshBuild('local-weather-intermediate-probe', {
  startDir: PROJECT_ROOT,
  requireGreenE2e: true
})

const provenance = buildProvenance(PROJECT_ROOT, EXAMPLE_ROOT, PACKAGE_NAME)
if (provenance.servedIsBuilt !== true) {
  const served = provenance.served
  throw new Error(
    `Refusing hardware evidence: the dev server resolves ${PACKAGE_NAME} to ${served?.root ?? 'nothing'} (build ${served?.digest.slice(0, 12) ?? 'unresolved'}), not the build just produced at ${provenance.built.root} (${provenance.built.digest.slice(0, 12)})${provenance.error == null ? '' : ` — ${provenance.error}`}`
  )
}
const e2e = e2eReceiptState()
const referenceRoot = resolvedPackageRoot(EXAMPLE_ROOT, '@takram/three-clouds')
const reference = {
  root: referenceRoot,
  version: JSON.parse(readFileSync(join(referenceRoot, 'package.json'), 'utf8'))
    .version
}

function startServer() {
  const server = spawn(
    'pnpm',
    [
      'exec',
      'vite',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort'
    ],
    {
      cwd: EXAMPLE_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  return new Promise((resolve, reject) => {
    let stderr = ''
    const timeout = setTimeout(() => {
      server.kill('SIGTERM')
      reject(new Error(`Vite startup timed out.\n${stderr}`))
    }, 30_000)
    server.stdout.on('data', chunk => {
      const output = chunk.toString()
      if (output.includes('Local:') || output.includes('ready in')) {
        clearTimeout(timeout)
        resolve(server)
      }
    })
    server.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    server.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    server.on('exit', code => {
      if (code != null && code !== 0) {
        clearTimeout(timeout)
        reject(new Error(`Vite exited ${code}.\n${stderr}`))
      }
    })
  })
}

function assertControls(result, consoleErrors) {
  const controls = result.hashInputControl
  const controlsPass =
    controls.reference.missing === 0 &&
    controls.reference.argumentErrors === 0 &&
    controls.reference.coordinateErrors === 0 &&
    controls.port.missing === 0 &&
    controls.port.argumentErrors === 0 &&
    controls.port.coordinateErrors === 0 &&
    controls.indexAligned
  if (!controlsPass) throw new Error('Hash input control failed')
  if (result.localWeatherInputControl.some(channel => channel.maxAbs !== 0)) {
    throw new Error('LocalWeather UV input control failed')
  }
  const weatherChannels = result.localWeather.channels.filter(
    channel => channel.channel !== 'alpha'
  )
  if (
    weatherChannels.every(channel => channel.meanA === 0) ||
    weatherChannels.every(channel => channel.meanB === 0)
  ) {
    throw new Error('LocalWeather target is black on at least one side')
  }
  // Arms 4-7 (pre-registration): a failed control voids the receipt
  for (const row of result.singleWorley) {
    if (row.inputEcho.some(channel => channel.differing !== 0)) {
      throw new Error(`Arm 4 input echo differs on ${row.name}`)
    }
  }
  const quantized = [
    ...result.composition.controls.referenceVsPackage,
    ...result.composition.controls.portVsPackage
  ]
  if (quantized.some(control => !(control.maxCounts <= 1))) {
    throw new Error(
      `Arm 5 self-consistency control failed: ${JSON.stringify(quantized)}`
    )
  }
  for (const row of result.topology) {
    if (
      row.controls.reference.differing !== 0 ||
      row.controls.port.differing !== 0
    ) {
      throw new Error(`Arm 7 twin-vs-plain control failed on ${row.name}`)
    }
  }
  // Arm 8 (01:05Z): n must be identical and the wrapped cell must be
  // an exact integer on both sides in every row; the agreeing row (8, 0.5)
  // must be exact on every channel
  for (const row of result.argumentAssembly) {
    if (!row.controls.nIdentical) {
      throw new Error(`Arm 8 n-in-shader differs across sides on ${row.name}`)
    }
    if (
      row.controls.fractMaxReference !== 0 ||
      row.controls.fractMaxPort !== 0
    ) {
      throw new Error(`Arm 8 wrapped cell is not integral on ${row.name}`)
    }
    if (
      row.cellCount === 8 &&
      row.offset === 0.5 &&
      [row.jitter, row.hash0, row.orders.t1, row.orders.t2, row.orders.t3].some(
        m => m.differing !== 0
      )
    ) {
      throw new Error('Arm 8 agreeing-row control failed on assembly-c8-o0.5')
    }
  }
  // Arm 9 (01:15Z): n identical and integral cells on both sides;
  // the agreeing row (8, 0.5) exact on every per-cell jitter and both
  // within-side controls
  for (const row of result.perCell) {
    if (!row.controls.nIdentical) {
      throw new Error(`Arm 9 n-in-shader differs across sides on ${row.name}`)
    }
    if (
      row.controls.fractMaxReference !== 0 ||
      row.controls.fractMaxPort !== 0
    ) {
      throw new Error(`Arm 9 wrapped cell is not integral on ${row.name}`)
    }
    if (row.cellCount === 8 && row.offset === 0.5) {
      const w = row.mixControl.within
      const f = row.functionVsInline.within
      if (
        row.cells.some(cell => cell.value.differing !== 0) ||
        w.reference.mixVsH0.differing !== 0 ||
        w.port.mixVsH0.differing !== 0 ||
        f.reference.differing !== 0 ||
        f.port.differing !== 0
      ) {
        throw new Error('Arm 9 agreeing-row control failed on percell-c8-o0.5')
      }
    }
  }
  // Arm 10 (01:20Z): the twin's value must equal arm 4's worley on
  // each side, and the agreeing row must be exact on every channel
  for (const row of result.inMarchJitter) {
    if (
      row.controls.valueVsArm4Reference.differing !== 0 ||
      row.controls.valueVsArm4Port.differing !== 0
    ) {
      throw new Error(`Arm 10 twin value differs from arm 4 on ${row.name}`)
    }
    if (
      row.cellCount === 8 &&
      row.offset === 0.5 &&
      (row.crossAB.some(m => m.differing !== 0) ||
        row.within.reference.differing !== 0 ||
        row.within.port.differing !== 0)
    ) {
      throw new Error('Arm 10 agreeing-row control failed on inmarch-c8-o0.5')
    }
  }
  // Arm 11 (01:22Z): the literal form must still agree across sides
  // (arm 9's fact) in every row, and the agreeing row must be exact on every
  // channel and within-side
  for (const row of result.parameterForm) {
    if (row.jitter[1].differing !== 0) {
      throw new Error(
        `Arm 11 literal-form jitter differs across sides on ${row.name}`
      )
    }
    if (
      row.cellCount === 8 &&
      row.offset === 0.5 &&
      ([...row.qn, ...row.jitter].some(m => m.differing !== 0) ||
        row.within.reference.paramVsLiteral.differing !== 0 ||
        row.within.port.paramVsLiteral.differing !== 0)
    ) {
      throw new Error('Arm 11 agreeing-row control failed on paramform-c8-o0.5')
    }
  }
  // Arm 12 (01:36Z): the agreeing row must be exact everywhere, and
  // within A the inline and loop-free-function forms must agree on every row
  for (const row of result.unrolledReference) {
    if (
      row.cellCount === 8 &&
      row.offset === 0.5 &&
      [row.inlineVsPort, row.functionVsPort, row.inlineVsLoopFunction].some(
        m => m.differing !== 0
      )
    ) {
      throw new Error('Arm 12 agreeing-row control failed on unrolled-c8-o0.5')
    }
    if (row.inlineVsFunction.differing !== 0) {
      throw new Error(
        `Arm 12 inline vs loop-free function differ within A on ${row.name}`
      )
    }
  }
  if (consoleErrors.length > 0) {
    throw new Error(`Browser console errors:\n${consoleErrors.join('\n')}`)
  }
}

async function runBrowserProbe(browser) {
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error =>
    consoleErrors.push(error.stack ?? error.message)
  )

  try {
    await page.goto(`${BASE_URL}/probes/local-weather-intermediate.html`)
    await page.waitForFunction(
      () => window.__localWeatherIntermediateProbe != null,
      undefined,
      { timeout: 30_000 }
    )
    const result = await page.evaluate(() =>
      window.__localWeatherIntermediateProbe.run()
    )
    const receipt = {
      ...plan,
      commit,
      branch,
      dirty,
      build: provenance,
      e2e,
      reference,
      consoleErrors,
      result
    }

    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(JSON.stringify(receipt, null, 2))
    assertControls(result, consoleErrors)
  } finally {
    await page.close()
  }
}

async function main() {
  console.log(JSON.stringify({ dryRun: false, ...plan }, null, 2))
  const server = await startServer()
  try {
    const browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      ...chromiumLaunchOptions(['--enable-unsafe-webgpu'], ['Vulkan'])
    })
    try {
      await runBrowserProbe(browser)
    } finally {
      await browser.close()
    }
  } finally {
    server.kill('SIGTERM')
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
