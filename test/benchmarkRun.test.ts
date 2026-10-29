import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  hashSources,
  verifyServedArtifact
} from '../examples/parity/scripts/benchmarks/run.mjs'
import { log } from './helpers/log'

const cli = resolve('examples/parity/scripts/benchmarks/run.mjs')

function sourceTree() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-benchmark-source '))
  execFileSync('git', ['init', '--quiet', root])
  return root
}

describe('benchmark runner provenance and CLI', () => {
  it('hashes actual untracked and modified runtime bytes', async () => {
    const root = sourceTree()
    await expect(hashSources(root)).rejects.toThrow(/empty/)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/index.ts'), 'export const value = 1\n')
    const first = await hashSources(root)
    expect(first.sourceFiles).toEqual(['src/index.ts'])
    execFileSync('git', ['add', 'src/index.ts'], { cwd: root })
    writeFileSync(join(root, 'src/index.ts'), 'export const value = 2\n')
    const changed = await hashSources(root)
    expect(changed.sourceHash).not.toBe(first.sourceHash)
    writeFileSync(join(root, 'src/extra.ts'), 'export const extra = true\n')
    const added = await hashSources(root)
    expect(added.sourceFiles).toHaveLength(2)
    expect(added.sourceHash).not.toBe(changed.sourceHash)
    log('benchmark source inventory', { files: added.sourceFiles.length })
  })

  it('rejects a browser loading another worktree even when its filename matches', async () => {
    const root = sourceTree()
    const other = sourceTree()
    for (const dir of [root, other]) {
      mkdirSync(join(dir, 'build'))
      writeFileSync(join(dir, 'build/shared.js'), 'export const value = 1\n')
    }
    const url = `http://localhost:1/@fs/${join(other, 'build/shared.js').replaceAll('\\', '/').replace(/^\//, '')}`
    await expect(
      verifyServedArtifact(
        'http://localhost:1',
        {
          servedLibraryUrls: [url]
        },
        'unused',
        root
      )
    ).rejects.toThrow(/different library root/)
    await expect(
      verifyServedArtifact(
        'http://localhost:1',
        {
          servedLibraryUrls: []
        },
        'unused',
        root
      )
    ).rejects.toThrow(/no served library/)
  })

  it('rejects unknown arguments and requires idle confirmation before building', () => {
    const unknown = spawnSync(process.execPath, [cli, '--typo'], {
      encoding: 'utf8'
    })
    expect(unknown.status).toBe(1)
    const idle = spawnSync(
      process.execPath,
      [cli, '--old-root', 'missing', '--new-root', 'missing'],
      {
        encoding: 'utf8',
        env: { ...process.env, BENCHMARK_IDLE: '0' }
      }
    )
    expect(idle.status).toBe(1)
    expect(idle.stderr).toContain('BENCHMARK_IDLE=1')
  })

  it('refuses existing outputs before starting any browser or build', () => {
    const root = sourceTree()
    const output = join(root, 'report.json')
    writeFileSync(output, 'existing report')
    const result = spawnSync(
      process.execPath,
      [
        cli,
        '--profile',
        'smoke',
        '--old-root',
        'missing',
        '--new-root',
        'missing',
        '--output',
        output
      ],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing to overwrite output')
  })
})
