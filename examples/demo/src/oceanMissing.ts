// Runtime fallback stub when three-ocean-waves is not built locally

const instructions =
  'Ocean ground is unavailable. Select Bare ground or provide an optional ocean build.'

export const OceanWaves = {
  create(): Promise<never> {
    return Promise.reject(new Error(instructions))
  }
}

export function defineStyle(style: unknown): unknown {
  return style
}

export function findWaterPreset(): undefined {
  return undefined
}

export const realisticPlus = {}
export const realisticGroundswell = {
  id: 'missing',
  style: 'realistic-plus',
  styleParams: {},
  cascades: []
}
