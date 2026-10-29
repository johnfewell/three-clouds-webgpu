import { expect } from 'vitest'

import { log } from './log'

interface CloseOpts {
  abs?: number
  rel?: number
  label?: string
}

type Numeric =
  | number
  | { x: number; y: number; z?: number; w?: number }
  | number[]
  | { elements: number[] }

function toArray(v: Numeric): number[] {
  if (typeof v === 'number') return [v]
  if (Array.isArray(v)) return v
  if ('elements' in v) return [...v.elements]
  if ('w' in v && v.w !== undefined) return [v.x, v.y, v.z!, v.w]
  if ('z' in v && v.z !== undefined) return [v.x, v.y, v.z]
  return [v.x, v.y]
}

export function expectClose(
  actual: Numeric,
  expected: Numeric,
  opts: CloseOpts = {}
): void {
  const { abs = 1e-6, rel = 1e-6, label = 'expectClose' } = opts
  const a = toArray(actual)
  const e = toArray(expected)
  expect(a.length, `${label}: dimension mismatch`).toBe(e.length)

  const rows: Array<{
    component: string
    expected: number
    actual: number
    delta: number
    ok: boolean
  }> = []
  let allOk = true

  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const ev = e[i]!
    const delta = Math.abs(av - ev)
    const threshold = Math.max(abs, Math.abs(ev) * rel)
    const ok = delta <= threshold
    if (!ok) allOk = false
    rows.push({
      component: a.length === 1 ? label : `[${i}]`,
      expected: ev,
      actual: av,
      delta,
      ok
    })
  }

  log(label, rows)

  if (!allOk) {
    const table = rows
      .map(
        r =>
          `  ${r.component} | expected=${r.expected} actual=${r.actual} Δ=${r.delta} ${r.ok ? '✓' : '✗'}`
      )
      .join('\n')
    expect.fail(`${label}: values not close enough\n${table}`)
  }
}

export function table(
  label: string,
  rows: Array<Record<string, unknown>>
): void {
  const decorated = rows.map(r => {
    if (typeof r.expected === 'number' && typeof r.actual === 'number') {
      return { ...r, delta: Math.abs(r.actual - r.expected) }
    }
    return r
  })
  log(label, decorated)
}

export function quadrature(
  f: (x: number) => number,
  a: number,
  b: number,
  n: number
): number {
  const h = (b - a) / n
  let sum = 0.5 * (f(a) + f(b))
  for (let i = 1; i < n; i++) {
    sum += f(a + i * h)
  }
  return sum * h
}

export function seededRandom(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s * 1664525 + 1013904223) | 0
    return (s >>> 0) / 0x100000000
  }
}
