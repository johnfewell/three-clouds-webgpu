// The `**/stbn.bin` route fixture is GENERATED and untracked. It used to be
// NVIDIA's spatiotemporal blue-noise volume, carried here beside an MIT
// licence block that did not describe it: NVIDIA publishes that data under a
// Non-Commercial Use License, so an MIT repository may not redistribute it
// See ADR-009 Amendment 3 and test/fixtures/experimental/README.md

// Every arm that breaks something breaks it in a TEMP path. Vitest runs this
// file alongside the suites that read the real fixture through setup-assets
// and a test that truncates the shared one breaks them, not itself
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureJitterFixture,
  fixtureDigest,
  fixtureSidecarPath,
  generateJitterFixture,
  JITTER_FIXTURE_BYTES,
  JITTER_FIXTURE_PATH,
  JITTER_FIXTURE_SIDECAR_PATH,
  jitterFixtureIsCurrent,
  NVIDIA_STBN_SHA256,
  sha256
} from '../scripts/jitterFixture.mjs'
import { log } from './helpers/log'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELATIVE = 'test/fixtures/experimental/stbn.bin'

let scratch: string

beforeEach(() => {
  scratch = join(mkdtempSync(join(tmpdir(), 'jitter-')), 'stbn.bin')
})
afterEach(() => {
  rmSync(dirname(scratch), { recursive: true, force: true })
})

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '--', 'test/fixtures'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(line => line.length > 0)
}

describe('the generated volume', () => {
  it('is exactly the byte count STBNLoader reads', () => {
    const bytes = generateJitterFixture()
    log('jitter-fixture', {
      generated: bytes.length,
      expected: JITTER_FIXTURE_BYTES,
      equal: bytes.length === JITTER_FIXTURE_BYTES
    })
    expect(bytes.length).toBe(JITTER_FIXTURE_BYTES)
  })

  it('is not NVIDIA’s volume', () => {
    const digest = sha256(generateJitterFixture())
    log('jitter-fixture-not-nvidia', {
      generated: digest,
      nvidia: NVIDIA_STBN_SHA256,
      distinct: digest !== NVIDIA_STBN_SHA256
    })
    expect(digest).not.toBe(NVIDIA_STBN_SHA256)
  })

  it('is deterministic across generations', () => {
    const first = sha256(generateJitterFixture())
    const second = sha256(generateJitterFixture())
    log('jitter-fixture-deterministic', {
      first,
      second,
      equal: first === second
    })
    expect(first).toBe(second)
  })
})

describe('staleness detection', () => {
  it('reports an absent volume as not current', () => {
    log('jitter-fixture-absent', { isCurrent: jitterFixtureIsCurrent(scratch) })
    expect(jitterFixtureIsCurrent(scratch)).toBe(false)
  })

  it('reports a volume of the wrong length as not current', () => {
    ensureJitterFixture(scratch)
    // Truncated in place: the shape the peer loader would silently misread,
    // and the shape a half-finished generate leaves behind
    writeFileSync(scratch, Buffer.alloc(JITTER_FIXTURE_BYTES - 1))
    log('jitter-fixture-truncated', {
      expected: JITTER_FIXTURE_BYTES,
      isCurrent: jitterFixtureIsCurrent(scratch)
    })
    expect(jitterFixtureIsCurrent(scratch)).toBe(false)
  })

  it('reports a volume whose bytes changed under a valid sidecar as not current', () => {
    ensureJitterFixture(scratch)
    // The right length, wrong content. Only the digest catches this, which is
    // why the sidecar records one
    writeFileSync(scratch, Buffer.alloc(JITTER_FIXTURE_BYTES, 0x5a))
    log('jitter-fixture-swapped', {
      digest: fixtureDigest(scratch),
      isCurrent: jitterFixtureIsCurrent(scratch)
    })
    expect(jitterFixtureIsCurrent(scratch)).toBe(false)
  })

  it('reports a missing sidecar as not current', () => {
    ensureJitterFixture(scratch)
    rmSync(fixtureSidecarPath(scratch))
    log('jitter-fixture-no-sidecar', {
      isCurrent: jitterFixtureIsCurrent(scratch)
    })
    expect(jitterFixtureIsCurrent(scratch)).toBe(false)
  })

  it('regenerates a stale volume and reports it current', () => {
    ensureJitterFixture(scratch)
    writeFileSync(scratch, Buffer.alloc(JITTER_FIXTURE_BYTES - 1))
    expect(jitterFixtureIsCurrent(scratch)).toBe(false)
    ensureJitterFixture(scratch)
    log('jitter-fixture-regenerated', {
      digest: fixtureDigest(scratch),
      isCurrent: jitterFixtureIsCurrent(scratch)
    })
    expect(jitterFixtureIsCurrent(scratch)).toBe(true)
  })

  it('restores a missing sidecar', () => {
    ensureJitterFixture(scratch)
    rmSync(fixtureSidecarPath(scratch))
    ensureJitterFixture(scratch)
    log('jitter-fixture-sidecar-restored', {
      sidecar: existsSync(fixtureSidecarPath(scratch)),
      isCurrent: jitterFixtureIsCurrent(scratch)
    })
    expect(jitterFixtureIsCurrent(scratch)).toBe(true)
  })

  it('leaves a current volume alone rather than rewriting it', () => {
    // Rewriting unconditionally would widen the window setup-assets.mjs runs
    // in against the suites that stat what it writes
    ensureJitterFixture(scratch)
    const before = statSync(scratch).mtimeMs
    ensureJitterFixture(scratch)
    log('jitter-fixture-untouched', {
      before,
      after: statSync(scratch).mtimeMs
    })
    expect(statSync(scratch).mtimeMs).toBe(before)
  })
})

describe('the repository', () => {
  it('keeps NVIDIA’s data and the licence claim out of the index', () => {
    const files = tracked()
    log('jitter-fixture-index', {
      tracked: files.join(' | ') || '(none)',
      carriesData: files.includes(RELATIVE),
      carriesSidecar: files.includes(RELATIVE + '.sha256.json'),
      carriesLicense: files.includes('test/fixtures/experimental/LICENSE')
    })
    expect(files).not.toContain(RELATIVE)
    expect(files).not.toContain(RELATIVE + '.sha256.json')
    expect(files).not.toContain('test/fixtures/experimental/LICENSE')
    expect(files).toContain('test/fixtures/experimental/README.md')
  })

  it('ignores the generated pair, so a local volume cannot be committed', () => {
    const ignored = execFileSync(
      'git',
      ['check-ignore', '-v', RELATIVE, RELATIVE + '.sha256.json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    log('jitter-fixture-gitignore', {
      rules: ignored.trim().split('\n').length
    })
    expect(ignored).toContain(RELATIVE)
    expect(ignored).toContain('sha256.json')
  })

  it('names the shared fixture and its sidecar the same way the module does', () => {
    // One path definition, or a test could pass against a temp copy while the
    // harnesses kept reading a path nothing provisions
    expect(fixtureSidecarPath()).toBe(JITTER_FIXTURE_SIDECAR_PATH)
    expect(fixtureSidecarPath(JITTER_FIXTURE_PATH)).toBe(
      JITTER_FIXTURE_SIDECAR_PATH
    )
    expect(JITTER_FIXTURE_PATH.endsWith('experimental/stbn.bin')).toBe(true)
  })
})
