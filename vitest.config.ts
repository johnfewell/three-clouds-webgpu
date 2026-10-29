import { defineConfig } from 'vitest/config'

// One include list for both projects, because a pattern that lives in only one
// of them is silently collected by nothing (the trap the list's own comment
// cites, one level up)
const INCLUDE = [
  // .tsx as well as .ts: the r3f component tests are JSX, and a pattern
  // that cannot match them silently never collects them
  'src/**/*.test.{ts,tsx}',
  'test/**/*.test.ts',
  'scripts/**/*.test.{ts,mjs}',
  'examples/parity/src/**/*.test.ts',
  'examples/parity/cases/**/*.test.ts',
  // probes/ carries instrumentation modules. Without this pattern
  // a test here is collected by NOTHING, the same silent-zero trap as above
  'examples/parity/probes/**/*.test.ts',
  // The private three-free core (core/), its CPU twins against the port
  'core/{src,test}/**/*.test.ts',
  // core/emit is build-time and imports three, so it sits outside core/src
  'core/emit/**/*.test.ts'
]

// The serial group, for EXCLUSIVITY rather than speed: vitest awaits each
// groupOrder bucket before the next, so nothing here overlaps anything else

// graphVariantDigest needs the machine to itself. It compiles ~50
// pass graphs to WGSL and digests them, ~90 s of near-exclusive CPU on a
// quiet box, over 600 s when 214 other files compile beside it

// The rest read or rebuild this tree's build/ and types/. vite empties build/
// before it writes, so a parallel-group reader catches it empty: ENOENT on
// build/shared.js, or a scan over zero files that passes vacuously

// test/realBuildSerialization.test.ts keeps this list and that set in step
const SERIAL_FILES = [
  'src/pass/graphVariantDigest.test.ts',
  'test/captureProvenance.test.ts',
  'test/packageReadiness.test.ts',
  'test/threeInternalImports.test.ts',
  'test/threeStructCompat.test.ts'
]

const SHARED = {
  globals: true,
  environment: 'node' as const,
  exclude: ['reference/**', 'node_modules/**'],
  setupFiles: ['test/helpers/setup.ts'],
  // The e2e verdict test used to write the tracked receipt in place, so a
  // killed run left the tree dirty and a concurrent clean-tree assertion read
  // it as dirt it did not cause. globalSetup snapshots outside the pool
  globalSetup: ['test/helpers/gitTreeGuard.ts']
}

export default defineConfig({
  test: {
    // reporters, outputFile and coverage are ROOT-only in vitest's types, and
    // the reporters are built once for the whole run, so both projects land in
    // the one junit file rather than overwriting each other
    reporters: ['default', 'junit'],
    outputFile: { junit: 'test-results/junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage'
    },
    // Vitest buckets files by sequence.groupOrder and AWAITS each group
    // before starting the next, so these two projects are sequential by
    // construction rather than by a second `pnpm test` invocation
    projects: [
      {
        test: {
          ...SHARED,
          name: 'three-clouds-webgpu',
          include: INCLUDE,
          exclude: [...SHARED.exclude, ...SERIAL_FILES],
          // vitest's 5 s default is below what these files do UNLOADED, let
          // alone under a dozen agents on one box, and it buys nothing as a
          // hang detector. Raised to what these files already budget
          testTimeout: 60_000,
          hookTimeout: 300_000,
          // Half the cores, not all of them: the suite is CPU-bound per file
          // and the box is shared, so a worker starved mid-compile is what the
          // timeouts above have to absorb. Slower, reachable timeouts: the trade
          maxWorkers: '50%',
          sequence: { groupOrder: 0, seed: 1337 }
        }
      },
      {
        test: {
          ...SHARED,
          name: 'serial',
          include: SERIAL_FILES,
          maxWorkers: 1,
          sequence: { groupOrder: 1, seed: 1337 },
          // Sized from the worst OBSERVED, not from the ~90 s unloaded run:
          // alone in its group under a deliberate 16-core load it still took
          // 475 s, and the fleet's documented worst is load 50-70
          testTimeout: 1_800_000,
          hookTimeout: 1_800_000
        }
      }
    ]
  }
})
