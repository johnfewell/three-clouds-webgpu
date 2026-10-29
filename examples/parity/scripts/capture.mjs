#!/usr/bin/env node

// Stills capture pipeline, Playwright + Chromium on the hardware GPU. Per case:
// A.png, B.png, diff.png, metrics.json, capture.log, metrics.json.env. Flags
// live in captureArgs.mjs (`--help`), parsed before any work. Note
// `--phase N` is CUMULATIVE (rewrites earlier phases): use `--only-phase N`
// `--keep-linear` keeps the readbacks, never committed
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import {
  formatCaptureUsage,
  parseCaptureArgs
} from '../../../scripts/captureArgs.mjs'
import {
  EXIT_BROKEN_GATE,
  validateThresholds
} from '../cases/thresholdSchema.mjs'
import { chromiumLaunchOptions } from '../src/e2eSupport/chromeFlags.mjs'
import {
  evaluate as evaluateMetrics,
  METRICS_VERSION
} from '../src/metrics/evaluator.mjs'
import { RAYMARCH_MODES } from './benchmarks/profile.mjs'
import { writeLinearReadbacks } from './captureLinear.mjs'
import {
  captureProvenance,
  provenanceLine,
  refuseUnlessServedIsAncestor,
  refuseUnlessServedIsBuilt,
  refuseUnlessServedIsSelf
} from './captureProvenance.mjs'
import { summarizeRun } from './captureSummary.mjs'
import { ensureFreshBuild } from './freshBuild.mjs'
import { formatSeqFrameLine } from './seqFrameLine.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_ROOT = join(__dirname, '..')
const PROJECT_ROOT = join(EXAMPLE_ROOT, '..', '..')
// `--out <dir>` redirects the whole run. parity/results is TRACKED evidence, so
// a verification or dry run writing there would overwrite committed results
// Defaults to the real directory
const RESULTS_DIR = join(PROJECT_ROOT, 'parity', 'results')
// PARITY_THRESHOLDS_PATH overrides it for tests, so a test of the refusal path
// never has to corrupt the committed file (same shape as verify-results'
// PARITY_RESULTS_DIR)
const THRESHOLDS_PATH =
  process.env.PARITY_THRESHOLDS_PATH ??
  join(EXAMPLE_ROOT, 'cases', 'thresholds.json')

// Refuse --help and any argument the parser does not accept before the
// threshold read below. An unknown flag used to fall through into a GPU
// capture that took the bench and wrote partial results
const parsed = parseCaptureArgs(process.argv.slice(2))
if (parsed.help) {
  console.log(formatCaptureUsage())
  process.exit(0)
}
if (!parsed.ok) {
  console.error(`[capture] ${parsed.error}`)
  process.exit(1)
}
const {
  phaseFilter,
  onlyPhaseFilter,
  caseFilter,
  sabotageMode,
  allowSkip,
  keepLinear,
  outDirOverride,
  atmosphereProfile
} = parsed.values
// a skipped case (probe never came up) is not a pass; without
// --allow-skip any skip makes the run exit 1
const RESULTS_ROOT =
  outDirOverride != null
    ? outDirOverride.startsWith('/')
      ? outDirOverride
      : join(PROJECT_ROOT, outDirOverride)
    : RESULTS_DIR

