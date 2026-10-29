// Story controls for the moonlight experiment: how much the moon's light is
// worth against the sun's, and how cool it is. Both are plain context fields,
// so changing either is a uniform update and not a graph rebuild

import { useFrame } from '@react-three/fiber'
import type { Args, ArgTypes } from '@storybook/react-vite'
import type { CloudsContext } from 'three-clouds-webgpu'

import { useTransientControl } from '../../vendor/hooks/useTransientControl'

export interface MoonlightArgs extends Args {
  moonGain: number
  moonCoolness: number
  // Stars, the moon disc and lunar inscattering, on the sky the aerial node
  // paints. Off, that sky is the stock one: the sun disc and no stars
  nightSky: boolean
}

export const moonlightArgs = (): MoonlightArgs => ({
  // The physical ratio is 2.5e-6 and a fixed exposure shows nothing, which is
  // why this starts four orders above it. docs/night-sky.md section 3
  moonGain: 4e5,
  moonCoolness: 0.35,
  nightSky: true
})

export const moonlightArgTypes = (): ArgTypes<MoonlightArgs> => ({
  moonGain: {
    name: 'Moon gain',
    control: { type: 'range', min: 0, max: 2e6, step: 1e4 },
    table: { category: 'moonlight', defaultValue: { summary: '4e5' } }
  },
  moonCoolness: {
    name: 'Moon colour (cool)',
    control: { type: 'range', min: 0, max: 1, step: 0.01 },
    table: { category: 'moonlight', defaultValue: { summary: '0.35' } }
  },
  nightSky: {
    name: 'Stars and moon in the sky',
    control: { type: 'boolean' },
    table: { category: 'moonlight', defaultValue: { summary: 'true' } }
  }
})

export function useMoonlightControls(
  ctx: CloudsContext,
  atmosphereMoonDirection: { x: number; y: number; z: number }
): void {
  useTransientControl(
    (a: MoonlightArgs) => ({
      moonGain: a.moonGain,
      moonCoolness: a.moonCoolness
    }),
    ({ moonGain, moonCoolness }) => {
      ctx.moonGain = moonGain
      // Cooler than the sun, so blue is held back and red is the reference
      ctx.moonColor.set(1, 1 - moonCoolness, 1 - moonCoolness * 1.4)
    }
  )

  // The atmosphere context already knows where the moon is, so the clouds and
  // the disc in the sky cannot disagree about it
  useFrame(() => {
    ctx.moonDirection.set(
      atmosphereMoonDirection.x,
      atmosphereMoonDirection.y,
      atmosphereMoonDirection.z
    )
  })
}
