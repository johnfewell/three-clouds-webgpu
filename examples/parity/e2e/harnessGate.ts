// One gate for every e2e suite. It
// asks whether THE HARNESS BOOTED, not whether an adapter exists: SwiftShader
// returns an adapter, so the old check passed and every test then timed out
// on window.__parity (all 11 p4 tests, 2026-08-31). One page load per suite

import { test, type Browser } from '@playwright/test'

// Plain-JS module shared with capture.mjs, typed by freshBuild.d.ts beside it:
// one implementation, two runners. Its JSDoc types make
// the import resolve, so the old @ts-expect-error went
import { ensureFreshBuild } from '../scripts/freshBuild.mjs'
import type { ParityProbe } from './parityProbe'

// ParityProbe (parityProbe.ts) is the probe's real surface, so the global names
// it. The specs still reach it through the `ParityWindow` cast, which makes
// `__parity` non-optional where the harness has already booted
declare global {
  interface Window {
    __parity?: ParityProbe
  }
}

const DEFAULT_BASE = 'http://localhost:4173'

// Paid ONCE per suite, leaving room in the beforeAll budget for two page loads
// (hence the raised hook timeout below). It only has to outlast a real boot,
// which takes a few seconds on hardware, not a hang
const BOOT_TIMEOUT_MS = 20_000

// Per-navigation cap. Under a software rasteriser the PAGE LOAD itself can
// hang, not just the harness boot, so the gate cannot rely on the boot wait
// alone to bound it
const NAV_TIMEOUT_MS = 15_000

// A single deadline over the whole probe, since the guarded failure is a step
// hanging past its own timeout. Without it the hook blows its budget and
// reports a FAILURE, discarding the gate's diagnosis
const GATE_BUDGET_MS = 50_000

// The default hook timeout is 60s, which the boot wait plus two navigations can
// exceed, and a hook TIMEOUT reports as a failure, losing the diagnosis the
// gate just computed
const HOOK_TIMEOUT_MS = 90_000

interface AdapterInfo {
  vendor: string
  architecture: string
  device: string
  description: string
}

/**
 * Skips (or fails) the suite unless the parity harness actually boots
 */
export async function requireBootedHarness(
  browser: Browser,
  baseURL: string | undefined,
  label: string
): Promise<void> {
  test.setTimeout(HOOK_TIMEOUT_MS)

  // Before anything else: the harness serves build/index.js, not src/, so a
  // run on a stale build measures the PREVIOUS library and reports it as a
  // clean result. ~2.4s is cheaper than one wrong null.
  ensureFreshBuild(`e2e/${label}`)

  const base = baseURL ?? DEFAULT_BASE
  const page = await browser.newPage()
  let failure: string | null = null
  let isSoftware = false

  const probe = async (): Promise<void> => {
    await page.goto(base, { timeout: NAV_TIMEOUT_MS })

    // Adapter details stay: they are the most useful line in the log when a
    // run behaves oddly, and they name software rendering explicitly
    const adapter = await page.evaluate(async () => {
      // navigator.gpu is not in the DOM lib this project targets, and pulling in
      // @webgpu/types for two property reads would widen the dependency for no
      // gain. Narrowed locally instead.
      const nav = navigator as Navigator & {
        gpu?: { requestAdapter: () => Promise<unknown> }
      }
      if (typeof navigator === 'undefined' || nav.gpu == null) return null
      const a = (await nav.gpu.requestAdapter()) as {
        info?: Record<string, string>
        requestAdapterInfo?: () => Promise<Record<string, string>>
      } | null
      if (a == null) return null
      const info =
        (a as unknown as { info?: unknown }).info ??
        (await (
          a as unknown as { requestAdapterInfo?: () => Promise<unknown> }
        ).requestAdapterInfo?.())
      const i = (info ?? {}) as Partial<AdapterInfo>
      return {
        vendor: i.vendor ?? 'unknown',
        architecture: i.architecture ?? 'unknown',
        device: i.device ?? 'unknown',
        description: i.description ?? ''
      }
    })

    isSoftware =
      adapter != null &&
      (adapter.description.toLowerCase().includes('swiftshader') ||
        adapter.vendor.toLowerCase().includes('google'))

    console.log(
      `[e2e][${label}] adapter=${adapter?.vendor ?? 'none'}/${adapter?.architecture ?? '-'} software=${isSoftware}`
    )

    // The actual gate. A case page, not the bare origin: `__parity` is only
    // published once a case has built both sides
    await page.goto(`${base}/?case=baseline-medium&e2e=1`, {
      timeout: NAV_TIMEOUT_MS
    })
    const booted = await page
      .waitForFunction(() => window.__parity != null, {
        timeout: BOOT_TIMEOUT_MS
      })
      .then(() => true)
      .catch(() => false)

    if (!booted) {
      const why = isSoftware
        ? 'the adapter is a software rasteriser (swiftshader), which cannot run this harness'
        : adapter == null
          ? 'no WebGPU adapter is available'
          : 'an adapter exists but the harness did not publish window.__parity'
      failure = `[e2e][${label}] harness did not boot: ${why}`
    }
  }

  const TIMED_OUT = Symbol('gate-timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raced = await Promise.race([
      probe().then(() => null),
      new Promise<typeof TIMED_OUT>(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), GATE_BUDGET_MS)
      })
    ])
    if (raced === TIMED_OUT) {
      failure = `[e2e][${label}] harness gate exceeded ${GATE_BUDGET_MS / 1000}s${
        isSoftware ? ' (software rasteriser — the page itself hangs)' : ''
      }`
    }
  } catch (error) {
    failure = `[e2e][${label}] harness gate errored: ${
      error instanceof Error ? error.message : String(error)
    }`
  } finally {
    if (timer != null) clearTimeout(timer)
  }

  // Closed BEFORE control leaves this function: test.skip() unwinds by
  // throwing, and a close() in a finally during that unwind races teardown
  // into a "Failed to find context" failure
  await page.close().catch(() => {})

  if (failure == null) return

  if (process.env.E2E_ALLOW_NO_GPU === '1') {
    console.warn(`${failure} — suite skipped`)
    test.skip()
    return
  }
  throw new Error(`${failure} — set E2E_ALLOW_NO_GPU=1 to skip`)
}
