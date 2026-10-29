// Vite plugin to serve parity results as static files and API data
// Dev: middleware serves /api/grid-data.json and /results/*
// Build: copies results into dist/results/ and emits dist/api/grid-data.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

import {
  evaluate,
  type PhaseThresholds,
  type Thresholds
} from './src/metrics/evaluate'

const PROJECT_ROOT = join(import.meta.dirname, '..', '..')
const RESULTS_DIR = join(PROJECT_ROOT, 'parity', 'results')
const THRESHOLDS_PATH = join(import.meta.dirname, 'cases', 'thresholds.json')

// The ladder never trusts a capture's own `result`: every row is re-evaluated
// against the current thresholds.json, plate check included, so stale or
// hand-edited metrics cannot show green (58t). Kept as `capturedResult`
function loadThresholds(): Thresholds | null {
  try {
    return JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')) as Thresholds
  } catch {
    return null
  }
}

function reevaluate(
  data: Record<string, unknown>,
  thresholds: Thresholds | null
): void {
  if (thresholds == null) return
  const phase = String(data.phase)
  const raw =
    (thresholds.phases as Record<string, PhaseThresholds>)[phase] ?? {}
  const pt: PhaseThresholds = {}
  for (const key of ['ssim', 'deP95', 'histDist'] as const) {
    const v = raw[key] as unknown
    if (typeof v === 'number') pt[key] = v
  }
  const plate = thresholds.plate
  const ev = evaluate(
    {
      ssim: Number(data.ssim),
      deMean: Number(data.deMean),
      deP95: Number(data.deP95),
      histDist: Number(data.histDist)
    },
    pt,
    String(data.case),
    thresholds.accepted,
    {
      minStd: plate?.minStd ?? 0.002,
      minCloudFraction:
        (plate as { minCloudFraction?: number } | undefined)
          ?.minCloudFraction ?? 0.0005,
      plate: (data.plate as never) ?? null
    }
  )
  data.capturedResult = data.result
  data.result = ev.result
  data.reasons = ev.reasons
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
  '.log': 'text/plain'
}

function readAllMetrics(): Record<string, unknown>[] {
  const metrics: Record<string, unknown>[] = []
  if (!existsSync(RESULTS_DIR)) return metrics
  const thresholds = loadThresholds()

  for (const phase of readdirSync(RESULTS_DIR)) {
    const phaseDir = join(RESULTS_DIR, phase)
    if (!statSync(phaseDir).isDirectory()) continue

    for (const caseName of readdirSync(phaseDir)) {
      const caseDir = join(phaseDir, caseName)
      if (!statSync(caseDir).isDirectory()) continue

      const metricsPath = join(caseDir, 'metrics.json')
      if (existsSync(metricsPath)) {
        try {
          const data = JSON.parse(readFileSync(metricsPath, 'utf8')) as Record<
            string,
            unknown
          >
          reevaluate(data, thresholds)
          metrics.push(data)
        } catch {
          // skip malformed
        }
      }
    }
  }

  return metrics
}

function readPhaseJson(): number {
  const phasePath = join(PROJECT_ROOT, 'scripts', 'port-gates', 'phase.json')
  if (!existsSync(phasePath)) return 0
  try {
    const data = JSON.parse(readFileSync(phasePath, 'utf8')) as {
      phase: number
    }
    return data.phase ?? 0
  } catch {
    return 0
  }
}

function buildGridDataJson(): string {
  const metrics = readAllMetrics()
  const currentPhase = readPhaseJson()
  return JSON.stringify({ metrics, currentPhase })
}

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })

  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    const stat = statSync(srcPath)

    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

export function resultsPlugin(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'parity-results',

    configResolved(resolved) {
      config = resolved
    },

    configureServer(server) {
      server.middlewares.use('/api/grid-data.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(buildGridDataJson())
      })

      // Legacy endpoint (kept for backwards compat with dev tools)
      server.middlewares.use('/api/grid-data', (req, res, next) => {
        if (req.url !== '' && req.url !== '/') {
          next()
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(buildGridDataJson())
      })

      server.middlewares.use('/results', (req, res, next) => {
        const urlPath = req.url?.replace(/\?.*$/, '') ?? ''
        const filePath = join(RESULTS_DIR, urlPath)

        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next()
          return
        }

        const ext = extname(filePath)
        const mime = MIME[ext] ?? 'application/octet-stream'
        const data = readFileSync(filePath)

        res.setHeader('Content-Type', mime)
        res.setHeader('Cache-Control', 'no-cache')
        res.end(data)
      })
    },

    writeBundle() {
      if (config.command !== 'build') return

      const outDir = resolve(config.root, config.build.outDir)

      // Copy results into dist/results/
      const destResults = join(outDir, 'results')
      copyDirRecursive(RESULTS_DIR, destResults)

      // Write static grid-data.json
      const apiDir = join(outDir, 'api')
      mkdirSync(apiDir, { recursive: true })
      writeFileSync(join(apiDir, 'grid-data.json'), buildGridDataJson())
    }
  }
}
