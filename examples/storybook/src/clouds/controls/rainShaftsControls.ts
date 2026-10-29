import type { Args, ArgTypes } from '@storybook/react-vite'
import { rainShaftDefaults, type CloudsContext } from 'three-clouds-webgpu'

import { useTransientControl } from '../../vendor/hooks/useTransientControl'

export interface RainShaftsArgs extends Args {
  'experimental-rainShafts': boolean
  'experimental-convectiveProfile': boolean
  rainShaftStrength: number
  rainShaftDensity: number
  rainShaftSlant: number
}

export const rainShaftsArgs = (): RainShaftsArgs => ({
  'experimental-rainShafts': true,
  'experimental-convectiveProfile': true,
  rainShaftStrength: rainShaftDefaults.strength,
  rainShaftDensity: rainShaftDefaults.density,
  rainShaftSlant: rainShaftDefaults.slant
})

export const rainShaftsArgTypes = (): ArgTypes<RainShaftsArgs> => ({
  'experimental-rainShafts': {
    name: 'Rain shafts under cells',
    control: { type: 'boolean' },
    table: { category: 'rain shafts' }
  },
  'experimental-convectiveProfile': {
    name: 'Convective cell mask',
    control: { type: 'boolean' },
    table: { category: 'rain shafts' }
  },
  rainShaftStrength: {
    name: 'Shaft opacity strength',
    control: { type: 'range', min: 0, max: 2, step: 0.05 },
    table: { category: 'rain shafts' }
  },
  rainShaftDensity: {
    name: 'Extinction density (per m)',
    control: { type: 'range', min: 2e-5, max: 5e-4, step: 1e-5 },
    table: { category: 'rain shafts' }
  },
  rainShaftSlant: {
    name: 'Horizontal lean (slant)',
    control: { type: 'range', min: -1, max: 1, step: 0.05 },
    table: { category: 'rain shafts' }
  }
})

export function useRainShaftsControls(ctx: CloudsContext): void {
  useTransientControl(
    (a: RainShaftsArgs) => ({
      rainShaftsEnabled: a['experimental-rainShafts'],
      convectiveEnabled: a['experimental-convectiveProfile'],
      strength: a.rainShaftStrength,
      density: a.rainShaftDensity,
      slant: a.rainShaftSlant
    }),
    ({ rainShaftsEnabled, convectiveEnabled, strength, density, slant }) => {
      ctx.experimental = {
        ...ctx.experimental,
        rainShafts: rainShaftsEnabled,
        convectiveProfile: convectiveEnabled
      }
      ctx.rainShafts = {
        strength,
        density,
        slant
      }
    }
  )
}
