#!/usr/bin/env node
// The pre-commit gate: eslint and prettier over the staged files, refusing the
// commit on any error so a lint failure is caught here and never in CI
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LINTABLE = /\.[cm]?[jt]sx?$/

/**
 * Split staged paths into what each tool checks. eslint takes the script and
 * type files, and prettier takes everything and skips what it does not know
 */
export function lintableFiles(paths) {
  return { lint: paths.filter(p => LINTABLE.test(p)), format: [...paths] }
}

/** Paths staged for commit that also carry unstaged edits */
export function partlyStaged(staged, unstaged) {
  const changed = new Set(unstaged)
  return staged.filter(p => changed.has(p))
}

const git = (repo, args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)

function tool(repo, name) {
  const bin = join(repo, 'node_modules', '.bin', name)
  if (existsSync(bin)) return bin
  console.error(`[pre-commit] ${name} is not installed: run pnpm install first`)
  process.exit(1)
}

function run(bin, args, repo) {
  return spawnSync(bin, args, { cwd: repo, stdio: 'inherit' }).status === 0
}

function main() {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8'
  }).trim()
  const staged = git(repo, [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--diff-filter=ACMR'
  ])
  const { lint, format } = lintableFiles(staged)
  if (staged.length === 0) {
    console.log('[pre-commit] no staged files to check')
    return
  }
  // The working-tree copy is what gets checked, so say when it differs from the staged one
  const partial = partlyStaged(staged, git(repo, ['diff', '--name-only', '-z']))
  if (partial.length > 0) {
    console.warn(
      `[pre-commit] checking the working tree of ${partial.length} partly staged file(s): ${partial.join(', ')}`
    )
  }
  const lintOk =
    lint.length === 0 ||
    run(
      tool(repo, 'eslint'),
      ['--max-warnings=0', '--no-warn-ignored', ...lint],
      repo
    )
  const formatOk = run(
    tool(repo, 'prettier'),
    ['--check', '--ignore-unknown', ...format],
    repo
  )
  if (!lintOk || !formatOk) {
    console.error(
      '[pre-commit] REFUSED: fix the errors above (pnpm lint:fix, pnpm format), stage, and commit again'
    )
    process.exit(1)
  }
  console.log(
    `[pre-commit] eslint on ${lint.length} and prettier on ${format.length} staged file(s): clean`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
