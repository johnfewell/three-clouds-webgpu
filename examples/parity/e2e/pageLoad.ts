// One parity page loader for every spec. Three
// 60 s load timeouts left no diagnosis, so a failed load records the last boot
// stage, visibility, whether rAF still fires, pending requests and device loss,
// and fails with that summary. The auto fixture does the same on test timeout

import {
  test as base,
  errors,
  type ConsoleMessage,
  type Page,
  type Request
} from '@playwright/test'

import {
  formatPageLoadSummary,
  type PageLoadSnapshot,
  type PageStateSnapshot
} from '../src/e2eSupport/pageLoadSummary'
import type { ParityWindow } from './parityProbe'

const EVALUATE_BUDGET_MS = 5_000
const RAF_PROBE_MS = 1_000
const MAX_CONSOLE_ERRORS = 5

interface InPageState {
  raf: number
  visibility: [number, string][]
  gpu: {
    devicesRequested: number
    lost: { reason: string; message: string } | null
    uncapturedErrors: string[]
  }
}
type DiagWindow = Window & { __e2ePageLoad?: InPageState }

// Just the WebGPU members the init script touches. The e2e compilation has no
// WebGPU type library
interface MinimalGPUDevice {
  lost: Promise<{ reason: string; message: string }>
  addEventListener(
    type: 'uncapturederror',
    listener: (event: { error: { message: string } }) => void
  ): void
}
interface MinimalGPUAdapter {
  requestDevice: (
    this: MinimalGPUAdapter,
    ...args: unknown[]
  ) => Promise<MinimalGPUDevice>
}

// Serialized by addInitScript and run before any page script, so it must not
// close over anything. The extra rAF loop only counts and renders nothing.
function installInPage(): void {
  const state: InPageState = {
    raf: 0,
    visibility: [],
    gpu: { devicesRequested: 0, lost: null, uncapturedErrors: [] }
  }
  ;(window as DiagWindow).__e2ePageLoad = state
  const tick = (): void => {
    state.raf++
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  document.addEventListener('visibilitychange', () => {
    state.visibility.push([performance.now(), document.visibilityState])
  })
  const adapter = (
    globalThis as { GPUAdapter?: { prototype: MinimalGPUAdapter } }
  ).GPUAdapter
  if (adapter == null) return
  const requestDevice = adapter.prototype.requestDevice
  adapter.prototype.requestDevice = async function (
    this: MinimalGPUAdapter,
    ...args: unknown[]
  ): Promise<MinimalGPUDevice> {
    const device = await requestDevice.apply(this, args)
    state.gpu.devicesRequested++
    void device.lost.then(info => {
      state.gpu.lost = { reason: info.reason, message: info.message }
    })
    device.addEventListener('uncapturederror', event => {
      if (state.gpu.uncapturedErrors.length < 5) {
        state.gpu.uncapturedErrors.push(event.error.message.slice(0, 300))
      }
    })
    return device
  }
}

// Passed to page.evaluate, so like installInPage it must not close over
// anything
function readInPageState(): Omit<
  PageStateSnapshot,
  'rafCountAfterProbe' | 'rafProbeMs'
> {
  const s = (window as DiagWindow).__e2ePageLoad
  const noGpu = { devicesRequested: 0, lost: null, uncapturedErrors: [] }
  return {
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    parityPublished: (window as ParityWindow).__parity != null,
    rafCount: s?.raf ?? -1,
    visibilityChanges: s?.visibility ?? [],
    gpu: s?.gpu ?? noGpu
  }
}

async function withinBudget<T>(work: Promise<T>): Promise<T | null> {
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), EVALUATE_BUDGET_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export class PageLoadDiagnostics {
  private lastBootStage: string | null = null
  private readonly consoleErrors: string[] = []
  private readonly pending = new Map<Request, number>()
  private navigatedAt: number | null = null

  constructor(private readonly page: Page) {
    page.on('console', m => this.recordConsole(m))
    page.on('request', r => this.pending.set(r, Date.now()))
    page.on('requestfinished', r => this.pending.delete(r))
    page.on('requestfailed', r => this.pending.delete(r))
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return
      this.navigatedAt = Date.now()
      this.lastBootStage = null
    })
  }

  private recordConsole(m: ConsoleMessage): void {
    const text = m.text()
    if (text.startsWith('[parity][')) this.lastBootStage = text.slice(0, 200)
    if (m.type() !== 'error') return
    this.consoleErrors.push(text.slice(0, 300))
    if (this.consoleErrors.length > MAX_CONSOLE_ERRORS)
      this.consoleErrors.shift()
  }

  static async install(page: Page): Promise<PageLoadDiagnostics> {
    await page.addInitScript(installInPage)
    return new PageLoadDiagnostics(page)
  }

  isParityCase(): boolean {
    return new URL(this.page.url(), 'http://x').searchParams.has('case')
  }

  private readPageState(): Promise<Omit<
    PageStateSnapshot,
    'rafCountAfterProbe' | 'rafProbeMs'
  > | null> {
    return withinBudget(this.page.evaluate(readInPageState))
  }

  async snapshot(): Promise<PageLoadSnapshot> {
    const first = this.page.isClosed() ? null : await this.readPageState()
    let page: PageStateSnapshot | null = null
    if (first != null) {
      await new Promise(resolve => setTimeout(resolve, RAF_PROBE_MS))
      const second = await withinBudget(
        this.page.evaluate(
          () => (window as DiagWindow).__e2ePageLoad?.raf ?? -1
        )
      )
      page = {
        ...first,
        rafCountAfterProbe: second ?? first.rafCount,
        rafProbeMs: RAF_PROBE_MS
      }
    }
    const now = Date.now()
    const url = this.page.isClosed() ? '(closed)' : this.page.url()
    return {
      caseName: new URL(url, 'http://x').searchParams.get('case'),
      url,
      msSinceNavigation:
        this.navigatedAt == null ? null : now - this.navigatedAt,
      lastBootStage: this.lastBootStage,
      consoleErrors: [...this.consoleErrors],
      pendingRequests: [...this.pending].map(([r, t]) => ({
        url: r.url(),
        ageMs: now - t
      })),
      page
    }
  }
}