// ── Thresholds ────────────────────────────────────────────────
// Validated at load, refusing with a DISTINCT exit code:
// a plain throw exits 1, which reads as an ordinary capture failure
const thresholds = (() => {
  try {
    return validateThresholds(JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')))
  } catch (error) {
    console.error(
      `[capture] REFUSING to run: ${THRESHOLDS_PATH} is not a valid threshold ` +
        `file, so any results this run produced would be gated by nothing.\n` +
        `[capture] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(EXIT_BROKEN_GATE)
  }
})()

function getPhaseThresholds(phase) {
  const pt = thresholds.phases[String(phase)]
  if (!pt) return {}
  const out = {}
  for (const [k, v] of Object.entries(pt)) {
    // `null` is the declared "not measured yet", skipped so the
    // evaluator reads it as unset. Anything else non-numeric already threw at
    // load. This filter once swallowed phase 4's deP95 and histDist silently
    if (typeof v === 'number') out[k] = v
  }
  return out
}

// ── Fresh build ───────────────────────────────────────────────
// build/ is served, not src/, and a red e2e tree is refused
//. The e2e runner does not opt in, or red would block its own fix
ensureFreshBuild('capture', { requireGreenE2e: true })
// Every capture carries its own provenance and refuses a served build that is
// not the one just produced (override terms b/c; see captureProvenance.mjs)
// Stamped into each case's metrics.json and capture.log below
const PACKAGE_NAME = 'three-clouds-webgpu'
const PROVENANCE = captureProvenance({
  projectRoot: PROJECT_ROOT,
  exampleRoot: EXAMPLE_ROOT,
  packageName: PACKAGE_NAME
})
refuseUnlessServedIsBuilt(PROVENANCE, PACKAGE_NAME)
// same bytes is not the same LINEAGE. servedIsBuilt compares digests
// and passes for a tree off this branch entirely, so this names the served tree
// and refuses unless its HEAD is an ancestor of the commit under test
refuseUnlessServedIsAncestor(PROVENANCE, PROVENANCE.git.commit, PROJECT_ROOT)
// same LINEAGE is not the same TREE (a temp worktree at main serving
// the shared checkout passes the check above). This refuses unless the served
// tree IS this tree, before the dev server starts
refuseUnlessServedIsSelf(PROVENANCE, PROJECT_ROOT)
console.log(provenanceLine('[capture] provenance:', PROVENANCE))

// ── Browser flags ─────────────────────────────────────────────
// One --enable-features switch: a second silently replaced Playwright's own
const webGPULaunch = chromiumLaunchOptions(
  ['--enable-unsafe-webgpu'],
  ['Vulkan']
)

// ── Dev server ────────────────────────────────────────────────
const DEFAULT_DEV_PORT = 4174
// BUNNY-RULES 4 gives each agent its own port. The guards below refuse a
// foreign TREE, this refuses a privileged or out-of-range PORT
const DEV_PORT = (() => {
  const raw = process.env.PARITY_DEV_PORT
  if (raw == null || raw === '') return DEFAULT_DEV_PORT
  const port = Number(raw)
  // Skips the system range and the well-known services, keeps 52NN/61NN usable
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `PARITY_DEV_PORT=${JSON.stringify(raw)} is not a usable TCP port ` +
        `(want an integer in 1024..65535; omit it for ${DEFAULT_DEV_PORT})`
    )
  }
  return port
})()
const BASE_URL = `http://localhost:${DEV_PORT}`

async function startDevServer() {
  // Check if dev server is already running
  try {
    execSync(`curl -s -o /dev/null -w "%{http_code}" ${BASE_URL}`, {
      timeout: 2000
    })
    log('[capture] reusing existing dev server')
    return null
  } catch {
    // Not running, start one
  }

  log('[capture] starting dev server...')
  const proc = spawn('npx', ['vite', '--port', String(DEV_PORT)], {
    cwd: EXAMPLE_ROOT,
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' }
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Dev server timeout')),
      30000
    )
    proc.stdout.on('data', data => {
      const text = data.toString()
      if (text.includes('Local:') || text.includes('ready in')) {
        clearTimeout(timeout)
        resolve(proc)
      }
    })
    proc.stderr.on('data', data => {
      process.stderr.write(`[vite] ${data}`)
    })
    proc.on('error', err => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

// ── Logging ───────────────────────────────────────────────────
const globalLogs = []

function log(msg) {
  const ts = new Date().toISOString()
  const line = `${ts} ${msg}`
  console.log(line)
  globalLogs.push(line)
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log(
    `[capture] phase=${phaseFilter ?? 'all'} case=${caseFilter ?? 'all'} sabotage=${sabotageMode ?? 'none'}`
  )

  // Start dev server
  const serverProc = await startDevServer()

  // Launch browser
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    ...webGPULaunch
  })

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  })

  try {
    // Load case registry from the page
    const infoPage = await context.newPage()
    await infoPage.goto(`${BASE_URL}/?e2e=1`)
    await infoPage.waitForTimeout(1000)

    // Get case list and env info from the page
    const envInfo = await infoPage.evaluate(() => {
      const ua = navigator.userAgent
      const chromeMatch = ua.match(/Chrome\/(\S+)/)
      return {
        chrome: chromeMatch ? `Chrome ${chromeMatch[1]}` : ua,
        os: navigator.platform,
        gpu: 'hardware'
      }
    })

    // Get adapter info
    const adapterInfo = await infoPage.evaluate(async () => {
      if (!navigator.gpu) return 'no-webgpu'
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return 'no-adapter'
      const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {}
      return (
        `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.device ?? ''}`.trim() ||
        'unknown'
      )
    })
    envInfo.adapter = adapterInfo
    await infoPage.close()

    // Read cases from the case registry by importing it in the page
    const page = await context.newPage()
    await page.goto(`${BASE_URL}/?e2e=1`)
    await page.waitForTimeout(500)

    const allCases = await page.evaluate(async () => {
      const mod = await import('/cases/index.ts')
      return mod.cases.map(c => ({
        name: c.name,
        number: c.number,
        phase: c.phase,
        lookOnly: c.lookOnly ?? false,
        scene: c.scene,
        sun: c.sun,
        sequence: c.sequence ?? null,
        // B1: the runner OVERRIDES warm-up on every renderOnce, and
        // it used to hardcode 64, silently ignoring a case's own value. ADR-011
        // Amendment 9 raises it on some cases, so the case value is forwarded
        warmup: c.warmup,
        // shadow cases carry the shaded-fraction receipt
        shadow: c.state?.shadow === true,
        shadedFractionSkip: c.shadedFractionReceipt?.skip ?? null,
        // 'ratio' unless the case declares side A has no consumer
        shadedFractionCompare: c.shadedFractionReceipt?.compare ?? 'ratio',
        // the packed debug plate's rendering-deciding channels
        atlasChannelGate: c.atlasChannelGate ?? null,
        // the site-2 radius receipt reads the AERIAL lane. Case 35 is
        // the only 'lights' case, where the shadow goes through the light node,
        // so the receipt says "not applicable" there instead of refusing
        lighting: c.lighting ?? 'post'
      }))
    })

    // Filter cases
    let targetCases = allCases.filter(
      c => !c.lookOnly && c.scene === 'synthetic'
    )
    if (phaseFilter != null) {
      targetCases = targetCases.filter(c => c.phase <= phaseFilter)
    }
    if (onlyPhaseFilter != null) {
      targetCases = targetCases.filter(c => c.phase === onlyPhaseFilter)
    }
    if (caseFilter) {
      targetCases = targetCases.filter(c => c.name === caseFilter)
    }

    // The plan, up front: which phases and which cases. A cumulative --phase
    // run is indistinguishable from a single-phase one until this line
    const phases = [...new Set(targetCases.map(c => c.phase))].sort(
      (a, b) => a - b
    )
    log(
      `[capture] ${targetCases.length} cases to capture — phases ${
        phases.length === 0 ? '(none)' : phases.join(', ')
      }: ${targetCases.map(c => c.name).join(', ') || '(none)'}`
    )

    const summaryRows = []

    for (const caseInfo of targetCases) {
      const t0 = performance.now()
      const caseLogs = []

      function caseLog(msg) {
        const line = `[capture][${caseInfo.name}] ${msg}`
        log(line)
        caseLogs.push(line)
      }

      caseLog(`starting (phase ${caseInfo.phase}, #${caseInfo.number})`)

      // Navigate to case with e2e probe. A lookup qualification run
      // adds side B's atmosphere profile, which the parser has already refused
      // unless --out is outside parity/results. Never capture=1 here.
      const profileQuery =
        atmosphereProfile != null
          ? `&atmosphereProfile=${atmosphereProfile}`
          : ''
      await page.goto(`${BASE_URL}/?case=${caseInfo.name}&e2e=1${profileQuery}`)

      // Wait for probe
      const probeReady = await page
        .waitForFunction(() => window.__parity != null, { timeout: 30000 })
        .catch(() => null)

      if (!probeReady) {
        caseLog('SKIP: probe not ready after 30s')
        summaryRows.push({
          case: caseInfo.name,
          result: 'skip',
          reason: 'probe-timeout'
        })
        continue
      }

      // Warm up + render
      await page.evaluate(
        async opts => {
          const p = window.__parity
          // renderOnce yields one browser frame per warm-up render
          await p.renderOnce('A', {
            time: 0,
            frame: 0,
            warmup: opts.warmup ?? 64
          })
          await p.renderOnce('B', {
            time: 0,
            frame: 0,
            warmup: opts.warmup ?? 64
          })
        },
        { warmup: caseInfo.warmup ?? 64 }
      )

      // Apply sabotage flag (scales linear buffer before metrics)
      if (sabotageMode === 'exposure') {
        caseLog('SABOTAGE: will scale side B linear readback ×2')
        await page.evaluate(() => {
          window.__parity_sabotage = 'exposure'
        })
      }

      // the first compiled CloudsPass renders
      // opacity without radiance until built again, and a session's first
      // linear readback is black, so build once and re-render before capturing
      await page.evaluate(async () => {
        const p = window.__parity
        await p.readLinear('B')
        // resetHistory: false is LOAD-BEARING: this re-render
        // CONTINUES the warm-up above. The default-on reset made it "4 frames
        // from cold", discarding the plate's 64 frames of accumulation
        await p.renderOnce('B', {
          time: 0,
          frame: 0,
          warmup: 4,
          resetHistory: false
        })
        // Side A gets the same 4 frames, so both scored plates carry the same
        // number of temporal history updates (65 + 5 each)
        await p.renderOnce('A', {
          time: 0,
          frame: 0,
          warmup: 4,
          resetHistory: false
        })
      })

      // The scored readback comes BEFORE the display renders below. Each one
      // advances its side's history a frame, and B's linear read then re-runs
      // its pass once more (A 66 vs B 72 updates when read after them)
      await page.evaluate(async () => {
        const p = window.__parity
        // Linear readback from both sides (pre-tonemap HalfFloat data)
        const linearA = await p.readLinear('A')
        const linearB = await p.readLinear('B')

        // read the receipt HERE, at the scored still. The field is
        // written by the LAST renderOnce and the receipt below runs four more
        const convergenceNow = p.convergence()
        window.__parity_scored = { linearA, linearB, convergenceNow }
      })

      // Display PNGs (for humans only) are read via canvas.toDataURL in-page:
      // an element screenshot cropped side A past its container into side B
      // (dd64). A's display is physical (ADR-013 A4), so it is saved unflipped
      const pngA64 = await page.evaluate(() => {
        const p = window.__parity
        if (p.sideAHandle != null) {
          p.sideAHandle.render(0)
        }
        const canvas = document.getElementById('canvas-a')
        return canvas.toDataURL('image/png').split(',')[1]
      })
      const pngA = Buffer.from(pngA64, 'base64')

      // Side B (WebGPU): Playwright's locator.screenshot() captures WebGPU
      // canvases as black. Use canvas.toDataURL() via page.evaluate instead,
      // which correctly reads the GPU-rendered content
      const pngB64 = await page.evaluate(() => {
        const p = window.__parity
        if (p.sideBHandle != null) {
          p.sideBHandle.camera.updateMatrixWorld()
          p.sideBHandle.pipeline.render()
        }
        const canvas = document.getElementById('canvas-b')
        return canvas.toDataURL('image/png').split(',')[1]
      })
      const pngB = Buffer.from(pngB64, 'base64')

      caseLog(`screenshots: A=${pngA.length}b B=${pngB.length}b`)

      // ADR-011: compute metrics from LINEAR pre-tonemap readback
      const metricsT0 = performance.now()

      const result = await page.evaluate(
        async opts => {
          const p = window.__parity

          // The scored still, read before the display renders (see above)
          const { linearA, linearB, convergenceNow } = window.__parity_scored

          // Sabotage: scale side B ×2 in linear space to force metric divergence
          if (window.__parity_sabotage === 'exposure') {
            for (let i = 0; i < linearB.data.length; i++) {
              linearB.data[i] *= 2
            }
          }

          if (linearA.data.length === 0 || linearB.data.length === 0) {
            return {
              width: linearA.width,
              height: linearA.height,
              convergenceNow,
              ssim: 0,
              deMean: 999,
              deP95: 999,
              histDist: 1,
              plate: null,
              maxDiffDelta: 1,
              diffPngB64: '',
              error: 'linear readback returned empty buffer'
            }
          }

          const metricsMod = await import('/src/metrics/index.ts')
          const ssim = metricsMod.computeSSIM(
            linearA.data,
            linearB.data,
            linearA.width,
            linearA.height,
            4
          )
          const de = metricsMod.computeDeltaE(
            linearA.data,
            linearB.data,
            linearA.width,
            linearA.height,
            4
          )
          const histDist = metricsMod.computeHistogramDistance(
            linearA.data,
            linearB.data,
            linearA.width,
            linearA.height,
            4
          )
          // Plate stats: a black/flat side fails regardless of thresholds
          const plate = {
            A: metricsMod.computePlateStats(linearA.data, 4),
            B: metricsMod.computePlateStats(linearB.data, 4)
          }
          // Side B's cloud mask, now WRITTEN OUT (49da) instead of discarded
          // after cloudFraction: R binary (reproduces the fraction exactly), G
          // quantised alpha (shows the veil). Linear-readback orientation
          let cloudMaskB64 = null
          if (typeof p.readLayer === 'function') {
            try {
              const layer = await p.readLayer()
              plate.B.cloudFraction = metricsMod.computeCloudFraction(
                layer.data,
                4
              )
              const mw = layer.width
              const mh = layer.height
              const maskCanvas = new OffscreenCanvas(mw, mh)
              const mCtx = maskCanvas.getContext('2d')
              const maskId = mCtx.createImageData(mw, mh)
              // Built by the SHARED builder that lives beside
              // computeCloudFraction, so the mask and the fraction cannot drift
              maskId.data.set(metricsMod.buildCloudMaskRGBA(layer.data, 4))
              mCtx.putImageData(maskId, 0, 0)
              const maskBlob = await maskCanvas.convertToBlob({
                type: 'image/png'
              })
              const maskBuf = await maskBlob.arrayBuffer()
              cloudMaskB64 = btoa(
                new Uint8Array(maskBuf).reduce(
                  (acc, b) => acc + String.fromCharCode(b),
                  ''
                )
              )
            } catch {
              plate.B.cloudFraction = null
              cloudMaskB64 = null
            }
          }

          // Step 1, the site-2 PCF radius receipt: what the radius
          // remap actually returns, which r1sp only forced. Unlike the mask
          // block, it records laneAbsent and REFUSES, never reading as radius 0
          let shadowRadius = null
          if (opts.shadow) {
            if (typeof p.readShadowRadius !== 'function') {
              shadowRadius = {
                laneAbsent: true,
                summary: null,
                error: 'probe has no readShadowRadius'
              }
            } else {
              try {
                const lane = await p.readShadowRadius()
                shadowRadius =
                  lane == null
                    ? {
                        laneAbsent: true,
                        summary: null,
                        error: null,
                        lanePixels: null,
                        framePixels: null
                      }
                    : {
                        laneAbsent: false,
                        summary: metricsMod.summariseShadowRadius(lane.data, 4),
                        error: null,
                        // the lane must be FRAME-SIZED (the first
                        // run read a 1x1 RT: a broken instrument, not a dead
                        // branch), compared against the linear plate
                        lanePixels: lane.width * lane.height,
                        framePixels: linearB.width * linearB.height
                      }
              } catch (err) {
                shadowRadius = {
                  laneAbsent: true,
                  summary: null,
                  error: String(err).slice(0, 200)
                }
              }
            }
            shadowRadius.line =
              shadowRadius.summary == null
                ? null
                : metricsMod.formatShadowRadiusReceipt(shadowRadius.summary)
            shadowRadius.reasons = metricsMod.evaluateShadowRadiusReceipt({
              summary: shadowRadius.summary,
              laneAbsent: shadowRadius.laneAbsent,
              shadow: opts.shadow,
              lighting: opts.lighting ?? 'post',
              skip: null,
              lanePixels: shadowRadius.lanePixels,
              framePixels: shadowRadius.framePixels
            })
          }

          // Dual-L SSIM attribution (/ ddf) records WHY a case scored
          // low: a real difference or a near-empty frame's small C2. Additive
          // reporting that must never fail a capture
          let ssimAttribution = null
          try {
            const a = metricsMod.computeSsimAttribution(
              linearA.data,
              linearB.data,
              linearA.width,
              linearA.height,
              4
            )
            ssimAttribution = {
              measuredL: a.measuredL,
              referenceL: a.referenceL,
              // v4: `ssim` above is the gated reference-L number, and this is
              // the measured-L (v3) number, kept as the sensitivity diagnostic
              ssimAtMeasuredL: a.ssimAtMeasuredL,
              ssimAtReferenceL: a.ssimAtReferenceL,
              stabiliserShareOfDeficit: a.stabiliserShareOfDeficit,
              meanLuminanceTerm: a.meanLuminanceTerm,
              meanContrastStructureTerm: a.meanContrastStructureTerm,
              sigmaA: a.sigmaA,
              sigmaB: a.sigmaB,
              sigmaD: a.sigmaD,
              // Band fractions only: the full band objects belong in a probe,
              // not in every metrics.json on the ladder
              bandFractions: a.bands.map(b => b.fraction)
            }
          } catch (err) {
            ssimAttribution = { error: String(err).slice(0, 200) }
          }

          // the shaded-fraction receipt. SSIM cannot see whether a
          // shadow EXISTS, so both sides render with casters OFF, flags read
          // back, and the plate must brighten on both (mail #635 / #642)
          let shadedFraction = null
          if (opts.shadow && opts.shadedFractionSkip) {
            // Declared not applicable, with the reason: written, never silent
            shadedFraction = { skipped: opts.shadedFractionSkip }
          } else if (opts.shadow) {
            try {
              if (typeof p.setShadow !== 'function') {
                shadedFraction = { error: 'probe has no setShadow' }
              } else {
                const flagsOff = p.setShadow(false)
                await p.renderOnce('A', {
                  time: 0,
                  frame: 0,
                  warmup: opts.warmup
                })
                await p.renderOnce('B', {
                  time: 0,
                  frame: 0,
                  warmup: opts.warmup
                })
                const offA = await p.readLinear('A')
                const offB = await p.readLinear('B')
                const flagsRestored = p.setShadow(true)
                // Put the render state back for whatever captures next
                await p.renderOnce('A', {
                  time: 0,
                  frame: 0,
                  warmup: opts.warmup
                })
                await p.renderOnce('B', {
                  time: 0,
                  frame: 0,
                  warmup: opts.warmup
                })
                const sideA = metricsMod.computeShadedFraction(
                  linearA.data,
                  offA.data,
                  linearA.width,
                  linearA.height,
                  4
                )
                const sideB = metricsMod.computeShadedFraction(
                  linearB.data,
                  offB.data,
                  linearB.width,
                  linearB.height,
                  4
                )
                const receipt = metricsMod.buildShadedFractionReceipt(
                  sideA,
                  sideB,
                  flagsOff,
                  flagsRestored,
                  opts.shadedFractionCompare ?? 'ratio'
                )
                shadedFraction = {
                  ...receipt,
                  reasons: metricsMod.evaluateShadedFraction(receipt)
                }
              }
            } catch (err) {
              shadedFraction = { error: String(err).slice(0, 200) }
            }
          }

          // per-channel agreement of a packed debug plate. All three
          // are measured. Only the channels the case declares are gated
          let atlasChannels = null
          if (opts.atlasChannelGate) {
            try {
              const gate = opts.atlasChannelGate
              const receipt = metricsMod.buildAtlasChannelReceipt(
                metricsMod.computeAtlasChannelMeans(
                  linearA.data,
                  linearA.width,
                  linearA.height,
                  4
                ),
                metricsMod.computeAtlasChannelMeans(
                  linearB.data,
                  linearB.width,
                  linearB.height,
                  4
                ),
                gate
              )
              atlasChannels = {
                ...receipt,
                line: metricsMod.formatAtlasChannelReceipt(receipt)
              }
            } catch (err) {
              atlasChannels = { error: String(err).slice(0, 200) }
            }
          }

          const diffMod = await import('/src/capture/diff.ts')
          const diff = diffMod.computeDiffImage(
            linearA.data,
            linearB.data,
            linearA.width,
            linearA.height,
            4,
            8
          )

          // Encode diff as PNG via OffscreenCanvas
          const diffCanvas = new OffscreenCanvas(diff.width, diff.height)
          const dCtx = diffCanvas.getContext('2d')
          const diffId = dCtx.createImageData(diff.width, diff.height)
          diffId.data.set(diff.data)
          dCtx.putImageData(diffId, 0, 0)
          const diffBlob = await diffCanvas.convertToBlob({ type: 'image/png' })
          const diffBuf = await diffBlob.arrayBuffer()
          const diffB64 = btoa(
            new Uint8Array(diffBuf).reduce(
              (s, b) => s + String.fromCharCode(b),
              ''
            )
          )

          // --keep-linear: hand the exact readback bytes out. A dataURL of a
          // Blob is linear in the buffer size, and the reduce above is fine for
          // a diff PNG but not for 15 MB of float32
          const encodeLinear = async data => {
            const blob = new Blob([
              data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength
              )
            ])
            const url = await new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(reader.result)
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(blob)
            })
            return String(url).split(',')[1]
          }
          const linearA64 = opts.keepLinear
            ? await encodeLinear(linearA.data)
            : null
          const linearB64 = opts.keepLinear
            ? await encodeLinear(linearB.data)
            : null

          return {
            width: linearA.width,
            height: linearA.height,
            ssim,
            deMean: de.deMean,
            deP95: de.deP95,
            histDist,
            plate,
            convergenceNow,
            ssimAttribution,
            shadedFraction,
            atlasChannels,
            shadowRadius,
            maxDiffDelta: diff.maxDelta,
            diffPngB64: diffB64,
            cloudMaskB64,
            linearA64,
            linearB64
          }
        },
        {
          shadow: caseInfo.shadow === true,
          shadedFractionSkip: caseInfo.shadedFractionSkip ?? null,
          // case 35 declares 'b-only', where the A/B ratio divides
          // two different quantities and must not be gated
          shadedFractionCompare: caseInfo.shadedFractionCompare ?? 'ratio',
          atlasChannelGate: caseInfo.atlasChannelGate ?? null,
          // without this the radius receipt would refuse on case 35,
          // whose ground shadow does not go through the lane it reads
          lighting: caseInfo.lighting ?? 'post',
          warmup: 64,
          keepLinear
        }
      )

      const metricsMs = performance.now() - metricsT0
      const captureMs = performance.now() - t0

      caseLog(
        `metrics: ssim=${result.ssim.toFixed(4)} deMean=${result.deMean.toFixed(2)} deP95=${result.deP95.toFixed(2)} histDist=${result.histDist.toFixed(4)} maxDelta=${result.maxDiffDelta.toFixed(4)}`
      )

      // Dual-L: measured vs reference. A stabiliser share near 1 means the low
      // score describes a near-empty frame, not a port defect
      if (result.ssimAttribution && result.ssimAttribution.error == null) {
        const a = result.ssimAttribution
        caseLog(
          `dual-L: measuredL=${a.measuredL.toFixed(4)} ssim@measuredL=${a.ssimAtMeasuredL.toFixed(4)} (gated ssim is @refL=${a.referenceL}) ` +
            `stabiliserShare=${(a.stabiliserShareOfDeficit * 100).toFixed(1)}% ` +
            `sigmaA=${a.sigmaA.toExponential(2)} sigmaB=${a.sigmaB.toExponential(2)} sigmaD=${a.sigmaD.toExponential(2)}`
        )
      } else if (
        result.ssimAttribution &&
        result.ssimAttribution.error != null
      ) {
        caseLog(`dual-L: unavailable (${result.ssimAttribution.error})`)
      }

      if (result.plate) {
        caseLog(
          `plate: A mean=${result.plate.A.mean.toFixed(4)} std=${result.plate.A.std.toFixed(4)} B mean=${result.plate.B.mean.toFixed(4)} std=${result.plate.B.std.toFixed(4)} cloudFraction=${result.plate.B.cloudFraction == null ? 'n/a' : (result.plate.B.cloudFraction * 100).toFixed(3) + '%'}`
        )
      }

      // GPU timing (32-frame median, disjoint-discarded)
      const gpuTimingResult = await page.evaluate(async () => {
        const p = window.__parity
        if (typeof p.gpuTiming !== 'function') return null
        return p.gpuTiming(32)
      })

      if (gpuTimingResult) {
        const fmtSide = side => {
          if (!side.available) return `n/a (${side.reason})`
          return `${side.report.medianMs.toFixed(2)}ms (${side.report.sampleCount} samples)`
        }
        caseLog(
          `gpuMs: A=${fmtSide(gpuTimingResult.sideA)} B=${fmtSide(gpuTimingResult.sideB)}`
        )
      }

      // Evaluate against thresholds
      if (result.shadedFraction && result.shadedFraction.skipped) {
        caseLog(
          `shaded: receipt declared not applicable — ${result.shadedFraction.skipped}`
        )
      } else if (result.shadedFraction && result.shadedFraction.error == null) {
        const sf = result.shadedFraction
        caseLog(
          `shaded: A=${(sf.A.fraction * 100).toFixed(2)}% B=${(sf.B.fraction * 100).toFixed(2)}% ratio=${sf.ratio.toFixed(3)} ` +
            `plate rise A=${(sf.A.rise * 100).toFixed(1)}% B=${(sf.B.rise * 100).toFixed(1)}% ` +
            `flags off ${JSON.stringify(sf.flagsOff)} restored ${JSON.stringify(sf.flagsRestored)}` +
            (sf.reasons.length
              ? ` → ${sf.reasons.join('; ')}`
              : ' → receipt ok')
        )
      } else if (result.shadedFraction && result.shadedFraction.error) {
        caseLog(`shaded: receipt FAILED — ${result.shadedFraction.error}`)
      }

      // the packed plate's per-channel agreement. `*` marks a gated
      // channel, so the ungated ones stay visible without being scored
      if (result.atlasChannels) {
        const ac = result.atlasChannels
        if (ac.error == null) {
          caseLog(
            `atlas: ${ac.line} tolerance=${(ac.tolerance * 100).toFixed(2)}% ` +
              (ac.reasons.length > 0
                ? `→ ${ac.reasons.join('; ')}`
                : '→ receipt ok')
          )
        } else {
          caseLog(`atlas: receipt FAILED — ${ac.error}`)
        }
      }

      // Step 1, the one-line site-2 radius receipt. `armed` is the
      // number the exnx question turns on: the fraction of consuming pixels at
      // or above the port's own `radius < 0.1` early-out
      if (result.shadowRadius) {
        const sr = result.shadowRadius
        if (sr.line != null && sr.reasons.length === 0) {
          caseLog(`shadowRadius: ${sr.line}`)
        } else {
          for (const reason of sr.reasons ?? [])
            caseLog(`shadowRadius: ${reason}`)
          if (sr.error != null) caseLog(`shadowRadius: error — ${sr.error}`)
        }
      }

      const pt = getPhaseThresholds(caseInfo.phase)
      const evalResult = evaluateMetrics(
        {
          ssim: result.ssim,
          deMean: result.deMean,
          deP95: result.deP95,
          histDist: result.histDist
        },
        pt,
        caseInfo.name,
        thresholds.accepted,
        {
          minStd: thresholds.plate?.minStd ?? 0.002,
          minCloudFraction: thresholds.plate?.minCloudFraction ?? 0.0005,
          plate: result.plate
        }
      )
      // a shadow case whose receipt fails (flags not off, plate did
      // not brighten, or B's shaded fraction below the floor) FAILS, whatever
      // SSIM says: the receipt exists because SSIM cannot see it
      if (result.shadedFraction) {
        const sf = result.shadedFraction
        const receiptReasons = sf.skipped
          ? []
          : sf.error
            ? [`shaded-fraction receipt could not be taken: ${sf.error}`]
            : sf.reasons
        if (receiptReasons.length > 0) {
          evalResult.reasons = [...evalResult.reasons, ...receiptReasons]
          if (evalResult.result !== 'fail') evalResult.result = 'fail'
        }
      }
      // Same standing for the atlas-channel gate: a declared channel that
      // disagrees, or a gated channel carrying no signal, is a fail whatever
      // the plate's SSIM says
      if (result.atlasChannels) {
        const ac = result.atlasChannels
        const atlasReasons = ac.error
          ? [`atlas-channel receipt could not be taken: ${ac.error}`]
          : ac.reasons
        if (atlasReasons.length > 0) {
          evalResult.reasons = [...evalResult.reasons, ...atlasReasons]
          if (evalResult.result !== 'fail') evalResult.result = 'fail'
        }
      }
      caseLog(
        `eval: ${evalResult.result}${evalResult.reasons.length ? ' — ' + evalResult.reasons.join('; ') : ''}`
      )

      // Write output files
      const outDir = join(RESULTS_ROOT, String(caseInfo.phase), caseInfo.name)
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true })
      }

      writeFileSync(join(outDir, 'A.png'), pngA)
      writeFileSync(join(outDir, 'B.png'), pngB)
      writeFileSync(
        join(outDir, 'diff.png'),
        Buffer.from(result.diffPngB64, 'base64')
      )
      // Absent only when side B exposes no
      // readLayer, the same condition that leaves cloudFraction null, so the
      // artifact and the metric appear and disappear together
      if (result.cloudMaskB64 != null) {
        writeFileSync(
          join(outDir, 'cloud-mask.png'),
          Buffer.from(result.cloudMaskB64, 'base64')
        )
      }
      if (keepLinear) {
        const { bytes } = writeLinearReadbacks(outDir, {
          width: result.width,
          height: result.height,
          a64: result.linearA64,
          b64: result.linearB64
        })
        caseLog(
          `linear readbacks preserved: A.linear.f32 B.linear.f32 (${result.width}x${result.height} RGBA float32le, ${bytes} bytes each; never committed)`
        )
      }

      // Sequence capture (flicker/ghosting) for cases with sequence config
      let sequenceBlock = undefined
      if (caseInfo.sequence) {
        const seq = caseInfo.sequence
        caseLog(`sequence: ${seq.frames} frames, dt=${seq.dt}`)

        const seqDir = join(outDir, 'frames')
        if (!existsSync(seqDir)) mkdirSync(seqDir, { recursive: true })

        // the sequence's own state goes on BEFORE the warm-up and only
        // here, so velocity cannot shift a still baseline. Passed as a plain
        // {x, y}: the vector branch's copy() reads only .x/.y
        if (seq.state?.localWeatherVelocity != null) {
          const [vx, vy] = seq.state.localWeatherVelocity
          const applied = await page.evaluate(
            v => {
              window.__parity.set({ localWeatherVelocity: v })
              const b = window.__parity.sideBHandle?.cloudsContext
              return b != null
                ? { x: b.localWeatherVelocity.x, y: b.localWeatherVelocity.y }
                : null
            },
            { x: vx, y: vy }
          )
          // Read back, never assumed: a silent no-op would yield sixteen
          // identical frames and a confident flicker number about a scene that
          // never moved (mail #635)
          if (applied == null || applied.x !== vx || applied.y !== vy) {
            throw new Error(
              `[capture][${caseInfo.name}] sequence velocity did not take: asked ` +
                `${vx},${vy} got ${applied == null ? 'no side B' : `${applied.x},${applied.y}`}`
            )
          }
          caseLog(`sequence velocity: ${vx}, ${vy} (verified on side B)`)
        }

        // Init: reset state + warmup (linear data stored in-browser)
        await page.evaluate(async warmup => {
          await window.__parity.sequenceInit(warmup)
        }, 64)

        // Render frame by frame: capture screenshots + store linear data in-browser
        for (let f = 0; f < seq.frames; f++) {
          const stepResult = await page.evaluate(
            async opts =>
              await window.__parity.sequenceStep(opts.f, opts.dt, opts.motion),
            {
              f,
              dt: seq.dt,
              motion:
                seq.cameraVelocity != null || seq.sunVelocity != null
                  ? {
                      ...(seq.cameraVelocity != null
                        ? { cameraVelocity: seq.cameraVelocity }
                        : {}),
                      ...(seq.sunVelocity != null
                        ? { sunVelocity: seq.sunVelocity }
                        : {})
                    }
                  : undefined
            }
          )

          // Receipt: A == B == expected, checked EVERY frame. The sides
          // own separate cameras, and moving differently would look exactly
          // like a port bug, so the capture refuses instead
          const cam = stepResult?.camera
          if (seq.cameraVelocity != null) {
            if (cam == null || cam.B == null) {
              throw new Error(
                `[capture][${caseInfo.name}] frame ${f}: camera motion requested but ` +
                  `no receipt returned (side B present? ${cam?.B !== undefined})`
              )
            }
            for (let i = 0; i < 3; i++) {
              if (
                cam.A[i] !== cam.expected[i] ||
                cam.B[i] !== cam.expected[i]
              ) {
                throw new Error(
                  `[capture][${caseInfo.name}] frame ${f}: cameras disagree on axis ` +
                    `${i} — A ${cam.A[i]}, B ${cam.B[i]}, expected ` +
                    `${cam.expected[i]}`
                )
              }
            }
          }

          // Sun half, checked every frame: the angles match the
          // runner's OWN computation from the case (not a read-back), and both
          // sides' direction vectors are EXACTLY equal (same code, same anchor)
          const sun = stepResult?.sun
          if (seq.sunVelocity != null) {
            if (sun == null || sun.B == null) {
              throw new Error(
                `[capture][${caseInfo.name}] frame ${f}: sun motion requested but ` +
                  `no receipt returned (side B present? ${sun?.B !== undefined})`
              )
            }
            const t = f * seq.dt
            const wantEl = caseInfo.sun.elevation + seq.sunVelocity[0] * t
            const wantAz = caseInfo.sun.azimuth + seq.sunVelocity[1] * t
            if (sun.elevation !== wantEl || sun.azimuth !== wantAz) {
              throw new Error(
                `[capture][${caseInfo.name}] frame ${f}: sun angles are ` +
                  `${sun.elevation}/${sun.azimuth}, runner expected ` +
                  `${wantEl}/${wantAz}`
              )
            }
            for (let i = 0; i < 3; i++) {
              if (sun.A[i] !== sun.B[i]) {
                throw new Error(
                  `[capture][${caseInfo.name}] frame ${f}: sides disagree on sun ` +
                    `direction axis ${i} — A ${sun.A[i]}, B ${sun.B[i]}`
                )
              }
            }
            // A receipt that only throws leaves no positive trace, so the
            // verdict is stated once and the artifact records that the check
            // ran rather than merely not failing
            if (f === seq.frames - 1) {
              caseLog(
                `sun-receipt: OK over ${seq.frames} frames — elevation ` +
                  `${caseInfo.sun.elevation} -> ${sun.elevation.toFixed(3)}, ` +
                  `azimuth ${caseInfo.sun.azimuth} -> ${sun.azimuth.toFixed(3)}, ` +
                  `A === B on all three axes every frame`
              )
            }
          }

          const fPad = String(f).padStart(3, '0')
          // Same as the still capture (dd64): toDataURL, not an element
          // screenshot. NO FLIP, as side A's display is physical
          // (jg7u). A stale flip once left sequence frames upside down
          const framePngAb64 = await page.evaluate(() => {
            const p = window.__parity
            if (p.sideAHandle != null) {
              p.sideAHandle.render(0)
            }
            const canvas = document.getElementById('canvas-a')
            return canvas.toDataURL('image/png').split(',')[1]
          })
          const framePngA = Buffer.from(framePngAb64, 'base64')
          const framePngBb64 = await page.evaluate(() => {
            const p = window.__parity
            if (p.sideBHandle != null) {
              p.sideBHandle.camera.updateMatrixWorld()
              p.sideBHandle.pipeline.render()
            }
            return document
              .getElementById('canvas-b')
              .toDataURL('image/png')
              .split(',')[1]
          })
          const framePngB = Buffer.from(framePngBb64, 'base64')
          writeFileSync(join(seqDir, `f${fPad}_A.png`), framePngA)
          writeFileSync(join(seqDir, `f${fPad}_B.png`), framePngB)

          // the per-frame series shows whether
          // the accumulator was still moving. Formatting lives in
          // seqFrameLine.mjs, testable without a browser
          caseLog(formatSeqFrameLine(f, f * seq.dt, stepResult?.plateMean))
        }

        // Compute flicker + ghosting from stored linear data (all in-browser)
        const seqResult = await page.evaluate(
          async opts => window.__parity.sequenceMetrics(opts),
          { frames: seq.frames, dt: seq.dt }
        )

        caseLog(
          `flickerA: mean=${seqResult.flickerA.mean.toFixed(4)} max=${seqResult.flickerA.max.toFixed(4)}`
        )
        caseLog(
          `flickerB: mean=${seqResult.flickerB.mean.toFixed(4)} max=${seqResult.flickerB.max.toFixed(4)}`
        )
        if (seqResult.ghostingA) {
          caseLog(
            `ghostingA: mean=${seqResult.ghostingA.deMean.toFixed(4)} p95=${seqResult.ghostingA.deP95.toFixed(4)}`
          )
        }
        if (seqResult.ghostingB) {
          caseLog(
            `ghostingB: mean=${seqResult.ghostingB.deMean.toFixed(4)} p95=${seqResult.ghostingB.deP95.toFixed(4)}`
          )
        }
        gateSequenceMotion(caseInfo.name, seqResult, caseLog)

        sequenceBlock = {
          frameCount: seq.frames,
          flickerA: {
            mean: round2(seqResult.flickerA.mean),
            max: round2(seqResult.flickerA.max)
          },
          flickerB: {
            mean: round2(seqResult.flickerB.mean),
            max: round2(seqResult.flickerB.max)
          },
          ...formatSequenceMotion(seqResult)
        }
        if (seqResult.ghostingA) {
          sequenceBlock.ghostingA = {
            mean: round2(seqResult.ghostingA.deMean),
            p95: round2(seqResult.ghostingA.deP95)
          }
        }
        if (seqResult.ghostingB) {
          sequenceBlock.ghostingB = {
            mean: round2(seqResult.ghostingB.deMean),
            p95: round2(seqResult.ghostingB.deP95)
          }
        }
      }

      // the convergence receipt for THIS case, per side. Without it
      // the same call reads 71.88 % changed cold and ~0 % warm
      // the value captured at the scored still, not a fresh read
      const convergence = result.convergenceNow ?? null

      // what temporalUpscale each side ACTUALLY ran with, read and
      // never assumed, so a temporal number is shown to come from sides that
      // agreed about the flag it is entirely about
      const temporalUpscale = await page
        .evaluate(() => window.__parity.readTemporalUpscale())
        .catch(() => null)
      if (temporalUpscale != null) {
        caseLog(
          `temporalUpscale: A=${temporalUpscale.A} B=${String(temporalUpscale.B)}` +
            (temporalUpscale.B != null &&
            temporalUpscale.A !== temporalUpscale.B
              ? '  <- SIDES DISAGREE'
              : '')
        )
      }

      // the atmosphere method side B ACTUALLY ran, so a lookup
      // qualification capture cannot pass for a reference one (ADR-013 A6: the
      // URL's profile, else the case's exception, else the lookup)
      const atmosphere = await page
        .evaluate(() => {
          const b = window.__parity.sideBHandle
          return b == null
            ? null
            : {
                effective: b.atmosphereProfile,
                raymarch: b.atmosphereContext.raymarchScattering,
                accurateShadow: b.atmosphereContext.accurateShadowScattering
              }
        })
        .catch(() => null)
      // Whether the device offered `subgroups`, which decides whether the
      // default half-resolution shaft march ran at all. Probed here because
      // renderer.hasFeature is the only page-side source, so it reads into a var
      const subgroups = await page
        .evaluate(() => {
          const b = window.__parity.sideBHandle
          if (b == null || b.renderer == null) return null
          try {
            return b.renderer.hasFeature('subgroups') === true
          } catch {
            return null
          }
        })
        .catch(() => null)
      caseLog(`subgroups: ${String(subgroups)}`)

      const requested = atmosphereProfile ?? 'reference'
      const expectRaymarch = RAYMARCH_MODES.includes(
        atmosphere?.effective ?? requested
      )
      // The harness pins accurateShadowScattering false to match the
      // reference's single shadowed-scattering branch, so a log that omits it
      // reads the same whether or not the pin applied
      const expectAccurateShadow = false
      const accurateShadowApplied =
        atmosphere?.accurateShadow === expectAccurateShadow
      caseLog(
        `atmosphere: requested=${requested} effective=${String(atmosphere?.effective)} B raymarchScattering=${String(atmosphere?.raymarch)} B accurateShadowScattering=${String(atmosphere?.accurateShadow)}` +
          (atmosphere?.raymarch !== expectRaymarch
            ? '  <- PROFILE NOT APPLIED'
            : '') +
          (accurateShadowApplied ? '' : '  <- PIN NOT APPLIED')
      )

      caseLog(provenanceLine('provenance:', PROVENANCE))
      const metricsObj = {
        case: caseInfo.name,
        phase: caseInfo.phase,
        readback: 'linear',
        metricsVersion: METRICS_VERSION,
        // null only when the probe could not be reached
        temporalUpscale: temporalUpscale,
        provenance: PROVENANCE,
        convergence:
          convergence != null
            ? {
                A: convergence.A != null ? round6(convergence.A) : null,
                B: convergence.B != null ? round6(convergence.B) : null
              }
            : null,
        ssim: round6(result.ssim),
        deMean: round2(result.deMean),
        deP95: round2(result.deP95),
        histDist: round6(result.histDist),
        plate: result.plate
          ? {
              A: {
                mean: round6(result.plate.A.mean),
                std: round6(result.plate.A.std)
              },
              B: {
                mean: round6(result.plate.B.mean),
                std: round6(result.plate.B.std),
                cloudFraction:
                  result.plate.B.cloudFraction == null
                    ? null
                    : round6(result.plate.B.cloudFraction)
              }
            }
          : null,
        ssimAttribution: result.ssimAttribution ?? null,
        shadedFraction:
          result.shadedFraction == null
            ? null
            : result.shadedFraction.skipped
              ? { skipped: result.shadedFraction.skipped }
              : result.shadedFraction.error
                ? { error: result.shadedFraction.error }
                : {
                    A: roundSide(result.shadedFraction.A),
                    B: roundSide(result.shadedFraction.B),
                    ratio: round6(result.shadedFraction.ratio),
                    // the policy is in the evidence, so verify-results
                    // re-grades case 35 the way it was captured
                    compare: result.shadedFraction.compare ?? 'ratio',
                    flagsOff: result.shadedFraction.flagsOff,
                    flagsRestored: result.shadedFraction.flagsRestored,
                    reasons: result.shadedFraction.reasons
                  },
        // every channel measured, `gated` says which are scored
        atlasChannels:
          result.atlasChannels == null
            ? null
            : result.atlasChannels.error != null
              ? { error: result.atlasChannels.error }
              : {
                  A: roundAtlasMeans(result.atlasChannels.A),
                  B: roundAtlasMeans(result.atlasChannels.B),
                  ratio: roundAtlasRatio(result.atlasChannels.ratio),
                  deviation: roundAtlasRatio(result.atlasChannels.deviation),
                  gated: result.atlasChannels.gated,
                  tolerance: result.atlasChannels.tolerance,
                  reasons: result.atlasChannels.reasons
                },
        // Step 1. Written whole (summary, laneAbsent, error AND
        // reasons): a receipt that records only its number cannot record its
        // own refusal, and the refusal is the load-bearing half
        shadowRadius:
          result.shadowRadius == null
            ? null
            : {
                laneAbsent: result.shadowRadius.laneAbsent,
                error: result.shadowRadius.error ?? null,
                lanePixels: result.shadowRadius.lanePixels ?? null,
                framePixels: result.shadowRadius.framePixels ?? null,
                reasons: result.shadowRadius.reasons ?? [],
                summary:
                  result.shadowRadius.summary == null
                    ? null
                    : {
                        sampled: result.shadowRadius.summary.sampled,
                        classified: result.shadowRadius.summary.classified,
                        min: round6(result.shadowRadius.summary.min),
                        median: round6(result.shadowRadius.summary.median),
                        p95: round6(result.shadowRadius.summary.p95),
                        max: round6(result.shadowRadius.summary.max),
                        armedFraction: round6(
                          result.shadowRadius.summary.armedFraction
                        ),
                        atCeilingFraction: round6(
                          result.shadowRadius.summary.atCeilingFraction
                        )
                      }
              },
        // null when the page could not answer, and always present: omitting the
        // key would let a metrics.json read as "both paths agreed"
        subgroups: subgroups ?? null,
        result: evalResult.result,
        reasons: evalResult.reasons,
        maxDiffDelta: round6(result.maxDiffDelta),
        width: result.width,
        height: result.height,
        captureMs: Math.round(captureMs),
        metricsMs: Math.round(metricsMs)
      }
      if (sequenceBlock) {
        metricsObj.sequence = sequenceBlock
      }
      // gpuMs was logged but never persisted, which let the 1e6 unit
      // defect survive. NOT a metricsVersion bump: an optional key redefines
      // nothing, and a bump would stale all 47 committed v3 results
      if (gpuTimingResult) {
        metricsObj.gpuMs = gpuTimingResult
      }
      // metrics.json is written by ONE formatter (metricsWriter.ts)
      // It runs in the page because the writer is TypeScript, and the object
      // crosses as plain structured-clone data
      const metricsJson = await page.evaluate(async m => {
        const w = await import('/src/capture/metricsWriter.ts')
        return w.formatMetricsJson({
          caseName: m.case,
          phase: m.phase,
          readback: m.readback,
          metrics: {
            ssim: m.ssim,
            deMean: m.deMean,
            deP95: m.deP95,
            histDist: m.histDist
          },
          eval: { result: m.result, reasons: m.reasons },
          plate: m.plate,
          ssimAttribution: m.ssimAttribution,
          shadedFraction: m.shadedFraction,
          // the only path into metrics.json, so the field has to be
          // mapped here as well as computed
          atlasChannels: m.atlasChannels,
          // THE FOURTH TIME through this boundary. See the note below.
          shadowRadius: m.shadowRadius,
          // metricsObj has carried provenance since #55, but this
          // mapping is the ONLY path into metrics.json, so it was dropped here
          // and every artifact looked complete without it (as below)
          provenance: m.provenance,
          // THE THIRD TIME through this boundary. Adding the field to
          // metricsObj was not enough, again, because this mapping is the
          // only path into metrics.json
          temporalUpscale: m.temporalUpscale,
          // the ONLY path into metrics.json, so an unforwarded field is
          // dropped silently and every artifact looks complete without it
          subgroups: m.subgroups,
          // forward the stationarity receipt. metrics.json comes only
          // through this mapping, so an unforwarded field is dropped silently
          // and every artifact looks complete without it
          convergence: m.convergence,
          maxDiffDelta: m.maxDiffDelta,
          dimensions: { width: m.width, height: m.height },
          timing: { captureMs: m.captureMs, metricsMs: m.metricsMs },
          // metricsObj.sequence is already in OUTPUT shape (ghosting as
          // mean/p95); the writer takes input shape (deMean/deP95). Map rather
          // than pass through, or ghosting silently serialises as undefined
          gpuMs: m.gpuMs,
          sequence:
            m.sequence == null
              ? undefined
              : {
                  frameCount: m.sequence.frameCount,
                  flickerA: m.sequence.flickerA,
                  flickerB: m.sequence.flickerB,
                  ghostingA:
                    m.sequence.ghostingA == null
                      ? undefined
                      : {
                          deMean: m.sequence.ghostingA.mean,
                          deP95: m.sequence.ghostingA.p95
                        },
                  ghostingB:
                    m.sequence.ghostingB == null
                      ? undefined
                      : {
                          deMean: m.sequence.ghostingB.mean,
                          deP95: m.sequence.ghostingB.p95
                        },
                  motionA: m.sequence.motionA,
                  motionB: m.sequence.motionB,
                  motionDirection: m.sequence.motionDirection
                }
        })
      }, metricsObj)

      writeFileSync(join(outDir, 'metrics.json'), metricsJson + '\n')
      writeFileSync(
        join(outDir, 'metrics.json.env'),
        JSON.stringify(envInfo, null, 2) + '\n'
      )
      writeFileSync(join(outDir, 'capture.log'), caseLogs.join('\n') + '\n')

      caseLog(`wrote ${outDir} (${captureMs.toFixed(0)}ms)`)

      summaryRows.push({
        case: caseInfo.name,
        result: evalResult.result,
        ssim: result.ssim.toFixed(4),
        deP95: result.deP95.toFixed(2),
        ms: Math.round(captureMs)
      })
    }

    // Summary table
    log('')
    log(
      '┌─────────────────────────┬────────────────────┬────────┬───────┬───────┐'
    )
    log(
      '│ Case                    │ Result             │  SSIM  │ ΔE95  │  ms   │'
    )
    log(
      '├─────────────────────────┼────────────────────┼────────┼───────┼───────┤'
    )
    for (const row of summaryRows) {
      const c = (row.case ?? '').padEnd(23)
      const r = (row.result ?? '').padEnd(18)
      const s = (row.ssim ?? '-').toString().padStart(6)
      const d = (row.deP95 ?? '-').toString().padStart(5)
      const m = (row.ms ?? '-').toString().padStart(5)
      log(`│ ${c} │ ${r} │ ${s} │ ${d} │ ${m} │`)
    }
    log(
      '└─────────────────────────┴────────────────────┴────────┴───────┴───────┘'
    )

    // the verdict is a pure function so the unit suite pins it: a
    // skipped case is named, never counted as a pass, and exits 1 unless
    // --allow-skip was passed explicitly
    const verdict = summarizeRun(summaryRows, { allowSkip, sabotageMode })
    log('')
    for (const line of verdict.lines) log(line)
    if (verdict.exitCode != null) process.exitCode = verdict.exitCode
    const failCount = verdict.failCount

    if (sabotageMode) {
      const anyFail = summaryRows.some(r => r.result === 'fail')
      if (sabotageMode === 'exposure' && !anyFail) {
        log(
          '[capture] SABOTAGE CHECK FAILED: sabotage=exposure should produce failures'
        )
        process.exitCode = 1
      } else if (anyFail) {
        log(
          `[capture] sabotage=${sabotageMode} correctly detected (${failCount} failures)`
        )
      }
    }
  } finally {
    await browser.close()
    if (serverProc) {
      serverProc.kill()
    }
  }
}

