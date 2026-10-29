// which bytes did the dev server serve? The
// receipt key covers tracked sources, never the gitignored build/, and a
// symlinked worktree once served the shared checkout's stale build. The test
// is whether parity's node_modules is a REAL dir or a SYMLINK, so the resolved
// root is recorded. Lifted from PinkWaterfall's probe (b8f0dfc), not rewritten

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Build-local record of the e2e input key that produced the artifacts */
export const SOURCE_KEY_FILE = '.source-key'

/**
 * Read the source key stamped by a successful build.
 *
 * Missing and empty stamps both mean unproven. They must not be reported as a
 * mismatch, which would claim knowledge the artifact does not carry.
 *
 * @param {string} root package root containing `build/`
 * @returns {string | null}
 */
export function readSourceKey(root) {
  try {
    const raw = readFileSync(
      join(root, 'build', SOURCE_KEY_FILE),
      'utf8'
    ).trim()
    return raw === '' ? null : raw
  } catch {
    return null
  }
}

/**
 * Digest of every built .js under `<root>/build`, plus `shared.js` on its own.
 *
 * `shared.js` is called out because `index.js` is a ~1.7 kB re-export shim that
 * barely changes between builds, so hashing it would look stable across a real
 * change (the reason the freshness check names shared.js).
 *
 * @param {string} root
 * @returns {{ root: string, files: string[], digest: string, sharedSha256: string }}
 */
export function buildDigest(root) {
  const dir = join(root, 'build')
  const files = readdirSync(dir)
    .filter(name => name.endsWith('.js'))
    .sort()
  const hash = createHash('sha256')
  for (const name of files) {
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(dir, name)))
      .update('\0')
  }
  return {
    root,
    files,
    digest: hash.digest('hex'),
    sharedSha256: createHash('sha256')
      .update(readFileSync(join(dir, 'shared.js')))
      .digest('hex')
  }
}

/**
 * The physical root a package name resolves to from `<exampleRoot>/node_modules`.
 *
 * realpath is the point: a symlinked node_modules resolves the relative
 * self-link against its physical location, which is how a worktree ends up
 * serving the shared checkout's build.
 *
 * @param {string} exampleRoot examples/parity
 * @param {string} name package name, e.g. 'three-clouds-webgpu'
 * @returns {string}
 */
export function resolvedPackageRoot(exampleRoot, name) {
  return realpathSync(join(exampleRoot, 'node_modules', ...name.split('/')))
}

/**
 * The proof a receipt carries: the build that was PRODUCED and the build that
 * was SERVED, and whether they were the same bytes.
 *
 * Recorded at run time rather than checked later, because a later check would
 * have to rebuild, and a rebuild elsewhere can differ for unrelated reasons,
 * making every receipt read stale forever.
 *
 * @param {string} projectRoot repo root
 * @param {string} exampleRoot examples/parity
 * @param {string} packageName the package the harness imports
 */
export function buildProvenance(projectRoot, exampleRoot, packageName) {
  const built = buildDigest(realpathSync(projectRoot))
  let served = null
  let error = null
  try {
    served = buildDigest(resolvedPackageRoot(exampleRoot, packageName))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  return {
    built,
    served,
    error,
    // The one boolean an acceptance actually needs. `false` means the suite
    // exercised bytes other than the ones this tree builds
    servedIsBuilt: served != null && served.digest === built.digest,
    // Which inputs produced the built bytes. `servedIsBuilt` cannot answer this
    // in a single checkout because built and served are the same directory
    builtFromKey: readSourceKey(built.root)
  }
}
