//
// `run` and `log` are injected so these assert the DECISION, not vite or tsc
// A test that actually built would take seconds and prove nothing about when
// we build, or about what we refuse to run

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  buildProvenance,
  readSourceKey,
  SOURCE_KEY_FILE
} from '../scripts/buildDigest.mjs'
import {
  BUILD_COMMAND,
  e2eReceiptVerdict,
  ensureFreshBuild,
  findRepoRoot,
  TYPECHECK_COMMAND
} from '../scripts/freshBuild.mjs'

// The fixture mirrors the REAL layout, including examples/parity's own src/ and
// package.json, which made "src/ + package.json" stop one level too early. The
// old fixture omitted them, which is why it passed while the repo did not
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'freshbuild-'))
  mkdirSync(join(root, 'build'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n")
  mkdirSync(join(root, 'examples', 'parity', 'e2e'), { recursive: true })
  mkdirSync(join(root, 'examples', 'parity', 'src'), { recursive: true })
  writeFileSync(join(root, 'examples', 'parity', 'package.json'), '{}')
  return root
}

function failBuild(): never {
  throw new Error('build failed')
}

describe('ensureFreshBuild', () => {
  it('typechecks and builds by default, from the repo root', () => {
    // One command: the root `typecheck` script orders build → library tsc →
    // parity tsc (parity resolves the library through build/types). That order
    // is pinned by test/typecheckGate.test.ts
    const root = fakeRepo()
    const calls: string[] = []
    const r = ensureFreshBuild('test', {
      startDir: join(root, 'examples', 'parity'),
      run: c => calls.push(c),
      log: () => {},
      env: {}
    })
    expect(calls).toEqual([TYPECHECK_COMMAND])
    expect(r.built).toBe(true)
    expect(r.typechecked).toBe(true)
    expect(r.root).toBe(root)
  })

  it('refuses to run when the typecheck fails, and names the opt-out', () => {
    // vite build does not typecheck: without this refusal a red tree still
    // captures a complete, plausible table (mail #519)
    const root = fakeRepo()
    const logs: string[] = []
    expect(() =>
      ensureFreshBuild('test', {
        startDir: root,
        run: () => {
          throw new Error('error TS2345')
        },
        log: m => logs.push(m),
        env: {}
      })
    ).toThrow('error TS2345')
    const joined = logs.join(' ')
    expect(joined).toContain('REFUSING')
    expect(joined).toContain('PARITY_SKIP_TYPECHECK=1')
  })

  it('PARITY_SKIP_TYPECHECK=1 builds without the check, and says so', () => {
    // Probe loops on a deliberately red tree need a build without the gate;
    // the opt-out must be as loud as PARITY_SKIP_BUILD's
    const root = fakeRepo()
    const calls: string[] = []
    const logs: string[] = []
    const r = ensureFreshBuild('test', {
      startDir: root,
      run: c => calls.push(c),
      log: m => logs.push(m),
      env: { PARITY_SKIP_TYPECHECK: '1' }
    })
    expect(calls).toEqual([BUILD_COMMAND])
    expect(r.built).toBe(true)
    expect(r.typechecked).toBe(false)
    expect(logs.join(' ')).toContain('without the typecheck')
  })

  describe('build source stamp', () => {
    const KEY = 'a'.repeat(64)
    const PRIOR_KEY = 'b'.repeat(64)

    it('stamps the inputs after a successful typechecked build', () => {
      const root = fakeRepo()
      ensureFreshBuild('test', {
        startDir: root,
        run: () => {},
        log: () => {},
        env: {},
        inputsKey: () => KEY
      })
      expect(readSourceKey(root)).toBe(KEY)
    })

    it('stamps the inputs after a successful unchecked build', () => {
      const root = fakeRepo()
      ensureFreshBuild('test', {
        startDir: root,
        run: () => {},
        log: () => {},
        env: { PARITY_SKIP_TYPECHECK: '1' },
        inputsKey: () => KEY
      })
      expect(readSourceKey(root)).toBe(KEY)
    })

    it('a skipped build cannot forge or replace a source stamp', () => {
      const root = fakeRepo()
      writeFileSync(join(root, 'build', SOURCE_KEY_FILE), PRIOR_KEY)
      ensureFreshBuild('test', {
        startDir: root,
        run: () => {},
        log: () => {},
        env: { PARITY_SKIP_BUILD: '1' },
        inputsKey: () => KEY
      })
      expect(readSourceKey(root)).toBe(PRIOR_KEY)
    })

    it('a missing repo root cannot compute or write a source stamp', () => {
      const root = mkdtempSync(join(tmpdir(), 'freshbuild-no-root-'))
      mkdirSync(join(root, 'build'))
      const inputsKey = vi.fn(() => KEY)
      const result = ensureFreshBuild('test', {
        startDir: root,
        run: () => {},
        log: () => {},
        env: {},
        inputsKey
      })
      expect(result.reason).toBe('no-root')
      expect(inputsKey).not.toHaveBeenCalled()
      expect(readSourceKey(root)).toBeNull()
    })

    it('a failed build invalidates the previous stamp and cannot forge one', () => {
      const root = fakeRepo()
      writeFileSync(join(root, 'build', SOURCE_KEY_FILE), PRIOR_KEY)
      expect(() =>
        ensureFreshBuild('test', {
          startDir: root,
          run: failBuild,
          log: () => {},
          env: {},
          inputsKey: () => KEY
        })
      ).toThrow('build failed')
      expect(readSourceKey(root)).toBeNull()
    })

    it('an absent or empty stamp reads as unproven', () => {
      const root = fakeRepo()
      expect(readSourceKey(root)).toBeNull()
      writeFileSync(join(root, 'build', SOURCE_KEY_FILE), ' \n')
      expect(readSourceKey(root)).toBeNull()
    })

    it('reads the stamp from the built root, not the resolved served root', () => {
      const root = fakeRepo()
      const servedRoot = fakeRepo()
      const exampleRoot = mkdtempSync(join(tmpdir(), 'freshbuild-example-'))
      const packageName = 'three-clouds-webgpu'
      mkdirSync(join(exampleRoot, 'node_modules'))
      writeFileSync(join(root, 'build', 'shared.js'), 'same bytes')
      writeFileSync(join(servedRoot, 'build', 'shared.js'), 'same bytes')
      writeFileSync(join(root, 'build', SOURCE_KEY_FILE), KEY)
      writeFileSync(join(servedRoot, 'build', SOURCE_KEY_FILE), PRIOR_KEY)
      symlinkSync(servedRoot, join(exampleRoot, 'node_modules', packageName))

      const provenance = buildProvenance(root, exampleRoot, packageName)
      expect(provenance.servedIsBuilt).toBe(true)
      expect(provenance.builtFromKey).toBe(KEY)
    })
  })

  it('finds the root from a nested working directory', () => {
    // The capture runner and the e2e gate start from different directories;
    // neither can hardcode a relative path
    const root = fakeRepo()
    expect(findRepoRoot(join(root, 'examples', 'parity', 'e2e'))).toBe(root)
  })

  // The defect: the old marker returned the EXAMPLE as the root, so `pnpm
  // build` rebuilt the example and the rebuild guarantee was false on every e2e
  // run while reporting success, until the typecheck step failed
  it('walks past examples/parity, which is itself a package with a src/', () => {
    const root = fakeRepo()
    const parity = join(root, 'examples', 'parity')

    // Starting INSIDE the example, which is the e2e runner's actual cwd
    expect(findRepoRoot(parity)).toBe(root)
    expect(findRepoRoot(parity)).not.toBe(parity)
  })

  // Returning the root is necessary but not sufficient: what broke was the
  // directory the command RAN in. `pnpm build` is valid in examples/parity,
  // it just builds the wrong thing, so the command string never looked wrong
  it('runs the command in the ROOT, not in the package it started from', () => {
    const root = fakeRepo()
    const cwds: string[] = []
    ensureFreshBuild('test', {
      // The e2e gate's actual starting point, two levels inside the example
      startDir: join(root, 'examples', 'parity', 'e2e'),
      run: (_command, options) => cwds.push(options.cwd),
      log: () => {},
      env: {}
    })
    expect(cwds).toEqual([root])
  })

  // a red e2e refused nothing, so a failing suite still produced a
  // plausible results table. The receipt is PER-TEST because a SKIP is not a
  // pass and a FILTERED run is not a whole one
  describe('e2e receipt', () => {
    const KEY = 'a'.repeat(64)
    const OTHER = 'b'.repeat(64)
    const pass = (title: string) => ({
      spec: 'e2e/p4.spec.ts',
      title,
      status: 'passed'
    })
    const full = (
      tests: Array<{ spec: string; title: string; status: string }>
    ) => ({
      key: KEY,
      filtered: false,
      dirty: false,
      tests,
      // these cases exercise filtered/dirty/skip, so
      // they carry a VALID build proof, or they would all classify as stale on
      // provenance. Provenance has its own describe block below.
      build: {
        builtRoot: '/repo',
        servedRoot: '/repo',
        builtSharedSha256: 'aaaa1111',
        servedSharedSha256: 'aaaa1111',
        servedIsBuilt: true,
        builtFromKey: KEY,
        error: null
      }
    })

    it('is green only for an unfiltered, clean run with no failures', () => {
      expect(e2eReceiptVerdict(full([pass('1')]), KEY).status).toBe('green')
    })

    it('is red when any test failed, and NAMES it', () => {
      const v = e2eReceiptVerdict(
        full([
          pass('1'),
          { spec: 'e2e/p4.spec.ts', title: '2. haze', status: 'failed' }
        ]),
        KEY
      )
      expect(v.status).toBe('red')
      expect(v.detail).toContain('2. haze')
    })

    // A failure outranks every other complaint: a red test is a stronger
    // statement than a dirty tree, and must not be masked by one
    it('reports RED even when the tree was also dirty', () => {
      expect(
        e2eReceiptVerdict(
          {
            key: KEY,
            dirty: true,
            filtered: false,
            tests: [{ spec: 's', title: 't', status: 'failed' }]
          },
          KEY
        ).status
      ).toBe('red')
    })

    // The point of keying on inputs: a receipt for other code says nothing
    // about this code, in either direction
    it('treats a receipt for other inputs as STALE, never green or red', () => {
      expect(
        e2eReceiptVerdict({ ...full([pass('1')]), key: OTHER }, KEY).status
      ).toBe('stale')
      expect(
        e2eReceiptVerdict(
          { key: OTHER, tests: [{ spec: 's', title: 't', status: 'failed' }] },
          KEY
        ).status
      ).toBe('stale')
    })

    it('treats a missing receipt as MISSING, not as a failure', () => {
      expect(e2eReceiptVerdict(null, KEY).status).toBe('missing')
    })

    // A --grep run exercises a fraction of the suite. Calling that green would
    // license a capture on the strength of tests that never executed
    it('treats a FILTERED run as partial, not green', () => {
      expect(
        e2eReceiptVerdict({ ...full([pass('1')]), filtered: true }, KEY).status
      ).toBe('partial')
    })

    // WHICH tests ran decides whether the run satisfies any gate at all, so a
    // count alone leaves a reader to assume the worst
    it('a FILTERED verdict NAMES the tests that ran', () => {
      const v = e2eReceiptVerdict(
        {
          ...full([pass('p0 gate sweep'), pass('b'), pass('c'), pass('d')]),
          filtered: true
        },
        KEY
      )
      expect(v.detail).toContain('p0 gate sweep')
      expect(v.detail).toContain('(+1 more)')
    })

    it('treats a receipt with no tests as partial', () => {
      expect(e2eReceiptVerdict(full([]), KEY).status).toBe('partial')
    })

    // Skips do not refuse (some are structural, and a gate that fires when
    // nothing is wrong gets disabled), but they never count as passes, and the
    // detail names which evidence is absent
    it('counts a skip as green-with-a-caveat, and says skipped is not passed', () => {
      const v = e2eReceiptVerdict(
        full([pass('1'), { spec: 's', title: '8. webgl2', status: 'skipped' }]),
        KEY
      )
      expect(v.status).toBe('green')
      expect(v.detail).toContain('SKIPPED')
      expect(v.detail).toContain('skipped is not passed')
      expect(v.detail).toContain('8. webgl2')
    })

    it('REFUSES a capture when the receipt is red for these inputs', () => {
      const root = fakeRepo()
      const logs: string[] = []
      expect(() =>
        ensureFreshBuild('capture', {
          startDir: root,
          run: () => {},
          log: m => logs.push(m),
          env: {},
          requireGreenE2e: true,
          readReceipt: () => ({
            key: KEY,
            filtered: false,
            dirty: false,
            tests: [
              { spec: 'e2e/p4.spec.ts', title: '2. haze', status: 'failed' }
            ]
          }),
          inputsKey: () => KEY
        })
      ).toThrow(/e2e receipt is red/)
      const joined = logs.join(' ')
      expect(joined).toContain('REFUSING')
      expect(joined).toContain('2. haze')
      expect(joined).toContain('PARITY_SKIP_E2E_RECEIPT=1')
    })

    // The deadlock guard: the e2e runner itself calls ensureFreshBuild, so a
    // red suite must not block the run that would make it green again
    it('does NOT check the receipt unless the caller opts in', () => {
      const root = fakeRepo()
      expect(() =>
        ensureFreshBuild('e2e/p4', {
          startDir: root,
          run: () => {},
          log: () => {},
          env: {},
          readReceipt: () => ({
            key: KEY,
            tests: [{ spec: 's', title: 't', status: 'failed' }]
          }),
          inputsKey: () => KEY
        })
      ).not.toThrow()
    })

    it('proceeds on an unknown receipt, saying the capture is unbacked', () => {
      const root = fakeRepo()
      const logs: string[] = []
      ensureFreshBuild('capture', {
        startDir: root,
        run: () => {},
        log: m => logs.push(m),
        env: {},
        requireGreenE2e: true,
        readReceipt: () => ({ ...full([pass('1')]), key: OTHER }),
        inputsKey: () => KEY
      })
      expect(logs.join(' ')).toContain('NOT backed by a passing suite')
    })

    it('honours PARITY_SKIP_E2E_RECEIPT=1', () => {
      const root = fakeRepo()
      expect(() =>
        ensureFreshBuild('capture', {
          startDir: root,
          run: () => {},
          log: () => {},
          env: { PARITY_SKIP_E2E_RECEIPT: '1' },
          requireGreenE2e: true,
          readReceipt: () => ({
            key: KEY,
            tests: [{ spec: 's', title: 't', status: 'failed' }]
          }),
          inputsKey: () => KEY
        })
      ).not.toThrow()
    })
  })

  it('does not build when PARITY_SKIP_BUILD=1, and says the build may be stale', () => {
    const root = fakeRepo()
    const calls: string[] = []
    const logs: string[] = []
    const r = ensureFreshBuild('test', {
      startDir: root,
      run: c => calls.push(c),
      log: m => logs.push(m),
      env: { PARITY_SKIP_BUILD: '1' }
    })
    expect(calls).toEqual([])
    expect(r.built).toBe(false)
    expect(r.typechecked).toBe(false)
    // The opt-out has to be loud: a silent skip recreates the exact failure
    // this module exists to prevent
    expect(logs.join(' ')).toContain('stale')
  })

  it('degrades to a warning rather than throwing when there is no repo root', () => {
    const calls: string[] = []
    const r = ensureFreshBuild('test', {
      startDir: tmpdir(),
      run: c => calls.push(c),
      log: () => {},
      env: {}
    })
    expect(calls).toEqual([])
    expect(r.built).toBe(false)
    expect(r.reason).toBe('no-root')
  })

  it('propagates a build failure instead of running on stale output', () => {
    const root = fakeRepo()
    expect(() =>
      ensureFreshBuild('test', {
        startDir: root,
        run: () => {
          throw new Error('vite exploded')
        },
        log: () => {},
        env: {}
      })
    ).toThrow('vite exploded')
  })
})

// a receipt must prove WHICH BYTES the suite ran. The
// key covers git-tracked sources, never the gitignored build, and a symlinked
// worktree once served the shared checkout's stale build. Absent proof fails.
describe('receipt build provenance', () => {
  const key = 'abc123'
  const passing = [{ spec: 'p0.spec.ts', title: 'boots', status: 'passed' }]
  const goodBuild = {
    builtRoot: '/repo',
    servedRoot: '/repo',
    builtSharedSha256: 'aaaa1111',
    servedSharedSha256: 'aaaa1111',
    servedIsBuilt: true,
    builtFromKey: key,
    error: null
  }

  it('a receipt with no build proof is STALE, not green', () => {
    const v = e2eReceiptVerdict(
      { key, filtered: false, dirty: false, tests: passing },
      key
    )
    expect(v.status).toBe('stale')
    expect(v.detail).toMatch(/no build provenance/)
  })

  it('a receipt whose served build is not the built one is STALE', () => {
    const v = e2eReceiptVerdict(
      {
        key,
        filtered: false,
        dirty: false,
        tests: passing,
        build: {
          ...goodBuild,
          servedRoot: '/shared-checkout',
          servedSharedSha256: 'bbbb2222',
          servedIsBuilt: false
        }
      },
      key
    )
    expect(v.status).toBe('stale')
    // The detail must name BOTH roots: the hash says the bytes differed, the
    // path says why (in the real incident, the symlink)
    expect(v.detail).toContain('/shared-checkout')
    expect(v.detail).toContain('/repo')
  })

  it('a proven-resolving receipt is green', () => {
    const v = e2eReceiptVerdict(
      { key, filtered: false, dirty: false, tests: passing, build: goodBuild },
      key
    )
    expect(v.status).toBe('green')
  })

  it('a build stamped from other inputs is STALE even when servedIsBuilt is true', () => {
    const builtFromKey = 'other-inputs'
    const v = e2eReceiptVerdict(
      {
        key,
        filtered: false,
        dirty: false,
        tests: passing,
        build: { ...goodBuild, builtFromKey }
      },
      key
    )
    expect(v.status).toBe('stale')
    expect(v.detail).toContain('STALE BYTES')
    expect(v.detail).toContain(builtFromKey)
    expect(v.detail).toContain(key)
  })

  it('an unstamped build is STALE as unproven, not mislabeled as a mismatch', () => {
    const v = e2eReceiptVerdict(
      {
        key,
        filtered: false,
        dirty: false,
        tests: passing,
        build: { ...goodBuild, builtFromKey: null }
      },
      key
    )
    expect(v.status).toBe('stale')
    expect(v.detail).toContain('no source stamp')
    expect(v.detail).not.toContain('STALE BYTES')
  })

  it('a pre-field receipt is STALE as unproven', () => {
    const build = { ...goodBuild }
    expect(Reflect.deleteProperty(build, 'builtFromKey')).toBe(true)
    const v = e2eReceiptVerdict(
      { key, filtered: false, dirty: false, tests: passing, build },
      key
    )
    expect(v.status).toBe('stale')
    expect(v.detail).toContain('no source stamp')
  })

  it('a RED receipt stays red when its build stamp is absent', () => {
    const v = e2eReceiptVerdict(
      {
        key,
        filtered: false,
        dirty: false,
        tests: [{ spec: 'p0.spec.ts', title: 'boots', status: 'failed' }],
        build: { ...goodBuild, builtFromKey: null }
      },
      key
    )
    expect(v.status).toBe('red')
  })

  it('a RED receipt stays red — failures outrank provenance', () => {
    const v = e2eReceiptVerdict(
      {
        key,
        filtered: false,
        dirty: false,
        tests: [{ spec: 'p0.spec.ts', title: 'boots', status: 'failed' }]
      },
      key
    )
    expect(v.status).toBe('red')
  })
})
