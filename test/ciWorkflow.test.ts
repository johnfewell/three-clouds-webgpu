import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from './helpers/cpuTwin'

const WORKFLOW_PATH = resolve(
  import.meta.dirname,
  '../.github/workflows/ci.yml'
)
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8')
const PRIVATE = WORKFLOW.includes('# workflow: private')
if (!PRIVATE && !WORKFLOW.includes('# workflow: public')) {
  throw new Error('Active workflow must declare its contract')
}
const DIAGNOSTIC_UPLOADS = [
  'Upload test results',
  'Upload e2e results',
  'Upload e2e report'
]
const E2E_UPLOADS = ['Upload e2e results', 'Upload e2e report']
const E2E_FAILURE_CONDITION =
  "if: always() && steps.harness_gate.conclusion == 'failure'"

// A step's block ends at the next step OR the next less-indented line. Ending
// only at `- name:` let a job's last step absorb the next job's
// `continue-on-error`, and the planted-removal proof stopped discriminating
function stepBlock(source: string, name: string): string {
  const marker = `      - name: ${name}\n`
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const rest = source.slice(start + marker.length)
  const end = rest.search(/\n(?: {0,5}\S| {6}- name:)/)
  return end < 0
    ? source.slice(start)
    : source.slice(start, start + marker.length + end)
}

function blockingDiagnosticUploads(source: string): string[] {
  return DIAGNOSTIC_UPLOADS.filter(name => {
    const block = stepBlock(source, name)
    return (
      !block.includes('uses: actions/upload-artifact@') ||
      !block.includes('continue-on-error: true')
    )
  })
}

function unboundedE2eUploads(source: string): string[] {
  return E2E_UPLOADS.filter(name => {
    const block = stepBlock(source, name)
    return (
      !block.includes(E2E_FAILURE_CONDITION) ||
      !block.includes('retention-days: 1')
    )
  })
}

describe.runIf(PRIVATE)('CI diagnostic artifacts', () => {
  it('cannot fail their jobs and suppress downstream gates', () => {
    const blocking = blockingDiagnosticUploads(WORKFLOW)
    table('diagnostic-artifact-policy', [
      ...DIAGNOSTIC_UPLOADS.map(name => ({
        step: name,
        policy: blocking.includes(name) ? 'blocking' : 'non-blocking'
      })),
      {
        step: 'Upload Pages artifact',
        policy: stepBlock(WORKFLOW, 'Upload Pages artifact').includes(
          'continue-on-error: true'
        )
          ? 'non-blocking'
          : 'fatal'
      }
    ])

    expect(blocking).toEqual([])
    expect(stepBlock(WORKFLOW, 'Upload Pages artifact')).not.toContain(
      'continue-on-error: true'
    )
  })

  it('refuses a planted blocking diagnostic upload', () => {
    const upload = stepBlock(WORKFLOW, 'Upload test results')
    const planted = WORKFLOW.replace(
      upload,
      upload.replace('        continue-on-error: true\n', '')
    )

    expect(blockingDiagnosticUploads(planted)).toContain('Upload test results')
  })

  it('uploads short-lived e2e diagnostics only when the harness gate fails', () => {
    const harnessGate = stepBlock(
      WORKFLOW,
      'Assert the harness gate refuses a software rasteriser'
    )
    table(
      'e2e-artifact-policy',
      E2E_UPLOADS.map(name => ({
        step: name,
        condition: E2E_FAILURE_CONDITION,
        retentionDays: 1
      }))
    )

    expect(harnessGate).toContain('id: harness_gate')
    expect(unboundedE2eUploads(WORKFLOW)).toEqual([])
  })

  it('refuses planted always-upload and long-retention policies', () => {
    const upload = stepBlock(WORKFLOW, 'Upload e2e results')
    const alwaysUploads = WORKFLOW.replace(
      upload,
      upload.replace(E2E_FAILURE_CONDITION, 'if: always()')
    )
    const longRetention = WORKFLOW.replace(
      upload,
      upload.replace('retention-days: 1', 'retention-days: 30')
    )

    expect(unboundedE2eUploads(alwaysUploads)).toContain('Upload e2e results')
    expect(unboundedE2eUploads(longRetention)).toContain('Upload e2e results')
  })

  it('keeps the small unit-test evidence on its existing policy', () => {
    const upload = stepBlock(WORKFLOW, 'Upload test results')

    expect(upload).toContain('if: always()')
    expect(upload).toContain('retention-days: 30')
  })
})

// the example runtime smoke needs a
// GPU, so it cannot run in CI and the reachable half must not pretend
// otherwise. test/exampleWiring.test.ts is that half, inside `pnpm test`

describe('CI and the example runtime smoke', () => {
  const workflows = [
    { name: 'active', text: WORKFLOW },
    ...(PRIVATE
      ? [
          {
            name: 'public template',
            text: readFileSync(
              resolve(
                import.meta.dirname,
                '../.github/public-workflows/ci.yml'
              ),
              'utf8'
            )
          }
        ]
      : [])
  ]
  it.each(workflows)(
    '$name excludes the smoke suite and explains why',
    ({ text }) => {
      // Only the manual e2e job may boot a browser. If a GPU-gated suite is ever
      // added to the always-run job it would fail on every hosted runner
      const e2e = text.indexOf('\n  e2e:')
      const alwaysRun = e2e < 0 ? text : text.slice(0, e2e)
      const prose = alwaysRun.replace(/^\s*# ?/gm, '')
      table('example-smoke-ci-placement', [
        {
          step: 'browser suites in the always-run job',
          expected: '0',
          actual: String(
            (alwaysRun.match(/playwright install|--grep p4/g) ?? []).length
          )
        },
        {
          step: 'the reason is named in the workflow',
          expected: 'true',
          actual: String(/no GPU|software\s+rasteriser/i.test(prose))
        }
      ])

      expect(alwaysRun).not.toMatch(/playwright install/)
      expect(alwaysRun).not.toMatch(/--grep p4/)
      expect(prose).toMatch(/software\s+rasteriser|no GPU/i)
    }
  )

  it('the always-run job executes pnpm test, where the static audit lives', () => {
    // The audit is only CI-covered while it is inside a step the job runs
    expect(stepBlock(WORKFLOW, 'Test')).toContain('pnpm test')
  })

  // The workflow's own comment is the thing a future agent reads before
  // concluding the smoke half is CI-covered, so the wording is asserted
  it.runIf(PRIVATE)(
    'names the hardware gate explicitly, so it is not read as CI-covered',
    () => {
      expect(WORKFLOW).toContain('The real e2e suites run locally on hardware.')
      const e2e = WORKFLOW.slice(WORKFLOW.indexOf('\n  e2e:'))
      expect(e2e).toContain('workflow_dispatch')
    }
  )
})
