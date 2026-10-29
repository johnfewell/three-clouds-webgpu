import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../../..')
const PARITY_SRC = 'examples/parity/src'

describe('dogfooding guard', () => {
  it('parity example does not import from ../../src (uses package name)', () => {
    const result = execSync(
      `grep -rnE "from ['\\"](\\.\\./)+(src(/|\\.)|src['\\"]])" ${PARITY_SRC} || true`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim()
    expect(result).toBe('')
  })

  it('parity example does not use import() with relative src path', () => {
    const result = execSync(
      `grep -rnE "import\\(['\\"](\\.\\./)+(src(/|\\.)|src['\\"]])" ${PARITY_SRC} || true`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim()
    expect(result).toBe('')
  })
})
