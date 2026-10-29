// capture.mjs must REFUSE a broken gate with a distinct exit code, as
// verify-results does, instead of exit 1 plus a stack trace. No green-path
// case here: a valid file launches Chromium (thresholdSchema and exitStates
// cover it). The corrupt file is a TEMP copy via PARITY_THRESHOLDS_PATH

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EXIT_BROKEN_GATE, EXIT_FAILURES } from './thresholdSchema.mjs'

// examples/parity
const EXAMPLE_ROOT = join(import.meta.dirname, '..')
const COMMITTED = join(import.meta.dirname, 'thresholds.json')

function runCapture(thresholdsPath: string): {
  code: number
  output: string
} {
  try {
    execFileSync('node', [join(EXAMPLE_ROOT, 'scripts/capture.mjs')], {
      cwd: EXAMPLE_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PARITY_THRESHOLDS_PATH: thresholdsPath }
    })
    return { code: 0, output: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return {
      code: err.status ?? -1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }
}

interface ThresholdsFile {
  phases: Record<string, Record<string, unknown>>
}

function tempThresholds(mutate: (t: ThresholdsFile) => void): string {
  const parsed = JSON.parse(readFileSync(COMMITTED, 'utf8')) as ThresholdsFile
  mutate(parsed)
  const dir = mkdtempSync(join(tmpdir(), 'capgate-'))
  const path = join(dir, 'thresholds.json')
  writeFileSync(path, JSON.stringify(parsed, null, 2))
  return path
}

describe('capture.mjs refuses a broken gate', () => {
  it('the two codes are distinct', () => {
    expect(EXIT_FAILURES).not.toBe(EXIT_BROKEN_GATE)
  })

  it('exits BROKEN_GATE on a non-numeric threshold, not FAILURES', () => {
    const path = tempThresholds(t => {
      // The exact shape that broke the gate
      t.phases['4']!.deP95 = '<set after first run>'
    })
    const { code, output } = runCapture(path)
    expect(code).toBe(EXIT_BROKEN_GATE)
    expect(code).not.toBe(EXIT_FAILURES)
    expect(output).toContain('REFUSING to run')
    // The refusal must NAME the defect, or the operator learns only that
    // something is wrong with a file
    expect(output).toContain('phase 4 deP95')
  })

  it('exits BROKEN_GATE on malformed JSON too, not just a bad value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capgate-'))
    const path = join(dir, 'thresholds.json')
    writeFileSync(path, '{not json')
    const { code, output } = runCapture(path)
    expect(code).toBe(EXIT_BROKEN_GATE)
    expect(output).toContain('REFUSING to run')
  })

  it('refuses on ONE line and a reason — never a raw stack trace', () => {
    const path = tempThresholds(t => {
      t.phases['0']!.ssim = 'soon'
    })
    const { output } = runCapture(path)
    // The pre-fix behaviour was an unhandled throw out of the module body
    expect(output).not.toContain('at file://')
    expect(output).not.toContain('thresholdSchema.mjs:')
  })

  it('never modifies the committed thresholds file', () => {
    const before = readFileSync(COMMITTED, 'utf8')
    runCapture(
      tempThresholds(t => {
        t.phases['0']!.ssim = 'soon'
      })
    )
    expect(readFileSync(COMMITTED, 'utf8')).toBe(before)
  })
})
