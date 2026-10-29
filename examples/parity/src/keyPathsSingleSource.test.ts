// the receipt key's WRITER (receiptReporter) and READER (freshBuild's
// e2eInputsKey) must agree by construction. With separate path lists, a path
// added to the writer alone makes every receipt compare STALE forever, with no
// error anywhere

import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KEY_PATHS, keyCommand } from '../e2e/keyPaths.mjs'
import { e2eInputsKey } from '../scripts/freshBuild.mjs'

const REPO_ROOT = resolve(__dirname, '../../..')

describe('receipt key: one definition, writer == reader', () => {
  it('the reader computes exactly the key the shared command produces', () => {
    // The functional guard. A hardcoded list reintroduced on either side makes
    // these stop matching, and this fails: the whole point
    const readerKey = e2eInputsKey(REPO_ROOT)
    const sharedKey = execSync(keyCommand(), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    }).trim()

    expect(readerKey, 'git could not answer; not a pass').not.toBeNull()
    expect(sharedKey).toMatch(/^[0-9a-f]{64}$/)
    expect(
      readerKey,
      'the reader (freshBuild.e2eInputsKey) and the shared key command ' +
        'disagree — someone has a second copy of the path list or the ' +
        'hashing pipeline, and receipts will read STALE forever'
    ).toBe(sharedKey)
  })

  it('the writer re-exports the shared list rather than declaring its own', async () => {
    const reporter = (await import('../e2e/receiptReporter')) as {
      KEY_PATHS: readonly string[]
    }
    // Reference identity, not deep equality: two arrays that happen to match
    // today are exactly the situation this task was filed about
    expect(
      reporter.KEY_PATHS,
      'receiptReporter must re-export KEY_PATHS from keyPaths.mjs, not ' +
        'declare a list that merely looks the same'
    ).toBe(KEY_PATHS)
  })

  it('the list still contains the coverage-deciding configs', () => {
    // Cheap anti-rot: the two entries this task exists to add
    expect(KEY_PATHS).toContain('examples/parity/tsconfig.json')
    expect(KEY_PATHS).toContain('vitest.config.ts')
  })
})
