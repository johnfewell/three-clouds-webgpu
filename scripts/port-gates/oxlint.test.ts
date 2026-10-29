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

const runOxlint = (file: string) => {
  try {
    const out = execSync(
      `pnpm dlx oxlint@1.80.0 -c ${GATE_DIR}/oxlintrc.json ${file}`,
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
      }
    )
    return { out, code: 0 }
  } catch (e: unknown) {
    const err = isExecError(e)
    return {
      out: (err.stdout ?? '') + (err.stderr ?? ''),
      code: err.status ?? 1
    }
  }
}

describe('oxlint complexity gate', () => {
  it('complexity 13 passes (at the limit)', () => {
    setCurrentSpec('oxlint-pass')
    const { out, code } = runOxlint(
      `${GATE_DIR}/fixtures/ts-complexity/pass.ts`
    )
    log('oxlint-pass', { stdout: out })
    expect(code).toBe(0)
    expect(out).not.toMatch(/complexity.*exceeded/i)
  })

  it('complexity 14 fails (over the limit)', () => {
    setCurrentSpec('oxlint-fail')
    const { out, code } = runOxlint(
      `${GATE_DIR}/fixtures/ts-complexity/fail.ts`
    )
    log('oxlint-fail', { stdout: out })
    expect(code).toBe(1)
    expect(out).toContain('complexity')
    expect(out).toContain('14')
  })
})
