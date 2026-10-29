// The Phase A exit test as a hardware e2e entry: the three-free
// core runtime against the three package, byte for byte, on five ladder
// cases, with two injected faults that must be caught. Hardware only

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

import { freePort } from '../src/e2eSupport/e2ePorts'

const gpuMode =
  process.env.PARITY_GPU ?? (process.env.CI ? 'software' : 'hardware')
const HARDWARE = gpuMode === 'hardware'

const REPO = resolve(import.meta.dirname, '../../..')
const OUT = join(REPO, 'test-results/e2e/core-exit')

interface ExitReport {
  verdict: {
    pass: boolean
    missing: string[]
    failed: string[]
    uncaught: string[]
  }
  verdicts: {
    case: string
    pass: boolean
    compared: number
    identical: number
  }[]
  faults: { fault: string; caught: boolean }[]
}

// The oracle recordings are ~3 GB. They go after every outcome, a timeout
// included, which abandons the test body but still runs afterEach. The
// reports, emitted descriptions and texture hashes (~7 MB) stay
function dropOracles(): string[] {
  if (!existsSync(OUT)) return []
  for (const dir of readdirSync(OUT)) {
    rmSync(join(OUT, dir, 'oracle'), { recursive: true, force: true })
  }
  return readdirSync(OUT).filter(dir => existsSync(join(OUT, dir, 'oracle')))
}

test.describe('core exit', () => {
  test.skip(!HARDWARE, 'hardware-only gate (PARITY_GPU=hardware)')

  test.afterEach(() => {
    expect(dropOracles()).toEqual([])
  })

  test('core runtime matches three bit for bit on the exit cases, faults caught', async () => {
    const info = test.info()
    // Five emits on the CPU, then five oracle recordings and seven replays
    test.setTimeout(20 * 60_000)
    rmSync(OUT, { recursive: true, force: true })
    const port = await freePort()
    const run = spawnSync(
      process.execPath,
      [
        join(REPO, 'core/scripts/exit-test.mjs'),
        '--out',
        OUT,
        '--port',
        String(port)
      ],
      {
        cwd: REPO,
        // The suite built the library once. The exit test refuses a build/
        // older than src/ rather than rebuilding under the running servers
        env: { ...process.env, PARITY_SKIP_BUILD: '1' },
        encoding: 'utf8',
        maxBuffer: 64 << 20
      }
    )
    await info.attach('exit-test.log', {
      body: `${run.stdout}\n${run.stderr}`,
      contentType: 'text/plain'
    })
    const md = join(OUT, 'exit-report.md')
    if (existsSync(md)) await info.attach('exit-report.md', { path: md })

    const report = JSON.parse(
      readFileSync(join(OUT, 'exit-report.json'), 'utf8')
    ) as ExitReport
    expect(report.verdict).toMatchObject({
      missing: [],
      failed: [],
      uncaught: []
    })
    expect(report.verdicts).toHaveLength(5)
    for (const v of report.verdicts) expect(v.identical).toBe(v.compared)
    expect(report.faults.every(f => f.caught)).toBe(true)
    expect(run.status).toBe(0)
  })
})
