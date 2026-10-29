// Types for jitterFixture.mjs: plain .mjs so setup-assets.mjs and isolate.sh
// can reach it from node with no transpile, declared here for its TypeScript
// test. Same arrangement as receipt-key.mjs

/** Absolute path of the generated route fixture */
export const JITTER_FIXTURE_PATH: string

/** The digest its volume was last written with, beside it */
export const JITTER_FIXTURE_SIDECAR_PATH: string

/** sha256 of NVIDIA's volume, so an old copy is recognised and replaced */
export const NVIDIA_STBN_SHA256: string

/** WIDTH * HEIGHT * DEPTH, the only thing STBNLoader reads from the file */
export const JITTER_FIXTURE_BYTES: number

export function sha256(bytes: Uint8Array): string

/** Candidate (a) from scripts/generate-blue-noise.mjs, the library default */
export function generateJitterFixture(): Uint8Array

/** Where a volume's digest sidecar lives, so a pair can live anywhere */
export function fixtureSidecarPath(path?: string): string

export function fixtureDigest(path?: string): string

/** false when the volume or its sidecar is absent, or neither matches */
export function jitterFixtureIsCurrent(path?: string): boolean

/** Writes the volume and its sidecar when absent or stale, and returns the path */
export function ensureJitterFixture(path?: string): string
