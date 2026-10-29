// "the gate is broken" and "cases failed" must not share an exit
// code. A caller reading only the code would take a broken gate for routine
// failure and continue. Uses a fixture, not the committed thresholds file: the
// first version edited that file in place and raced missingReading.test.ts

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EXIT_BROKEN_GATE, EXIT_FAILURES } from './verify-results.mjs'

const ROOT = join(__dirname, '..')
const REAL_THRESHOLDS = join(ROOT, 'examples/parity/cases/thresholds.json')

/** Runs the CLI against a thresholds fixture, never the real file */
function runCli(thresholdsPath?: string): { code: number; stderr: string } {
  try {
    execFileSync('node', [join(ROOT, 'scripts/verify-results.mjs')], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      env:
        thresholdsPath == null
          ? process.env
          : { ...process.env, PARITY_THRESHOLDS_PATH: thresholdsPath }
    })
    return { code: 0, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer }
    return { code: err.status ?? -1, stderr: err.stderr?.toString() ?? '' }
  }
}

describe('verify-results exit states', () => {
  it('the two codes are distinct', () => {
    expect(EXIT_FAILURES).not.toBe(EXIT_BROKEN_GATE)
  })

  it('a corrupt thresholds file exits BROKEN_GATE, not FAILURES', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-states-'))
    const fixture = join(dir, 'thresholds.json')
    const bad = JSON.parse(readFileSync(REAL_THRESHOLDS, 'utf8')) as {
      phases: Record<string, Record<string, unknown>>
    }
    // The exact shape that broke the gate
    bad.phases['4']!.deP95 = '<set after first run>'
    writeFileSync(fixture, JSON.stringify(bad, null, 2))

    const { code, stderr } = runCli(fixture)
    expect(
      code,
      'a file failing its own contract must not share an exit code with ' +
        'ordinary case failures'
    ).toBe(EXIT_BROKEN_GATE)
    expect(stderr).toMatch(/REFUSING to run/)
    expect(stderr).toMatch(/deP95/)
  })

  it('the committed file is valid, so the CLI never reports a broken gate', () => {
    // Guards the guard: if this ever returns 2 on the real file, the contract
    // and the file have diverged and every result below it is untrustworthy
    const { code } = runCli()
    expect(
      code,
      'the committed thresholds.json must satisfy its own contract'
    ).not.toBe(EXIT_BROKEN_GATE)
  })
})
