import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { buildProvenance } from '../buildDigest.mjs'

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function pnpm(root, args) {
  // Windows installs pnpm as a command shim. Arguments here are fixed, never
  // interpolated user input, and paths are passed as cwd rather than shell text
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args,
    {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    }
  )
  if (result.error) throw result.error
  assert.equal(
    result.status,
    0,
    `pnpm ${args.join(' ')} failed; prepared worktree was preserved`
  )
}

function main() {
  const { values } = parseArgs({
    options: {
      'old-ref': { type: 'string', default: 'a2e4a598' },
      'old-root': { type: 'string' },
      root: { type: 'string', default: process.cwd() },
      'dry-run': { type: 'boolean', default: false }
    }
  })
  const root = realpathSync(resolve(values.root))
  const commit = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${values['old-ref']}^{commit}`
  ])
  assert(/^[a-f0-9]{40}$/.test(commit), 'Old ref must resolve to a full commit')
  const target = resolve(
    values['old-root'] ??
      `${root}/test-results/benchmark-sources/${commit.slice(0, 12)}`
  )
  const plan = {
    oldRef: values['old-ref'],
    commit,
    oldRoot: target,
    newRoot: root
  }
  if (values['dry-run']) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  assert(
    !existsSync(target),
    `Refusing to overwrite ${target}; use the existing prepared root or choose an empty --old-root`
  )
  execFileSync('git', ['worktree', 'add', '--detach', target, commit], {
    cwd: root,
    stdio: 'inherit'
  })
  pnpm(target, ['install', '--frozen-lockfile'])
  pnpm(target, ['build'])
  pnpm(target, ['--filter', 'parity', 'setup-assets'])
  const provenance = buildProvenance(
    target,
    resolve(target, 'examples/parity'),
    'three-clouds-webgpu'
  )
  assert.equal(
    provenance.served?.root,
    realpathSync(target),
    'Old build resolves outside its worktree'
  )
  assert(
    provenance.servedIsBuilt && provenance.built.files.length > 0,
    'Old build provenance mismatch'
  )
  console.log(JSON.stringify({ ...plan, provenance }, null, 2))
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main()
  } catch (error) {
    console.error(`[benchmark prepare] ${error.message}`)
    process.exitCode = 1
  }
}
