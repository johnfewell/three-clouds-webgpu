import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from './helpers/cpuTwin'

const TEMPLATE_PATH = resolve(
  import.meta.dirname,
  '../.github/public-workflows/ci.yml'
)
const WORKFLOW_PATH = existsSync(TEMPLATE_PATH)
  ? TEMPLATE_PATH
  : resolve(import.meta.dirname, '../.github/workflows/ci.yml')
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8')
if (!WORKFLOW.includes('# workflow: public')) {
  throw new Error('Public workflow must declare its contract')
}

// A step's block ends at the next step OR the next less-indented line, the same
// rule test/ciWorkflow.test.ts uses. Ending only at `- name:` lets a job's last
// step absorb the next job's keys
function stepBlock(source: string, name: string): string {
  const marker = `- name: ${name}\n`
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const rest = source.slice(start + marker.length)
  const end = rest.search(/\n {0,4}- name:|\n {0,2}\S/)
  return end < 0
    ? source.slice(start)
    : source.slice(start, start + marker.length + end)
}

// Every gate the task names, in the order the private workflow runs them. Kept
// as a list so the assertion reads as coverage rather than as one big string
const REQUIRED_GATES = [
  'pnpm install --frozen-lockfile',
  'pnpm build',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm format:check',
  'pnpm test',
  'pnpm gates',
  'node scripts/verify-results.mjs'
]

// The site deploy was a second job here until the Cloudflare move: the public site is now
// a Cloudflare Worker the operator deploys from a scanned dist/site, so a
// token secret, a Pages scope and a deploy job are all absent on purpose
const DEPLOY_MARKERS = [
  'deploy-demo',
  'pages: write',
  'id-token: write',
  'configure-pages',
  'upload-pages-artifact',
  'deploy-pages',
  'STORYBOOK_ION_API_TOKEN',
  'PUBLIC_PAGES_SCAN_APPROVALS',
  'GITHUB_OUTPUT'
]

describe('public CI', () => {
  it('budgets sufficient Node heap for the type-aware lint gate', () => {
    expect(WORKFLOW).toContain('NODE_OPTIONS: --max-old-space-size=4096')
  })
  it('uses the public contract and one Node version', () => {
    expect(WORKFLOW).toContain('# workflow: public')
    expect(WORKFLOW).not.toMatch(/^ {2}(?:e2e|deploy-site):/m)
    const nodes = [...WORKFLOW.matchAll(/node-version: (\d+)/g)].map(
      match => match[1]
    )
    expect(nodes).toEqual(['24'])
  })
  it('runs every gate the release epic names', () => {
    const buildJob = WORKFLOW.slice(WORKFLOW.indexOf('  build-and-test:'))
    table(
      'public-ci-gates',
      REQUIRED_GATES.map(gate => ({
        gate,
        present: buildJob.includes(gate) ? 'yes' : 'NO'
      }))
    )
    for (const gate of REQUIRED_GATES) {
      expect(buildJob, `${gate} is missing`).toContain(gate)
    }
  })

  // A public repo gets free Actions minutes, so the private repo's trimming has
  // to go: the tasks path filter would skip real changes in the exported tree
  // (which has no .beads), and manual-only would mean main is never gated
  it('drops the private repo budget trimming', () => {
    expect(WORKFLOW).not.toContain('paths-ignore')
    expect(WORKFLOW).not.toContain('.beads/**')
    table('public-ci-trimming', [
      {
        setting: 'paths-ignore',
        expected: 'absent',
        actual: WORKFLOW.includes('paths-ignore') ? 'present' : 'absent'
      }
    ])
  })

  it('runs on both pull requests and pushes to main', () => {
    const triggers = WORKFLOW.slice(0, WORKFLOW.indexOf('concurrency:'))
    expect(triggers).toContain('pull_request:')
    expect(triggers).toContain('push:')
    expect(triggers).toContain('branches: [main]')
  })

  // The task is explicit: no GPU e2e in CI, and the local route documented
  it('boots no browser and says where the GPU suites run', () => {
    expect(WORKFLOW).not.toContain('playwright install')
    expect(WORKFLOW).not.toMatch(/--grep p[0-4]/)
    expect(WORKFLOW).not.toContain('PARITY_GPU')
    expect(WORKFLOW).toMatch(/no GPU|need a real GPU/i)
    expect(WORKFLOW).toContain('pnpm e2e')
  })

  // verify-results decides a receipt's trustworthiness from git ancestry, and a
  // shallow clone reads as undecidable
  it('checks out full history, and says that it is not sufficient', () => {
    expect(WORKFLOW).toContain('fetch-depth: 0')
    expect(WORKFLOW).toMatch(/undecidable/i)
  })

  // The correction commit is private, so ancestry stays undecidable in the
  // exported tree. Recorded as a known limitation instead of left for someone
  // to discover from a wall of PRE-CORRECTION annotations
  it('names the correction commit whose absence makes the check undecidable', () => {
    expect(WORKFLOW).toContain('f4f5111')
  })

  it('cannot let a diagnostic upload turn a green gate red', () => {
    const upload = stepBlock(WORKFLOW, 'Upload test results')
    expect(upload).toContain('if: always()')
    expect(upload).toContain("steps.diagnostics.outcome == 'success'")
    expect(upload).not.toContain('steps.diagnostics.conclusion')
    expect(upload).toContain('continue-on-error: true')
    expect(upload).toContain('retention-days: 30')
  })
})