const registry = new WeakMap<Page, PageLoadDiagnostics>()

async function diagnosticsFor(page: Page): Promise<PageLoadDiagnostics> {
  let d = registry.get(page)
  if (d == null) {
    d = await PageLoadDiagnostics.install(page)
    registry.set(page, d)
  }
  return d
}

export class PageLoadTimeoutError extends Error {
  constructor(
    readonly caseName: string,
    readonly timeoutMs: number,
    readonly summary: string
  ) {
    super(
      `parity page did not publish window.__parity within ${timeoutMs} ms ` +
        `(case ${caseName})\n${summary}`
    )
    this.name = 'PageLoadTimeoutError'
  }
}

/**
 * Opens a parity case and waits for the harness probe, as every spec did.
 *
 * Without `timeoutMs` the wait is bounded only by the test timeout, which is
 * what every spec's copy actually did: they passed `{ timeout: 30_000 }` as
 * waitForFunction's SECOND argument, which is the value handed to the page
 * function, not the options (the third). The fixture below reports that case.
 */
export async function loadCase(
  page: Page,
  caseName: string,
  extra: Record<string, string> = {},
  { timeoutMs }: { timeoutMs?: number } = {}
): Promise<void> {
  const diagnostics = await diagnosticsFor(page)
  const params = new URLSearchParams({ case: caseName, e2e: '1', ...extra })
  await page.goto(`/?${params}`)
  const published = () => (window as ParityWindow).__parity != null
  try {
    if (timeoutMs == null) await page.waitForFunction(published)
    else
      await page.waitForFunction(published, undefined, { timeout: timeoutMs })
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error
    const summary = formatPageLoadSummary(await diagnostics.snapshot())
    throw new PageLoadTimeoutError(caseName, timeoutMs ?? 0, summary)
  }
}

/**
 * @playwright/test's `test` plus an automatic fixture: when a test fails while
 * its parity page has not published window.__parity (the test timeout firing
 * mid-load included), the page-load summary is attached and printed
 */
export const test = base.extend<{ pageLoadDiagnostics: PageLoadDiagnostics }>({
  pageLoadDiagnostics: [
    async ({ page }, use, testInfo) => {
      const diagnostics = await diagnosticsFor(page)
      await use(diagnostics)
      if (testInfo.status === testInfo.expectedStatus) return
      if (page.isClosed() || !diagnostics.isParityCase()) return
      const snap = await diagnostics.snapshot()
      if (snap.page?.parityPublished === true) return
      const summary = formatPageLoadSummary(snap)
      await testInfo.attach('page-load-diagnostics', {
        body: summary,
        contentType: 'text/plain'
      })
      console.log(
        `[e2e] page-load diagnostics for "${testInfo.title}":\n${summary}`
      )
    },
    { auto: true }
  ]
})
