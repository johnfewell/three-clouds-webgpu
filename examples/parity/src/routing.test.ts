import { describe, expect, it } from 'vitest'

import { parseHarnessParams, type HarnessParams } from './routing'

const DEFAULTS: HarnessParams = {
  caseName: null,
  capture: false,
  view: 'ab',
  e2e: false,
  backend: 'webgpu',
  reversedDepthBuffer: false,
  lighting: null,
  atmosphereProfile: 'reference',
  size: null
}

interface RoutingCase {
  label: string
  search: string
  expected: Partial<HarnessParams>
}

const cases: RoutingCase[] = [
  {
    label: 'reversed depth requires an explicit opt-in',
    search: '?reversedDepth=1',
    expected: { reversedDepthBuffer: true }
  },
  {
    label: 'unknown reversed depth values preserve the ordinary default',
    search: '?reversedDepth=true',
    expected: { reversedDepthBuffer: false }
  },
  { label: 'empty', search: '', expected: {} },
  {
    label: '?case=baseline-medium',
    search: '?case=baseline-medium',
    expected: { caseName: 'baseline-medium' }
  },
  {
    label: '&capture=1',
    search: '?case=test&capture=1',
    expected: { caseName: 'test', capture: true }
  },
  {
    label: '&view=wipe',
    search: '?view=wipe',
    expected: { view: 'wipe' }
  },
  {
    label: '&view=onion',
    search: '?view=onion',
    expected: { view: 'onion' }
  },
  {
    label: '&view=diff',
    search: '?view=diff',
    expected: { view: 'diff' }
  },
  {
    label: '&view=invalid falls back to ab',
    search: '?view=bogus',
    expected: { view: 'ab' }
  },
  {
    label: '&e2e=1',
    search: '?e2e=1',
    expected: { e2e: true }
  },
  {
    label: '&e2e=0 stays false',
    search: '?e2e=0',
    expected: { e2e: false }
  },
  {
    label: '&backend=webgl2',
    search: '?backend=webgl2',
    expected: { backend: 'webgl2' }
  },
  {
    label: '&backend=invalid falls back to webgpu',
    search: '?backend=other',
    expected: { backend: 'webgpu' }
  },
  {
    label: '&lighting=post',
    search: '?lighting=post',
    expected: { lighting: 'post' }
  },
  {
    label: '&lighting=lights',
    search: '?lighting=lights',
    expected: { lighting: 'lights' }
  },
  {
    label: '&lighting=invalid stays null',
    search: '?lighting=bogus',
    expected: { lighting: null }
  },
  // the render-size override the height-residue e2e uses
  {
    label: '&w=&h= overrides the case size',
    search: '?case=baseline-medium&e2e=1&w=1280&h=717',
    expected: {
      caseName: 'baseline-medium',
      e2e: true,
      size: { width: 1280, height: 717 }
    }
  },
  {
    label: '&h= alone is no override (both or neither)',
    search: '?case=baseline-medium&h=717',
    expected: { caseName: 'baseline-medium', size: null }
  },
  {
    label: 'non-integer or non-positive sizes are no override',
    search: '?case=baseline-medium&w=1280.5&h=0',
    expected: { caseName: 'baseline-medium', size: null }
  },
  {
    label: 'all params combined',
    search:
      '?case=shadow-sphere&capture=1&view=diff&e2e=1&backend=webgl2&lighting=lights',
    expected: {
      caseName: 'shadow-sphere',
      capture: true,
      view: 'diff',
      e2e: true,
      backend: 'webgl2',
      lighting: 'lights'
    }
  }
]

describe('parseHarnessParams', () => {
  it.each(cases)('$label', ({ search, expected }) => {
    const result = parseHarnessParams(search)
    const full = { ...DEFAULTS, ...expected }
    expect(result).toEqual(full)
  })

  // The aerial node lost its budget-closure lanes with the interim subclass
  // Ignoring the param would render the normal plate under a lane's name
  it.each(['read1', 'read2', 'off', ''])('refuses bcLane=%s', lane => {
    expect(() => parseHarnessParams(`?case=x&bcLane=${lane}`)).toThrow(
      /bcLane=.* is no longer supported/
    )
  })
})