describe('public CI deploys nothing', () => {
  it('has only the build-and-test job', () => {
    const jobs = [
      ...WORKFLOW.slice(WORKFLOW.indexOf('\njobs:')).matchAll(
        /^ {2}([a-z-]+):$/gm
      )
    ].map(match => match[1])
    table(
      'public-ci-jobs',
      jobs.map(job => ({ job }))
    )
    expect(jobs).toEqual(['build-and-test'])
  })

  it('asks for no deploy scope and holds no site token', () => {
    table(
      'public-ci-deploy-markers',
      DEPLOY_MARKERS.map(marker => ({
        marker,
        present: WORKFLOW.includes(marker) ? 'PRESENT' : 'absent'
      }))
    )
    for (const marker of DEPLOY_MARKERS)
      expect(WORKFLOW, `${marker} must be absent`).not.toContain(marker)
  })

  it('says where the site is deployed from instead', () => {
    expect(WORKFLOW).toMatch(/not deployed by CI/)
  })
})

// The exporter copies this file into the public tree. A stray action here would
// run on every push in a repo the operator has not finished reviewing
describe.runIf(existsSync(TEMPLATE_PATH))('public CI placement', () => {
  it('sits outside .github/workflows so it never runs on the private repo', () => {
    expect(WORKFLOW_PATH).toContain('/.github/public-workflows/')
  })

  it('documents the copy destination for the exporter', () => {
    const readme = readFileSync(
      resolve(import.meta.dirname, '../.github/public-workflows/README.md'),
      'utf8'
    )
    table('exporter-handoff', [
      {
        documented: '.github/workflows/ci.yml',
        actual: readme.includes('.github/workflows/ci.yml') ? 'yes' : 'NO'
      },
      {
        documented: 'the undecidable ancestry limit',
        actual: /undecidable/i.test(readme) ? 'yes' : 'NO'
      },
      {
        documented: 'the local GPU e2e route',
        actual: readme.includes('pnpm e2e') ? 'yes' : 'NO'
      }
    ])
    expect(readme).toContain('.github/workflows/ci.yml')
    expect(readme).toMatch(/undecidable/i)
    expect(readme).toContain('pnpm e2e')
  })

  // The README travels with the template and is dropped from the export, so
  // the site recipe it carries is only checkable here
  it('names the site build script and cf deploy, and no Pages', () => {
    const readme = readFileSync(
      resolve(import.meta.dirname, '../.github/public-workflows/README.md'),
      'utf8'
    )
    expect(readme).toContain('scripts/release/build-site.mjs')
    expect(readme).toContain('cf deploy')
    expect(readme).not.toMatch(/GitHub Pages/)
  })
})
