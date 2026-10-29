import { describe, expect, it } from 'vitest'

import { table } from '../../../../test/helpers/cpuTwin'
import { settledTitle, titleProblem, type TitleSource } from './r3fTitle'

// A page whose title() yields these reads in order (an Error rejects, as
// title() does while the execution context is replaced), then repeats the last
function reads(titles: Array<string | Error>): TitleSource & { calls: number } {
  const source = {
    calls: 0,
    title: () => {
      const next = titles[Math.min(source.calls++, titles.length - 1)]!
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next)
    },
    waitForTimeout: () => Promise.resolve()
  }
  return source
}

const R3F = 'three-clouds-webgpu — r3f example'
// The config probes a free port per run, so the messages name
// whatever origin the smoke actually navigated to
const ORIGIN = 'http://localhost:5317'

describe('r3f smoke title check', () => {
  it('waits out a Vite dependency-optimize reload instead of failing on it', async () => {
    // The receipt-run sequence: '' and a destroyed context mid-reload, then the app
    const page = reads([
      '',
      new Error('Execution context was destroyed'),
      '',
      R3F
    ])
    const settled = await settledTitle(page, 5_000)
    table('cold-cache reload', [
      { field: 'settled title', expected: R3F, actual: settled },
      { field: 'title() reads', expected: 4, actual: page.calls },
      {
        field: 'problem',
        expected: null,
        actual: titleProblem(settled, 5_000, ORIGIN)
      }
    ])
    expect(settled).toBe(R3F)
    expect(page.calls).toBe(4)
    expect(titleProblem(settled, 5_000, ORIGIN)).toBeNull()
  })

  it('reports an empty title as an unsettled page, never as a foreign server', () => {
    const problem = titleProblem('', 60_000, ORIGIN)
    table('empty title', [
      {
        field: 'names the reload',
        expected: true,
        actual: problem?.includes('never settled')
      },
      {
        field: 'blames a foreign server',
        expected: false,
        actual: problem?.includes('Something else is bound')
      }
    ])
    expect(problem).toContain('never settled')
    expect(problem).not.toContain('Something else is bound')
  })

  it('still fails a different app as a foreign server', async () => {
    const settled = await settledTitle(reads(['Storybook']), 5_000)
    const problem = titleProblem(settled, 5_000, ORIGIN)
    table('foreign app', [
      { field: 'settled title', expected: 'Storybook', actual: settled },
      {
        field: 'blames a foreign server',
        expected: true,
        actual: problem?.includes('Something else is bound')
      }
    ])
    expect(problem).toContain('Something else is bound')
  })

  it('names the origin the smoke actually used, not a pinned port', () => {
    // The messages used to interpolate the literal ':5200'. The config probes
    // a free port per run, so that named a port nothing was listening on and
    // sent the reader to the wrong server
    const problem = titleProblem('Storybook', 60_000, ORIGIN)
    table('message names the real origin', [
      {
        field: 'names the origin',
        expected: true,
        actual: problem?.includes(ORIGIN)
      },
      {
        field: 'names the old literal',
        expected: false,
        actual: problem?.includes(':5200')
      }
    ])
    expect(problem).toContain(ORIGIN)
    expect(problem).not.toContain(':5200')
  })

  it('returns an empty title at the deadline instead of hanging', async () => {
    const page = reads([''])
    const settled = await settledTitle(page, 0)
    table('never settles', [
      { field: 'settled title', expected: '', actual: settled },
      { field: 'title() reads', expected: 1, actual: page.calls }
    ])
    expect(settled).toBe('')
    expect(titleProblem(settled, 0, ORIGIN)).toContain('never settled')
  })
})
