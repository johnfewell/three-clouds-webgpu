// The volume the Playwright and benchmark harnesses answer a `**/stbn.bin`
// route with. Generated, never committed: NVIDIA's own blue-noise data is
// non-commercial-only and is out of this tree (ADR-009 Amendment 3). Full
// rationale in test/fixtures/experimental/README.md

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEPTH,
  generateRankMap,
  goldenVolume,
  HEIGHT,
  SEED,
  WIDTH
} from './generate-blue-noise.mjs'

export const JITTER_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test/fixtures/experimental/stbn.bin'
)

// What NVIDIA's volume hashes to, so a copy left by an older checkout is
// recognised as theirs and replaced rather than answered with. Not a licence
// to serve it. Recorded with the fixture
export const NVIDIA_STBN_SHA256 =
  '51f52f21e5578384585050390821a0a486dcb81e11a716fa7b92fbb6515ba852'

// What STBNLoader in the peer package expects: the file becomes a Uint8Array
// of exactly width * height * depth and nothing else is read from it
export const JITTER_FIXTURE_BYTES = WIDTH * HEIGHT * DEPTH

// Recorded beside the volume so a reader can tell which seed produced it
const GENERATOR = `void-and-cluster rank map + golden offsets, seed 0x${SEED.toString(16)}`

// Staleness is judged against the sidecar, not by regenerating: the rank map
// takes about 0.9 s and setup-assets.mjs runs alongside tests that read the
// files it writes, so a slow step widens a real race window it must not widen
export const JITTER_FIXTURE_SIDECAR_PATH = `${JITTER_FIXTURE_PATH}.sha256.json`

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function generateJitterFixture() {
  return goldenVolume(generateRankMap())
}

// The volume and its sidecar are named by the volume, so a caller can point
// the pair anywhere. That is what lets the tests break a fixture without
// breaking the one the harnesses are reading
export function fixtureSidecarPath(path = JITTER_FIXTURE_PATH) {
  return `${path}.sha256.json`
}

export function fixtureDigest(path = JITTER_FIXTURE_PATH) {
  return sha256(readFileSync(path))
}

// One failure path: the catch covers every absent or unreadable file, and a
// truncated volume and one overwritten with other bytes of the right length
// both change the digest, so the digest subsumes a size comparison
export function jitterFixtureIsCurrent(path = JITTER_FIXTURE_PATH) {
  try {
    const recorded = JSON.parse(readFileSync(fixtureSidecarPath(path), 'utf8'))
    return recorded.digest === fixtureDigest(path)
  } catch {
    return false
  }
}

// Writes only when the volume is absent, stale, or not ours
export function ensureJitterFixture(path = JITTER_FIXTURE_PATH) {
  if (jitterFixtureIsCurrent(path)) return path
  const bytes = generateJitterFixture()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  writeFileSync(
    fixtureSidecarPath(path),
    JSON.stringify(
      { bytes: bytes.length, digest: sha256(bytes), generator: GENERATOR },
      null,
      2
    ) + '\n'
  )
  return path
}
