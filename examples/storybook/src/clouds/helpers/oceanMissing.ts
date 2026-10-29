// Stand-in for three-ocean-waves when its build is not next to this checkout
// (.storybook/main.ts). Throws only when the Ocean ground is picked

const message =
  'Ocean ground is unavailable. Select Bare ground or provide an optional ocean build.'

export const OceanWaves = {
  create(): never {
    throw new Error(message)
  }
}

export function defineStyle(): never {
  throw new Error(message)
}

export const realisticPlus = null
export const realisticGroundswell = null

export function findWaterPreset(): undefined {
  return undefined
}