function roundSide(side) {
  return {
    fraction: round6(side.fraction),
    meanOn: round6(side.meanOn),
    meanOff: round6(side.meanOff),
    rise: round6(side.rise),
    classified: side.classified
  }
}

// channel means go to 1e-7 because the atlas channels are 1e-3 to
// 1e-5 of full scale and 1e-6 rounding is 0.1 % of the smallest one
function roundAtlasMeans(means) {
  return { r: round7(means.r), g: round7(means.g), b: round7(means.b) }
}

function roundAtlasRatio(ratio) {
  return { r: round6(ratio.r), g: round6(ratio.g), b: round6(ratio.b) }
}

function round7(n) {
  return Math.round(n * 1e7) / 1e7
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6
}
function round2(n) {
  return Math.round(n * 100) / 100
}

function formatSequenceMotion(result) {
  const formatVector = motion =>
    motion == null
      ? null
      : {
          dx: round2(motion.dx),
          dy: round2(motion.dy),
          score: round6(motion.score)
        }
  const direction = result.motionDirection
  return {
    motionA: formatVector(result.motionA),
    motionB: formatVector(result.motionB),
    motionDirection:
      direction == null
        ? null
        : {
            aligned: direction.aligned,
            comparable: direction.comparable,
            cosine: direction.cosine == null ? null : round6(direction.cosine)
          }
  }
}

function gateSequenceMotion(caseName, result, log) {
  const a = result.motionA
  const b = result.motionB
  const direction = result.motionDirection
  if (a == null || b == null || direction == null) return
  if (direction.comparable && direction.cosine == null) {
    throw new Error(`[capture][${caseName}] comparable motion has no cosine`)
  }
  const verdict = direction.comparable
    ? `cosine=${direction.cosine.toFixed(3)} ${direction.aligned ? 'aligned' : 'OPPOSED'}`
    : 'direction not measurable'
  log(
    `motion: A=(${a.dx.toFixed(1)},${a.dy.toFixed(1)}) score=${a.score.toFixed(3)} ` +
      `B=(${b.dx.toFixed(1)},${b.dy.toFixed(1)}) score=${b.score.toFixed(3)} ${verdict}`
  )
  if (direction.comparable && !direction.aligned) {
    throw new Error(
      `[capture][${caseName}] sequence motion directions disagree: ` +
        `A=(${a.dx},${a.dy}), B=(${b.dx},${b.dy}), ` +
        `cosine=${direction.cosine}`
    )
  }
}

main().catch(err => {
  console.error('[capture] fatal:', err)
  process.exit(1)
})
