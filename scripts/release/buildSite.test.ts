import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SHOWCASE_FILES } from '../../examples/storybook/.storybook/showcase'
import { table } from '../../test/helpers/cpuTwin'
import {
  assembleSite,
  BUILD_STEPS,
  buildInputs,
  buildSources,
  readApprovals,
  RECEIPT_PROTOCOL,
  scanSite
} from './build-site.mjs'

const roots: string[] = []
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'clouds-site-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixtureBuilds(root: string) {
  const demo = join(root, 'demo')
  const showcase = join(root, 'showcase')
  mkdirSync(join(demo, 'assets'), { recursive: true })
  writeFileSync(join(demo, 'index.html'), '<title>demo</title>')
  writeFileSync(join(demo, 'assets', 'app.js'), 'export const demo = 1')
  mkdirSync(showcase, { recursive: true })
  writeFileSync(join(showcase, 'index.html'), '<title>showcase</title>')
  writeFileSync(join(showcase, 'iframe.html'), '<title>iframe</title>')
  return { demo, showcase, out: join(root, 'dist', 'site') }
}

describe('site build inputs', () => {
  it('builds the showcase surface in production with one client token for both builds', () => {
    const inputs = buildInputs('client-token')
    table('site-build-inputs', [
      { build: 'showcase', ...inputs.showcase },
      { build: 'demo', ...inputs.demo }
    ])
    expect(inputs.showcase).toEqual({
      NODE_ENV: 'production',
      STORYBOOK_SURFACE: 'showcase',
      STORYBOOK_ION_API_TOKEN: 'client-token'
    })
    expect(inputs.demo).toEqual({
      NODE_ENV: 'production',
      VITE_ION_API_TOKEN: 'client-token'
    })
    expect(buildInputs().showcase.STORYBOOK_ION_API_TOKEN).toBe('')
    expect(buildInputs().demo.VITE_ION_API_TOKEN).toBe('')
  })

  it('checks the showcase index after its build and before the demo build', () => {
    const names = BUILD_STEPS.map(step => step.name)
    table(
      'site-build-order',
      BUILD_STEPS.map(step => ({
        step: step.name,
        command: [step.command, ...step.args].join(' ')
      }))
    )
    expect(names).toEqual(['library', 'showcase', 'showcase-check', 'demo'])
    const check = BUILD_STEPS.find(step => step.name === 'showcase-check')
    expect(check?.args.join(' ')).toContain(
      'check-showcase.mjs examples/storybook/dist'
    )
    const calls: string[] = []
    buildSources('t', (command, args, env) =>
      calls.push(`${command} ${args.join(' ')} ${JSON.stringify(env)}`)
    )
    expect(calls).toHaveLength(BUILD_STEPS.length)
    expect(calls[1]).toContain('"STORYBOOK_SURFACE":"showcase"')
    expect(calls[3]).toContain('"VITE_ION_API_TOKEN":"t"')
  })

  // The lab stories (experiments, A/B baselines) stay out of the public bundle
  it('names showcase story files that exist', () => {
    const dir = resolve(
      import.meta.dirname,
      '../../examples/storybook/.storybook'
    )
    const rows = SHOWCASE_FILES.map(path => ({
      story: path,
      exists: existsSync(resolve(dir, path)) ? 'yes' : 'NO'
    }))
    table('showcase-stories', rows)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter(row => row.exists !== 'yes')).toEqual([])
  })
})

describe('site assembly', () => {
  it('puts the demo at the root and the showcase under /storybook', () => {
    const { demo, showcase, out } = fixtureBuilds(scratch())
    const assembled = assembleSite(demo, showcase, out)
    table('site-assembly', [{ ...assembled }])
    expect(assembled).toEqual({ files: 4, demoFiles: 2, showcaseFiles: 2 })
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('demo')
    expect(
      readFileSync(join(out, 'storybook', 'index.html'), 'utf8')
    ).toContain('showcase')
    expect(existsSync(join(out, 'assets', 'app.js'))).toBe(true)
  })

  it('refuses an empty input, a shadowed storybook entry and a foreign output', () => {
    const root = scratch()
    const { demo, showcase, out } = fixtureBuilds(root)
    const empty = join(root, 'empty')
    mkdirSync(empty)
    const rows = [
      {
        case: 'empty demo',
        refused: expect(() => assembleSite(empty, showcase, out)).toThrow(
          /missing or empty/
        )
      },
      {
        case: 'empty showcase',
        refused: expect(() => assembleSite(demo, empty, out)).toThrow(
          /missing or empty/
        )
      }
    ]
    mkdirSync(join(demo, 'storybook'))
    writeFileSync(join(demo, 'storybook', 'x.txt'), 'x')
    expect(() => assembleSite(demo, showcase, out)).toThrow(
      /already has a storybook entry/
    )
    rmSync(join(demo, 'storybook'), { recursive: true })
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'someone-elses.txt'), 'keep')
    expect(() => assembleSite(demo, showcase, out)).toThrow(/not this script's/)
    expect(existsSync(join(out, 'someone-elses.txt'))).toBe(true)
    table(
      'site-assembly-refusals',
      rows.map(row => ({ case: row.case }))
    )
  })

  it('replaces only its own previous output, proven by the receipt beside it', () => {
    const { demo, showcase, out } = fixtureBuilds(scratch())
    assembleSite(demo, showcase, out)
    writeFileSync(
      join(out, '..', 'site-receipt.json'),
      JSON.stringify({ protocol: RECEIPT_PROTOCOL, out })
    )
    writeFileSync(join(demo, 'index.html'), '<title>demo v2</title>')
    expect(assembleSite(demo, showcase, out).files).toBe(4)
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('demo v2')
  })
})

describe('site scan gate', () => {
  const approval = {
    surface: 'pages',
    path: 'fixture.txt',
    class: 'machine-name',
    match: 'fixture.local',
    count: 1,
    reason: 'Synthetic test fixture only',
    approvedBy: 'test fixture',
    approvedAt: '2026-10-28'
  }

  it('refuses missing or stale approval and passes an exact one', () => {
    const root = scratch()
    const out = join(root, 'site')
    mkdirSync(out)
    writeFileSync(join(out, 'fixture.txt'), 'fixture.local')
    writeFileSync(join(out, 'index.html'), '<title>clean</title>')
    const missing = scanSite(out, [])
    const exact = scanSite(out, [approval])
    const stale = scanSite(out, [{ ...approval, count: 2 }])
    table('site-scan-gate', [
      {
        case: 'missing',
        ok: missing.ok,
        unapproved: missing.result.unapproved.length
      },
      {
        case: 'exact',
        ok: exact.ok,
        unapproved: exact.result.unapproved.length
      },
      {
        case: 'stale',
        ok: stale.ok,
        allowlistErrors: stale.result.allowlistErrors.length
      }
    ])
    expect(missing.ok).toBe(false)
    expect(missing.result.unapproved).toHaveLength(1)
    expect(exact.ok).toBe(true)
    expect(exact.result.files).toBe(2)
    expect(exact.result.surfaceManifests).toHaveProperty('pages')
    expect(stale.ok).toBe(false)
  })

  it('refuses a malformed approvals file', () => {
    const root = scratch()
    const notJson = join(root, 'bad.json')
    writeFileSync(notJson, 'not json')
    const notArray = join(root, 'object.json')
    writeFileSync(notArray, '{}')
    expect(() => readApprovals(notJson)).toThrow(/not JSON/)
    expect(() => readApprovals(notArray)).toThrow(/JSON array/)
    expect(readApprovals(undefined)).toEqual([])
  })
})
