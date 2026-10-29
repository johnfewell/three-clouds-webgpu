import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  captureProvenance,
  EMPTY_SHA256,
  provenanceLine,
  receiptState,
  refuseUnlessServedIsBuilt,
  skipState,
  type CaptureProvenance
} from '../examples/parity/scripts/captureProvenance.mjs'

const ROOT = join(import.meta.dirname, '..')
const EXAMPLE_ROOT = join(ROOT, 'examples', 'parity')
const PACKAGE = 'three-clouds-webgpu'

// Override terms (b) and (c), as ruled for the case-45 register entry:
// a capture receipt quotes overrideArmed and the tree key, and the capture
// refuses when the served build is not the one just built
describe('captureProvenance', () => {
  it('records the override only when PARITY_SKIP_E2E_RECEIPT=1, beside the tree key', () => {
    const armed = receiptState(ROOT, { PARITY_SKIP_E2E_RECEIPT: '1' })
    const off = receiptState(ROOT, {})
    expect(armed.overrideArmed).toBe(true)
    expect(off.overrideArmed).toBe(false)
    expect(armed.inputsKey).toMatch(/^[0-9a-f]{64}$/)
    expect(armed.inputsKey).not.toBe(EMPTY_SHA256)
    expect(off.inputsKey).toBe(armed.inputsKey)
    expect(typeof armed.verdict).toBe('string')
  })

  it('a key of nothing is a refusal, not a receipt', () => {
    expect(() =>
      receiptState(ROOT, {}, { inputsKey: () => EMPTY_SHA256 })
    ).toThrow(/key of nothing/)
    expect(() => receiptState(ROOT, {}, { inputsKey: () => null })).toThrow(
      /key of nothing/
    )
  })

  it('refuses when the served build is not the built one, and only then', () => {
    const base: CaptureProvenance = {
      // a receipt now names the tree it measured, so the fixture does
      // too. The served tree is this fixture's own commit, i.e. in lineage
      servedTree: { root: '<tmp>/fixture', head: 'a'.repeat(40), error: null },
      git: { commit: 'a'.repeat(40), branch: 'x', dirty: 0 },
      e2e: {
        inputsKey: 'b'.repeat(64),
        verdict: 'stale',
        detail: '',
        overrideArmed: true
      },
      build: {
        built: {
          root: '/built',
          files: [],
          digest: 'c'.repeat(64),
          sharedSha256: ''
        },
        served: {
          root: '/served',
          files: [],
          digest: 'd'.repeat(64),
          sharedSha256: ''
        },
        error: null,
        servedIsBuilt: false,
        builtFromKey: null
      },
      // required, so a fixture cannot
      // quietly omit it and leave the field untested by this file
      skips: { build: false, typecheck: false }
    }
    expect(() => refuseUnlessServedIsBuilt(base, PACKAGE)).toThrow(
      /Refusing hardware evidence.*\/served.*\/built/
    )
    expect(() =>
      refuseUnlessServedIsBuilt(
        { ...base, build: { ...base.build, servedIsBuilt: true } },
        PACKAGE
      )
    ).not.toThrow()
    expect(() =>
      refuseUnlessServedIsBuilt(
        { ...base, build: { ...base.build, served: null, error: 'ENOENT' } },
        PACKAGE
      )
    ).toThrow(/nothing.*ENOENT/)
  })

  // these two skips used to be warned
  // about at runtime and stamped nowhere. Four states each way, because a test
  // proving only the "1" case would pass an always-true skipState
  it('stamps each per-run skip only when its own variable is armed', () => {
    expect(skipState({})).toEqual({ build: false, typecheck: false })
    expect(skipState({ PARITY_SKIP_BUILD: '1' })).toEqual({
      build: true,
      typecheck: false
    })
    expect(skipState({ PARITY_SKIP_TYPECHECK: '1' })).toEqual({
      build: false,
      typecheck: true
    })
    expect(
      skipState({ PARITY_SKIP_BUILD: '1', PARITY_SKIP_TYPECHECK: '1' })
    ).toEqual({
      build: true,
      typecheck: true
    })
    // '0' and other values are NOT armed: only the literal '1' skips, the same
    // test capture-time makes, so a truthiness bug here would diverge from it
    expect(
      skipState({ PARITY_SKIP_BUILD: '0', PARITY_SKIP_TYPECHECK: 'yes' })
    ).toEqual({
      build: false,
      typecheck: false
    })
  })

  // The stamps have to REACH the artifact, not just the log: this is the
  // difference the task is about, and a skipState the writer dropped would
  // leave every test above green
  it('captureProvenance carries the skips, and the log line states them', () => {
    const p = captureProvenance({
      projectRoot: ROOT,
      exampleRoot: EXAMPLE_ROOT,
      packageName: PACKAGE,
      env: { PARITY_SKIP_BUILD: '1' }
    })
    expect(p.skips).toEqual({ build: true, typecheck: false })
    expect(provenanceLine('[t]', p)).toContain(
      'skips(build=true typecheck=false)'
    )
    expect(
      provenanceLine('[t]', { ...p, skips: { build: false, typecheck: false } })
    ).toContain('skips(build=false typecheck=false)')
  })

  // Needs build/ (pnpm check builds first; a bare `pnpm test` on a fresh clone
  // has nothing to digest). Skipped visibly rather than passing vacuously.
  it.skipIf(!existsSync(join(ROOT, 'build', 'shared.js')))(
    'the real tree stamps git, e2e and build, and the log line names all three',
    () => {
      const p = captureProvenance({
        projectRoot: ROOT,
        exampleRoot: EXAMPLE_ROOT,
        packageName: PACKAGE,
        env: {}
      })
      expect(p.git.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(p.build.built.digest).toMatch(/^[0-9a-f]{64}$/)
      const line = provenanceLine('[t]', p)
      expect(line).toContain(`commit ${p.git.commit.slice(0, 7)}`)
      expect(line).toContain(`key ${p.e2e.inputsKey.slice(0, 12)}`)
      expect(line).not.toContain('OVERRIDE')
      expect(line).toContain(`servedIsBuilt ${String(p.build.servedIsBuilt)}`)
      expect(
        provenanceLine('[t]', {
          ...p,
          e2e: { ...p.e2e, overrideArmed: true }
        })
      ).toContain('OVERRIDE(PARITY_SKIP_E2E_RECEIPT=1)')
    }
  )
})
