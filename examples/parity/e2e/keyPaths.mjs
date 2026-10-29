// THE receipt key's input list: one definition for the writer
// (receiptReporter), the reader (freshBuild's e2eInputsKey) and ciE2eVerdict
// Two copies once meant every receipt compared STALE forever. It
// lives in e2e/, itself a KEY_PATH, so redefining the key re-keys the tree
// .mjs so node runs it untranspiled, typed by the .d.mts beside it

/** Paths whose contents decide what the suite does. NOT results or receipts. */
export const KEY_PATHS = [
  'src',
  'examples/parity/src',
  'examples/parity/e2e',
  'examples/parity/cases',
  // A dependency change alters what the suite does without touching a source
  // file, so the lockfile is an input (TealAnchor's ruling)
  'pnpm-lock.yaml',
  // these decide WHAT the suite compiles and collects, and a narrowed
  // include stops seeing files without erroring (proven both ways: "No test
  // files found", and a planted type error left undetected)
  'examples/parity/tsconfig.json',
  'vitest.config.ts'
]

/**
 * The exact shell pipeline both sides use to hash those paths. Shared for the
 * same reason the list is: a second copy of the EXPRESSION would let the two
 * agree on the inputs and still disagree on the key.
 *
 * @returns {string} a shell command producing the key on stdout
 */
export function keyCommand() {
  return (
    `git ls-files -z -- ${KEY_PATHS.join(' ')} | xargs -0 shasum -a 256 | ` +
    `LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1`
  )
}
