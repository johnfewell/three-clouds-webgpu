import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const cli = resolve('examples/parity/scripts/benchmarks/prepare.mjs')

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-benchmark-source-'))
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git(['init', '-q'])
  git(['config', 'user.name', 'Benchmark test'])
  git(['config', 'user.email', 'benchmark@example.invalid'])
  writeFileSync(join(root, 'fixture.txt'), 'fixture')
  git(['add', 'fixture.txt'])
  git(['commit', '-qm', 'fixture'])
  return { root, commit: git(['rev-parse', 'HEAD']) }
}

describe('portable benchmark baseline preparation', () => {
  it('resolves the exact revision without creating a worktree in dry-run', () => {
    const repo = repository()
    const target = join(repo.root, 'old source with spaces')
    const result = spawnSync(
      process.execPath,
      [
        cli,
        '--root',
        repo.root,
        '--old-ref',
        'HEAD',
        '--old-root',
        target,
        '--dry-run'
      ],
      { encoding: 'utf8' }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      commit: repo.commit,
      oldRoot: target
    })
    expect(existsSync(target)).toBe(false)
    log('benchmark preparation dry-run', {
      commit: repo.commit,
      created: existsSync(target)
    })
  })

  it('refuses nonexistent revisions before installing or building', () => {
    const repo = repository()
    const result = spawnSync(
      process.execPath,
      [cli, '--root', repo.root, '--old-ref', 'missing-ref', '--dry-run'],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[benchmark prepare]')
    log('benchmark invalid revision', { exit: result.status })
  })

  it('never overwrites an existing directory', () => {
    const repo = repository()
    const result = spawnSync(
      process.execPath,
      [cli, '--root', repo.root, '--old-ref', 'HEAD', '--old-root', repo.root],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing to overwrite')
  })
})
