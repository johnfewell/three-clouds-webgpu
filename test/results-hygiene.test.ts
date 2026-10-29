import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from './helpers/cpuTwin'

const RESULTS_ROOT = join(import.meta.dirname, '..', 'parity', 'results')

describe('parity results hygiene', () => {
  // images are local capture output. Routing
  // them to LFS again would bring back the per-run CI download it removed
  it('no LFS rule, and parity images are gitignored', () => {
    const attrsPath = join(import.meta.dirname, '..', '.gitattributes')
    const attrs = existsSync(attrsPath) ? readFileSync(attrsPath, 'utf8') : ''
    expect(attrs).not.toContain('filter=lfs')
    const gitignore = readFileSync(
      join(import.meta.dirname, '..', '.gitignore'),
      'utf8'
    )
    expect(gitignore).toContain('parity/results/**/*.png')
  })

  it('git ls-files lists no *.bin under parity/results', () => {
    const gitignore = readFileSync(
      join(import.meta.dirname, '..', '.gitignore'),
      'utf8'
    )
    expect(gitignore).toContain('parity/results/**/*.bin')
  })

  it('every case directory has metrics.json and capture.log', () => {
    const phases = readdirSync(RESULTS_ROOT, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.') && entry.isDirectory())
      .map(entry => entry.name)
    expect(phases.length).toBeGreaterThan(0)

    const rows: Array<Record<string, unknown>> = []

    for (const phase of phases) {
      const phaseDir = join(RESULTS_ROOT, phase)
      const cases = readdirSync(phaseDir).filter(
        d => !d.startsWith('.') && !d.endsWith('.md')
      )

      for (const caseName of cases) {
        const caseDir = join(phaseDir, caseName)
        const phaseNum = parseInt(phase, 10)
        const hasMetrics =
          isNaN(phaseNum) || phaseNum < 1
            ? true
            : existsSync(join(caseDir, 'metrics.json'))
        const hasCaptureLog =
          isNaN(phaseNum) || phaseNum < 1
            ? true
            : existsSync(join(caseDir, 'capture.log'))

        rows.push({
          phase,
          case: caseName,
          metrics: hasMetrics,
          captureLog: hasCaptureLog
        })

        if (!isNaN(phaseNum) && phaseNum >= 1) {
          expect(
            hasMetrics,
            `${phase}/${caseName}/metrics.json missing (phase >= 1)`
          ).toBe(true)
          expect(
            hasCaptureLog,
            `${phase}/${caseName}/capture.log missing (phase >= 1)`
          ).toBe(true)
        }
      }
    }

    table('results-hygiene', rows)
  })
})
