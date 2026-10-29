// the Storybook's 3D tiles attribution repeated identical provider
// credits. Dedupe must keep EVERY unique credit (map-data providers and logo
// entries are licence requirements, not decoration) in a stable first-seen
// order, so the line does not reshuffle as tiles stream in
import { describe, expect, it } from 'vitest'

import { uniqueAttributions } from '../examples/storybook/src/vendor/components/uniqueAttributions'
import { log } from './helpers/log'

describe('uniqueAttributions', () => {
  it('drops exact duplicates and keeps first-seen order', () => {
    const input = [
      { type: 'string', value: 'Google' },
      { type: 'string', value: 'Data SIO, NOAA, U.S. Navy, NGA, GEBCO' },
      { type: 'string', value: 'Google' },
      { type: 'string', value: 'Landsat / Copernicus' },
      { type: 'string', value: 'Data SIO, NOAA, U.S. Navy, NGA, GEBCO' }
    ]
    const out = uniqueAttributions(input).map(a => a.value)
    log('attributions-dedupe', {
      in: input.length,
      out: out.length,
      order: out.join(' | ')
    })
    expect(out).toEqual([
      'Google',
      'Data SIO, NOAA, U.S. Navy, NGA, GEBCO',
      'Landsat / Copernicus'
    ])
  })

  it('never merges different kinds of credit that share a value', () => {
    // A provider's text credit and its logo are both required
    const out = uniqueAttributions([
      { type: 'string', value: 'Cesium ion' },
      { type: 'image', value: 'Cesium ion' },
      { type: 'html', value: '<a href="https://cesium.com">Cesium ion</a>' },
      { type: 'image', value: 'Cesium ion' }
    ])
    expect(out.map(a => a.type)).toEqual(['string', 'image', 'html'])
  })

  it('treats whitespace variants as one credit and drops empty ones', () => {
    const out = uniqueAttributions([
      { type: 'string', value: ' Google ' },
      { type: 'string', value: 'Google' },
      { type: 'string', value: '   ' },
      { type: 'string', value: '' }
    ])
    expect(out).toHaveLength(1)
    // The first occurrence is kept as supplied. Only the comparison trims
    expect(out[0]!.value).toBe(' Google ')
  })

  it('keeps every credit when there are no duplicates', () => {
    const input = [
      { type: 'string', value: 'A' },
      { type: 'string', value: 'B' },
      { type: 'image', value: 'https://example.com/logo.png' }
    ]
    expect(uniqueAttributions(input)).toEqual(input)
  })
})
