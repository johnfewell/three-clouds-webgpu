import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { archiveMembers, scanPublicFiles } from './public-scan.mjs'

const marker = `cw-${'scannerfixture'}`
const file = (text: string, path = 'fixture.txt') => ({
  surface: 'test',
  path,
  bytes: Buffer.from(text)
})
const directories: string[] = []
afterEach(() =>
  directories
    .splice(0)
    .forEach(path => rmSync(path, { recursive: true, force: true }))
)

describe('publication scanner', () => {
  it('distinguishes environment filenames from documentation about configuration', () => {
    expect(
      scanPublicFiles([file('Configure examples/app/.env.local')]).unapproved
    ).toEqual([])
    expect(
      scanPublicFiles([file('KEY=example', '.env.local')]).unapproved.map(
        hit => hit.class
      )
    ).toEqual(['credential-file'])
  })
  it('scans JSONC comments and decoded strings in TypeScript configurations', () => {
    const source = `// ${marker}\n{"compilerOptions": {"strict": true,},}`
    const result = scanPublicFiles([file(source, 'tsconfig.json')])
    expect(result.unapproved.map(hit => hit.class)).toEqual(['tracker'])
  })
  it('refuses zero inputs and scans filenames', () => {
    expect(() => scanPublicFiles([])).toThrow(/zero/)
    expect(
      scanPublicFiles([file('clean', `${marker}.txt`)]).unapproved
    ).toHaveLength(1)
  })

  it('decodes source-map strings and never returns matched values', () => {
    const secret = `ghp_${'x'.repeat(32)}`
    const result = scanPublicFiles([
      file(
        JSON.stringify({ sourcesContent: [marker, secret] }),
        'fixture.js.map'
      )
    ])
    expect(result.unapproved.map(hit => hit.class)).toEqual([
      'tracker',
      'credential'
    ])
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(marker)
  })

  it('requires exact reviewed counts and refuses unused approvals', () => {
    const approval = {
      surface: 'test',
      path: 'fixture.txt',
      class: 'tracker',
      match: marker,
      count: 1,
      reason: 'synthetic regression fixture',
      approvedBy: 'test operator',
      approvedAt: '2026-10-26'
    }
    expect(scanPublicFiles([file(marker)], [approval]).unapproved).toEqual([])
    expect(
      scanPublicFiles([file(`${marker} ${marker}`)], [approval]).allowlistErrors
    ).toHaveLength(1)
    expect(
      scanPublicFiles([file('clean')], [approval]).allowlistErrors
    ).toHaveLength(1)
  })

  it('does not permit credential allowlisting', () => {
    const secret = `ghp_${'x'.repeat(32)}`
    const result = scanPublicFiles(
      [file(secret)],
      [
        {
          surface: 'test',
          path: 'fixture.txt',
          class: 'credential',
          match: secret,
          count: 1,
          reason: 'not permitted',
          approvedBy: 'operator',
          approvedAt: '2026-10-26'
        }
      ]
    )
    expect(result.unapproved).toHaveLength(1)
    expect(result.allowlistErrors).toHaveLength(1)
  })

  it('allows only the exact intentionally public client token', () => {
    const token = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`
    expect(scanPublicFiles([file(token)]).unapproved).toHaveLength(1)
    const result = scanPublicFiles([file(token)], [], { publicToken: token })
    expect(result.unapproved).toEqual([])
    expect(result.publicClientTokenSha256).toHaveLength(64)
  })

  it('scans archive members without extracting them to disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'publication-scan-'))
    directories.push(root)
    writeFileSync(join(root, 'fixture.txt'), marker)
    const archive = execFileSync('tar', ['-czf', '-', 'fixture.txt'], {
      cwd: root,
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    })
    expect(
      archiveMembers(archive).filter(member => member.path === 'fixture.txt')
    ).toHaveLength(1)
    const result = scanPublicFiles([
      { surface: 'vendor', path: 'fixture.tgz', bytes: archive }
    ])
    expect(result.unapproved[0]?.path).toBe('fixture.tgz!/fixture.txt')
  })

  it('inspects printable binary metadata and its digest', () => {
    const result = scanPublicFiles([
      file(`\0metadata:${marker}\0`, 'fixture.png')
    ])
    expect(result.binaries).toHaveLength(1)
    expect(result.unapproved).toHaveLength(1)
  })
})

describe('scanner publication formats and diagnostics', () => {
  it('does not flag its own pattern definitions or anonymous fixture roots', () => {
    const source = readFileSync(
      new URL('./public-scan.mjs', import.meta.url),
      'utf8'
    )
    expect(
      scanPublicFiles([file(source, 'public-scan.mjs')]).unapproved
    ).toEqual([])
    expect(
      scanPublicFiles([file('/Users/example/code/test /home/somebody/test')])
        .unapproved
    ).toEqual([])
    expect(
      scanPublicFiles([
        file(['', 'Users', 'real-person', 'code', 'test'].join('/'))
      ]).unapproved
    ).toHaveLength(1)
  })
  it.each(['ktx2', 'basis', 'gz', 'zip', 'br', 'eot', 'mov', 'svgz', 'glb'])(
    'scans printable metadata in %s assets',
    extension => {
      expect(
        scanPublicFiles([file(marker, `asset.${extension}`)]).unapproved
      ).toHaveLength(1)
    }
  )
  it.each(['page.mdx', '.nojekyll'])('classifies %s as text', path => {
    expect(scanPublicFiles([file(marker, path)]).unapproved).toHaveLength(1)
  })
  it('names unknown formats without echoing a credential filename', () => {
    expect(() => scanPublicFiles([file('', 'asset.unknown')])).toThrow(
      'asset.unknown'
    )
    const secret = `ghp_${'x'.repeat(32)}`
    expect(() => scanPublicFiles([file('', `${secret}.unknown`)])).toThrow(
      '<redacted>.unknown'
    )
  })
  it('reuses the exact per-surface manifest from the combined scan', () => {
    const pages = [{ ...file('clean'), surface: 'pages' }]
    const combined = scanPublicFiles([...pages, file('other')])
    expect(combined.surfaceManifests.pages).toBe(
      scanPublicFiles(pages).manifestSha256
    )
  })
})
