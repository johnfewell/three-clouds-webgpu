// Adapted from dgreenheck/threejs-fire-pro editor/components/PerformanceStats.tsx
// @ c284f0b (MIT, Copyright (c) 2026 Daniel Greenheck). A flat table of the
// clouds passes with raw and clock-corrected ms, a budget line and a history
// graph per row, instead of Fire Pro's simulation tree

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * MIT License
 *
 * Copyright (c) 2026 Daniel Greenheck
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* eslint-enable no-comment-slop/max-comment-lines */

import {
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FC
} from 'react'

import { FAST_PROBE_MS } from './clock'
import type { MeterRowStats } from './history'
import { byPassOrder, PASS_NOTES } from './labels'
import { gpuMeter, type MeterSnapshot } from './meter'

export const DEFAULT_BUDGET_MS = 8

const GRAPH_WIDTH = 96
const GRAPH_HEIGHT = 18

const panel: CSSProperties = {
  position: 'fixed',
  right: 8,
  bottom: 8,
  zIndex: 10000,
  width: 430,
  padding: '8px 10px',
  background: 'rgba(12, 14, 18, 0.88)',
  color: '#e6e6e6',
  font: '11px/1.35 ui-monospace, Menlo, monospace',
  borderRadius: 6,
  pointerEvents: 'auto'
}
const cell: CSSProperties = { padding: '1px 4px', whiteSpace: 'nowrap' }
const num: CSSProperties = { ...cell, textAlign: 'right' }
const muted: CSSProperties = { color: '#8a8f98' }

const STATE_TEXT: Record<MeterSnapshot['state'], string> = {
  off: 'off',
  'no-device': 'no WebGPU renderer in this story',
  unavailable: 'this GPU reports no timestamps',
  waiting: 'waiting for samples',
  live: 'live',
  failed: 'failed'
}

const skipText = (skip: MeterSnapshot['lastSkip']): string =>
  skip == null
    ? ''
    : ` (last: ${skip.alreadyTimed} passes timed by three, ${skip.overflow} over budget, ${skip.invalid} end before start)`

const fmt = (ms: number | null): string => (ms == null ? '-' : ms.toFixed(2))

const History: FC<{ series: number[]; scale: number; budget?: number }> = ({
  series,
  scale,
  budget
}) => {
  const y = (v: number): number =>
    GRAPH_HEIGHT - 1 - (Math.min(v, scale) / scale) * (GRAPH_HEIGHT - 2)
  const step = GRAPH_WIDTH / Math.max(1, series.length - 1)
  const points = series.map(
    (v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`
  )
  return (
    <svg width={GRAPH_WIDTH} height={GRAPH_HEIGHT} style={{ display: 'block' }}>
      {budget != null && (
        <line
          x1={0}
          x2={GRAPH_WIDTH}
          y1={y(budget)}
          y2={y(budget)}
          stroke='#d9534f'
          strokeDasharray='3 2'
        />
      )}
      <polyline points={points.join(' ')} fill='none' stroke='#7fc4ff' />
    </svg>
  )
}

const Row: FC<{
  row: MeterRowStats
  budget: number
  scale: number
  title?: string
  bold?: boolean
}> = ({ row, budget, scale, title, bold = false }) => {
  const shown = row.fastMs ?? row.rawMs
  const over = bold && shown > budget
  return (
    <tr title={title} style={bold ? { fontWeight: 600 } : undefined}>
      <td style={cell}>{row.label}</td>
      <td style={{ ...num, ...muted }}>
        {row.calls > 1.01
          ? `x${row.calls.toFixed(row.calls % 1 === 0 ? 0 : 1)}`
          : ''}
      </td>
      <td style={num}>{fmt(row.rawMs)}</td>
      <td style={{ ...num, color: over ? '#ff7b72' : undefined }}>
        {fmt(row.fastMs)}
      </td>
      <td style={cell}>
        <History
          series={row.series}
          scale={scale}
          budget={bold ? budget : undefined}
        />
      </td>
    </tr>
  )
}

export const GpuMeterOverlay: FC = () => {
  const snapshot = useSyncExternalStore(
    listener => gpuMeter.subscribe(listener),
    () => gpuMeter.snapshot()
  )
  const [budget, setBudget] = useState(DEFAULT_BUDGET_MS)
  const { state, stats } = snapshot
  const live = stats.samples > 0
  // One scale for every row so their graphs compare, never below the budget
  const scale = Math.max(budget * 1.25, ...stats.frame.series)
  return (
    <div style={panel} data-testid='gpu-meter'>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>GPU meter</strong>
        <span style={muted}>{STATE_TEXT[state]}</span>
        <label>
          budget{' '}
          <input
            type='number'
            min={1}
            step={0.5}
            value={budget}
            onChange={event => {
              const value = Number(event.target.value)
              if (value > 0) setBudget(value)
            }}
            style={{ width: 44, font: 'inherit' }}
          />{' '}
          ms
        </label>
      </div>
      {snapshot.message != null && (
        <div style={{ color: '#ff7b72' }}>{snapshot.message}</div>
      )}
      {live && (
        <table
          style={{ borderCollapse: 'collapse', marginTop: 4, width: '100%' }}
        >
          <thead style={muted}>
            <tr>
              <td style={cell}>pass</td>
              <td style={num}>calls</td>
              <td
                style={num}
                title='GPU ms as measured, at whatever clock the GPU ran'
              >
                raw ms
              </td>
              <td
                style={num}
                title='GPU ms of work at the fast clock (probe corrected)'
              >
                fast ms
              </td>
              <td style={cell}>last {stats.frame.series.length} samples</td>
            </tr>
          </thead>
          <tbody>
            {byPassOrder(stats.rows).map(row => (
              <Row
                key={row.label}
                row={row}
                budget={budget}
                scale={scale}
                title={PASS_NOTES[row.label]}
              />
            ))}
            <Row
              row={{ ...stats.frame, label: 'frame (GPU busy)' }}
              budget={budget}
              scale={scale}
              bold
            />
          </tbody>
        </table>
      )}
      <div style={{ ...muted, marginTop: 4 }}>
        5 samples/s, ms averaged over the last 10. fast ms = raw x{' '}
        {FAST_PROBE_MS.toFixed(2)} / probe, the clock probe timed after every
        sampled frame
        {stats.probeMs != null && ` (now ${stats.probeMs.toFixed(2)} ms)`}.
        {snapshot.incomplete > 0 &&
          ` ${snapshot.incomplete} incomplete samples dropped${skipText(snapshot.lastSkip)}.`}
        {snapshot.noDraw > 0 &&
          ` ${snapshot.noDraw} clear-only passes not timed (Metal returns unusable timestamps for them).`}
      </div>
    </div>
  )
}
