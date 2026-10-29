#!/usr/bin/env node

// Compute the parity receipt key, and REFUSE a misleading one: no
// key over a dirty KEY_PATH, since that key belongs to no commit. `<commit>`
// hashes its blobs. Lives in scripts/, not a KEY_PATH, so edits never move it
import { execFileSync, execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { KEY_PATHS, keyCommand } from '../examples/parity/e2e/keyPaths.mjs'

/** SHA-256 of the empty string: what an empty pipeline hashes to */
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })

/**
 * KEY_PATHS entries with uncommitted changes, staged or not.
 *
 * @param {string} root
 * @returns {string[]} porcelain lines, empty when the key inputs are clean
 */
export function keyPathsDirty(root) {
  return git(root, ['status', '--porcelain', '--', ...KEY_PATHS])
    .split('\n')
    .filter(line => line.trim().length > 0)
}

/**
 * The key of the WORKING TREE, via the shared pipeline itself.
 *
 * Runs `keyCommand()` rather than reimplementing it: a second copy of the
 * EXPRESSION would let this tool and the receipt writer agree on the inputs and
 * still disagree on the key, which is the defect keyPaths.mjs exists to prevent.
 *
 * @param {string} root
 * @returns {{ key: string, count: number }}
 */
export function keyFromWorktree(root) {
  const dirty = keyPathsDirty(root)
  if (dirty.length > 0) {
    throw new Error(
      `Refusing to compute a working-tree key: ${dirty.length} KEY_PATH ` +
        `entr${dirty.length === 1 ? 'y is' : 'ies are'} dirty, so the result ` +
        `would be a fact about this checkout and not about any commit.\n` +
        dirty.map(l => `  ${l}`).join('\n') +
        `\n\nEither commit them, or pass a commit-ish to hash that commit's ` +
        `blobs instead: node scripts/receipt-key.mjs <sha>`
    )
  }
  const count = countInputs(root)
  const key = execSync(keyCommand(), {
    cwd: root,
    encoding: 'utf8',
    shell: '/bin/sh'
  }).trim()
  return checked(key, count, 'working tree')
}

/**
 * The key of a COMMIT, hashed from its blobs.
 *
 * Reproduces `shasum -a 256 <file>`'s output format (hash, two spaces, path)
 * because that is what the shared pipeline sorts and re-hashes. Calibrated
 * against `keyFromWorktree` on a clean tree by this module's test. Without that
 * check it would be a second implementation nobody had compared.
 *
 * @param {string} root
 * @param {string} commit
 * @returns {{ key: string, count: number }}
 */
export function keyFromCommit(root, commit) {
  const paths = git(root, [
    'ls-tree',
    '-r',
    '--name-only',
    commit,
    '--',
    ...KEY_PATHS
  ])
    .split('\n')
    .filter(p => p.length > 0)

  const lines = paths.map(p => {
    const blob = execFileSync('git', ['cat-file', 'blob', `${commit}:${p}`], {
      cwd: root,
      maxBuffer: 1 << 28
    })
    const h = execFileSync('shasum', ['-a', '256'], {
      input: blob,
      encoding: 'utf8',
      maxBuffer: 1 << 28
    })
      .trim()
      .split(' ')[0]
    return `${h}  ${p}`
  })

  lines.sort()
  const key = execFileSync('shasum', ['-a', '256'], {
    input: lines.join('\n') + (lines.length > 0 ? '\n' : ''),
    encoding: 'utf8'
  })
    .trim()
    .split(' ')[0]
  return checked(key, lines.length, `commit ${commit}`)
}

/**
 * A key over zero inputs is not a key.
 *
 * The empty pipeline returns a well-formed 64-hex string that looks exactly like
 * an answer, which is how an unquoted shell variable that matched nothing once
 * produced a plausible key. Refusing on the COUNT catches it whatever the
 * cause.
 */
function checked(key, count, source) {
  if (count === 0 || key === EMPTY_SHA256) {
    throw new Error(
      `Refusing a key over ${count} inputs from the ${source}: ` +
        `${key === EMPTY_SHA256 ? 'that is SHA-256 of the empty string. ' : ''}` +
        `A key computed over nothing is not a measurement.`
    )
  }
  return { key, count }
}

function countInputs(root) {
  const out = git(root, ['ls-files', '-z', '--', ...KEY_PATHS])
  return out.split('\0').filter(p => p.length > 0).length
}

// Compare resolved URLs, not filenames. A filename-matching main guard silently
// stopped firing when a module was renamed once before, and the
// failure is invisible: the CLI just does nothing and exits 0
const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const root = process.cwd()
  const commit = process.argv[2]
  try {
    const { key, count } = commit
      ? keyFromCommit(root, commit)
      : keyFromWorktree(root)
    // The count rides with the key, always: a key without its n is unreadable,
    // and 260-vs-258 has already been the difference between two announcements
    console.log(`${key}  (${count} inputs, ${commit ?? 'working tree'})`)
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
}
