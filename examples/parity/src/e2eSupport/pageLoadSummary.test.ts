import { describe, expect, it } from 'vitest'

import { table } from '../../../../test/helpers/cpuTwin'
import {
  formatPageLoadSummary,
  likelyStall,
  type PageLoadSnapshot,
  type PageStateSnapshot
} from './pageLoadSummary'

const page: PageStateSnapshot = {
  visibilityState: 'visible',
  hasFocus: true,
  parityPublished: false,
  rafCount: 120,
  rafCountAfterProbe: 180,
  rafProbeMs: 1000,
  visibilityChanges: [],
  gpu: { devicesRequested: 1, lost: null, uncapturedErrors: [] }
}

const base: PageLoadSnapshot = {
  caseName: 'below-deck-1km',
  url: 'http://localhost:4173/?case=below-deck-1km&e2e=1',
  msSinceNavigation: 30_000,
  lastBootStage: '[parity][below-deck-1km][B] creating-clouds-chain',
  consoleErrors: [],
  pendingRequests: [],
  page
}

describe('likelyStall', () => {
  it('names the most severe cause the snapshot supports', () => {
    const cases: [string, PageLoadSnapshot, RegExp][] = [
      ['no page answer', { ...base, page: null }, /main thread busy or hung/],
      [
        'device lost',
        {
          ...base,
          page: {
            ...page,
            gpu: { ...page.gpu, lost: { reason: 'unknown', message: 'x' } }
          }
        },
        /GPU device lost/
      ],
      [
        'published late',
        { ...base, page: { ...page, parityPublished: true } },
        /finished late/
      ],
      [
        'rAF stopped',
        { ...base, page: { ...page, rafCountAfterProbe: 120 } },
        /requestAnimationFrame is not firing/
      ],
      [
        'pending request',
        {
          ...base,
          pendingRequests: [{ url: '/assets/shape.bin', ageMs: 29_000 }]
        },
        /1 network request/
      ],
      ['no boot log', { ...base, lastBootStage: null }, /did not start/],
      ['stuck stage', base, /boot stuck after: .*creating-clouds-chain/]
    ]
    table(
      'likely-stall',
      cases.map(([name, s, re]) => ({
        name,
        likely: likelyStall(s),
        matches: re.test(likelyStall(s))
      }))
    )
    for (const [, s, re] of cases) expect(likelyStall(s)).toMatch(re)
  })
})

describe('formatPageLoadSummary', () => {
  it('reports the rAF rate, boot stage and page state', () => {
    const text = formatPageLoadSummary(base)
    expect(text).toContain('rAF: 120 callbacks since navigation, 60.0/s')
    expect(text).toContain(
      'last boot stage: [parity][below-deck-1km][B] creating-clouds-chain'
    )
    expect(text).toContain('__parity: missing')
    expect(text.split('\n')[0]).toBe(`likely: ${likelyStall(base)}`)
  })

  it('says so when the page state could not be read', () => {
    expect(formatPageLoadSummary({ ...base, page: null })).toContain(
      'page state: unavailable (evaluate timed out)'
    )
  })
})
