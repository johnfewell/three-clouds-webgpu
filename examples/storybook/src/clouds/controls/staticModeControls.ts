import { useFrame } from '@react-three/fiber'
import type { Args, ArgTypes } from '@storybook/react-vite'
import type { CloudsContext } from 'three-clouds-webgpu'

import { useTransientControl } from '../../vendor/hooks/useTransientControl'

export interface StaticModeArgs extends Args {
  'experimental-staticMode': boolean
  simulateMotion: boolean
}

export const staticModeArgs = (): StaticModeArgs => ({
  'experimental-staticMode': true,
  simulateMotion: false
})

export const staticModeArgTypes = (): ArgTypes<StaticModeArgs> => ({
  'experimental-staticMode': {
    name: 'Static mode (skip march & resolve when idle)',
    control: { type: 'boolean' },
    table: { category: 'static mode' }
  },
  simulateMotion: {
    name: 'Simulate motion (drifts clouds to resume rendering)',
    control: { type: 'boolean' },
    table: { category: 'static mode' }
  }
})

export function useStaticModeControls(
  ctx: CloudsContext,
  onChange?: (state: { enabled: boolean; motion: boolean }) => void
): void {
  let isMoving = false

  useTransientControl(
    (a: StaticModeArgs) => ({
      enabled: a['experimental-staticMode'],
      motion: a.simulateMotion
    }),
    ({ enabled, motion }) => {
      ctx.experimental = { ...ctx.experimental, staticMode: enabled }
      isMoving = motion
      if (!isMoving) {
        ctx.localWeatherVelocity.set(0, 0)
        ctx.shapeVelocity.set(0, 0, 0)
      }
      onChange?.({ enabled, motion })
    }
  )

  useFrame((_, delta) => {
    if (isMoving) {
      ctx.time += delta
      ctx.frame++
      ctx.localWeatherVelocity.set(0.002, 0)
    }
  })
}
