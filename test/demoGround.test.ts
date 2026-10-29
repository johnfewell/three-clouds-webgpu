import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_ION_API_TOKEN', '')
  vi.stubEnv('VITE_OCEAN_AVAILABLE', 'false')
})
afterEach(() => vi.unstubAllEnvs())

const pov = { longitude: 0, latitude: 0, heading: 0, pitch: 0, distance: 1000 }

describe('demo without optional private dependencies', () => {
  it('uses bare ground for unavailable ocean and credentialed locations', async () => {
    const { resolveGround } = await import('../examples/demo/src/resolveGround')
    for (const value of ['bare', 'ocean', 'capeTown'] as const) {
      expect(resolveGround(value, pov)).toMatchObject({
        value: 'bare',
        ocean: false,
        tiles: false
      })
    }
  })

  it('preserves ocean support when the optional build is available', async () => {
    vi.stubEnv('VITE_OCEAN_AVAILABLE', 'true')
    const { resolveGround } = await import('../examples/demo/src/resolveGround')
    expect(resolveGround('ocean', pov)).toMatchObject({
      value: 'ocean',
      ocean: true,
      tiles: false
    })
    expect(resolveGround('bare', pov)).toMatchObject({
      value: 'bare',
      ocean: false,
      tiles: false
    })
  })
})

describe('ground label', () => {
  it('names bare ground, the ocean and a location without indexing the table', async () => {
    vi.stubEnv('VITE_OCEAN_AVAILABLE', 'true')
    vi.stubEnv('VITE_ION_API_TOKEN', 'token')
    const { groundLabel, resolveGround } =
      await import('../examples/demo/src/resolveGround')
    const rows = (['bare', 'ocean', 'capeTown'] as const).map(value => ({
      value,
      label: groundLabel(resolveGround(value, pov))
    }))
    expect(rows).toEqual([
      { value: 'bare', label: 'Bare ground' },
      { value: 'ocean', label: 'Ocean' },
      { value: 'capeTown', label: 'Cape Town' }
    ])
  })

  it('labels the bare fallback when neither the ocean nor a token is built in', async () => {
    const { groundLabel, resolveGround } =
      await import('../examples/demo/src/resolveGround')
    expect(groundLabel(resolveGround('ocean', pov))).toBe('Bare ground')
  })
})
