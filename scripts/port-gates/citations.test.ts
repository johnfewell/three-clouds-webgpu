import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

interface ExecError {
  stdout?: string
  stderr?: string
  status?: number
}

function isExecError(e: unknown): ExecError {
  return typeof e === 'object' && e !== null ? e : {}
}

const ROOT = join(import.meta.dirname, '../..')
const GATE_DIR = join(ROOT, 'scripts/port-gates')
const FIXTURES = join(GATE_DIR, 'fixtures')

const runCitations = (fixtureDir: string) => {
  try {
    const out = execSync('node ../../citations.mjs src', {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' }
    })
    return { out, code: 0 }
  } catch (e: unknown) {
    const err = isExecError(e)
    return {
      out: (err.stdout ?? '') + (err.stderr ?? ''),
      code: err.status ?? 1
    }
  }
}

describe('citations fixtures', () => {
  it('citations/fail: missing header + misplaced jsdoc, exit 1', () => {
    setCurrentSpec('citations-fail')
    const { out, code } = runCitations(join(FIXTURES, 'citations'))
    log('citations-fail', { stdout: out })
    expect(code).toBe(1)
    expect(out).toContain(
      'MISSING header expected in src/lighting/phaseFunction.ts'
    )
    expect(out).toContain('MISPLACED jsdoc found in src/march/primaryMarch.ts')
    expect(out).toContain('headers FAIL')
    expect(out).toContain('jsdoc FAIL')
  })

  it('citations/pass: all headers ok, no misplaced jsdoc, exit 0', () => {
    setCurrentSpec('citations-pass')
    const { out, code } = runCitations(join(FIXTURES, 'citations-pass'))
    log('citations-pass', { stdout: out })
    expect(code).toBe(0)
    expect(out).not.toContain('MISPLACED')
    // phase.json is 4: the two phase-4 URLs (glm noise.inl, sebh
    // TileableVolumeNoise) are active, so the fixture carries the generators
    expect(out).toContain('citations: 24/24 urls, 11/11 markers')
    expect(out).toContain('phase 4')
    expect(out).toContain('headers ok')
    expect(out).toContain('jsdoc ok')
  })
})
