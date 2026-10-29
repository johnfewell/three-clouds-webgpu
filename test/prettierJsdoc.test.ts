import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as prettier from 'prettier'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from './helpers/log'

// Regression guard for a removed plugin: prettier-plugin-jsdoc rewrote JSDoc PROSE
// (capitalised an identifier, collapsed an aligned table) and did not
// converge, so it was removed. This fails if a prose-rewriting plugin returns

const ROOT = join(import.meta.dirname, '..')

const FIXTURE = `/**
 * correctAltitude=true deck 58591.1-59241.1 m out ( 758.9-1408.9 m AGL)
 * noCorrect=false      deck 12345.6-67890.1 m out (   1.0-  99.9 m AGL)
 *
 * This paragraph exists purely to give a prose-rewriting plugin enough text
 * to reflow so a regression shows up here first: an identifier that starts a
 * comment line, like correctAltitude above, must never be capitalised.
 */
export function scratchFixture(correctAltitude: boolean): number {
  return correctAltitude ? 1 : 0
}
`

describe('prettier JSDoc handling', () => {
  const config = JSON.parse(
    readFileSync(join(ROOT, '.prettierrc'), 'utf8')
  ) as { plugins?: string[] }

  it('does not load prettier-plugin-jsdoc', () => {
    setCurrentSpec('prettier-jsdoc-config')
    log('plugins', { plugins: (config.plugins ?? []).join(',') })
    expect(config.plugins ?? []).not.toContain('prettier-plugin-jsdoc')
  })

  it('leaves an aligned table and a lowercase identifier untouched', async () => {
    setCurrentSpec('prettier-jsdoc-fixture')
    const formatted = await prettier.format(FIXTURE, {
      ...config,
      parser: 'typescript'
    })

    log('fixture', {
      identifierPreserved: formatted.includes('correctAltitude=true'),
      identifierNotCapitalised: !formatted.includes('CorrectAltitude'),
      tableAlignmentPreserved: formatted.includes('noCorrect=false      deck'),
      byteIdentical: formatted === FIXTURE
    })

    // The identifier that opens the first table line must stay lowercase
    expect(formatted).toContain('correctAltitude=true')
    expect(formatted).not.toContain('CorrectAltitude')
    // The second table line's alignment spaces must survive verbatim
    expect(formatted).toContain('noCorrect=false      deck')
    expect(formatted).toContain('(   1.0-  99.9 m AGL)')
    // Plain prettier does not reflow comment prose at all: byte-identical
    expect(formatted).toBe(FIXTURE)
  })

  it('converges: formatting the output again is a no-op', async () => {
    setCurrentSpec('prettier-jsdoc-convergence')
    const once = await prettier.format(FIXTURE, {
      ...config,
      parser: 'typescript'
    })
    const twice = await prettier.format(once, {
      ...config,
      parser: 'typescript'
    })

    log('convergence', { once: once.length, twice: twice.length })
    expect(twice).toBe(once)
  })
})
