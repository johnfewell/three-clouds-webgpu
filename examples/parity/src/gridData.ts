// Data types and loader for the parity index grid
// The loader runs both server-side (Vite plugin) and in unit tests

import type { CaseDefinition } from '../cases/index'
import type {
  GpuMsSchema,
  MetricsSchema,
  SequenceSchema
} from './capture/metricsWriter'

export type GridStatus =
  'pass' | 'fail' | 'expected-difference' | 'not-yet' | 'hardware-skip'

export type SequenceInfo = SequenceSchema

export interface GridRow {
  name: string
  number: number
  phase: number
  variant?: string
  status: GridStatus
  statusReason?: string
  metrics?: {
    ssim: number
    deMean: number
    deP95: number
    histDist: number
    captureMs: number
    metricsMs: number
  }
  gpuMs?: GpuMsSchema
  sequence?: SequenceInfo
  hasImages: boolean
  scene: string
  lookOnly: boolean
}

export interface GridData {
  rows: GridRow[]
  currentPhase: number
}

export function buildGridData(
  cases: readonly CaseDefinition[],
  metricsMap: Map<string, MetricsSchema>,
  currentPhase: number
): GridData {
  const rows: GridRow[] = cases.map(c => {
    if (c.hardwareSkip) {
      return {
        name: c.name,
        number: c.number,
        phase: c.phase,
        variant: c.variant,
        status: 'hardware-skip',
        statusReason: c.hardwareSkip,
        hasImages: false,
        scene: c.scene,
        lookOnly: c.lookOnly ?? false
      }
    }

    if (c.phase > currentPhase) {
      return {
        name: c.name,
        number: c.number,
        phase: c.phase,
        variant: c.variant,
        status: 'not-yet',
        statusReason: `phase ${c.phase}`,
        hasImages: false,
        scene: c.scene,
        lookOnly: c.lookOnly ?? false
      }
    }

    const m = metricsMap.get(c.name)
    if (!m) {
      return {
        name: c.name,
        number: c.number,
        phase: c.phase,
        variant: c.variant,
        status: 'not-yet',
        statusReason: 'no results',
        hasImages: false,
        scene: c.scene,
        lookOnly: c.lookOnly ?? false
      }
    }

    const row: GridRow = {
      name: c.name,
      number: c.number,
      phase: c.phase,
      variant: c.variant,
      status: m.result as GridStatus,
      statusReason: m.reasons.length > 0 ? m.reasons.join('; ') : undefined,
      metrics: {
        ssim: m.ssim,
        deMean: m.deMean,
        deP95: m.deP95,
        histDist: m.histDist,
        captureMs: m.captureMs,
        metricsMs: m.metricsMs
      },
      gpuMs: m.gpuMs,
      hasImages: true,
      scene: c.scene,
      lookOnly: c.lookOnly ?? false
    }
    if (m.sequence) {
      row.sequence = m.sequence
    }
    return row
  })

  return { rows, currentPhase }
}

export function countNumberedRows(rows: GridRow[]): number {
  const seen = new Set<number>()
  for (const r of rows) seen.add(r.number)
  return seen.size
}
