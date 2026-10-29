import { useFrame } from '@react-three/fiber'
import type { Args, ArgTypes } from '@storybook/react-vite'
import { Color, Vector3 } from 'three'
import {
  flashEnvelopeCPU,
  type CloudsContext,
  type LightningState
} from 'three-clouds-webgpu'

import { useTransientControl } from '../../vendor/hooks/useTransientControl'

export interface LightningArgs extends Args {
  'experimental-lightning': boolean
  lightningFlash: boolean
  flashIntensity: number
  flashColor: string
  flashAltitude: number
  flashDistance: number
  animateFlashes: boolean
}

export const lightningArgs = (): LightningArgs => ({
  'experimental-lightning': true,
  lightningFlash: true,
  flashIntensity: 3.5e9,
  flashColor: '#d6e5ff',
  flashAltitude: 2600,
  flashDistance: 8000,
  animateFlashes: false
})

export const lightningArgTypes = (): ArgTypes<LightningArgs> => ({
  'experimental-lightning': {
    name: 'Lightning experiment enabled',
    control: { type: 'boolean' },
    table: { category: 'lightning' }
  },
  lightningFlash: {
    name: 'Flash active (constant test flash)',
    control: { type: 'boolean' },
    table: { category: 'lightning' }
  },
  flashIntensity: {
    name: 'Flash radiance scale',
    control: { type: 'range', min: 1e8, max: 1e10, step: 1e8 },
    table: { category: 'lightning' }
  },
  flashColor: {
    name: 'Flash tint (linear RGB)',
    control: { type: 'color' },
    table: { category: 'lightning' }
  },
  flashAltitude: {
    name: 'Flash altitude (m)',
    control: { type: 'range', min: 1000, max: 6000, step: 100 },
    table: { category: 'lightning' }
  },
  flashDistance: {
    name: 'Flash distance (m along sight)',
    control: { type: 'range', min: 2000, max: 25000, step: 500 },
    table: { category: 'lightning' }
  },
  animateFlashes: {
    name: 'Animate periodic strikes (CPU envelope)',
    control: { type: 'boolean' },
    table: { category: 'lightning' }
  }
})

export function useLightningControls(
  ctx: CloudsContext,
  getFlashPosition: (distance: number, altitude: number) => Vector3
): void {
  const scratchColor = new Color()
  const colorVec = new Vector3()
  let currentIntensity = 3.5e9
  let flashActive = true
  let isAnimating = false
  let currentDistance = 8000
  let currentAltitude = 2600

  useTransientControl(
    (a: LightningArgs) => ({
      enabled: a['experimental-lightning'],
      flash: a.lightningFlash,
      intensity: a.flashIntensity,
      color: a.flashColor,
      altitude: a.flashAltitude,
      distance: a.flashDistance,
      animate: a.animateFlashes
    }),
    ({ enabled, flash, intensity, color, altitude, distance, animate }) => {
      ctx.experimental = { ...ctx.experimental, lightning: enabled }
      flashActive = flash
      currentIntensity = intensity
      isAnimating = animate
      currentDistance = distance
      currentAltitude = altitude
      scratchColor.set(color)
      colorVec.set(scratchColor.r, scratchColor.g, scratchColor.b)

      if (!enabled) {
        ctx.lightning = null
        return
      }

      if (!animate) {
        if (flashActive && currentIntensity > 0) {
          ctx.lightning = {
            position: getFlashPosition(currentDistance, currentAltitude),
            intensity: currentIntensity,
            colour: colorVec.clone()
          }
        } else {
          ctx.lightning = null
        }
      }
    }
  )

  useFrame(({ clock }) => {
    if (!ctx.experimental.lightning || !isAnimating) return
    const sample = flashEnvelopeCPU(clock.getElapsedTime(), 42)
    if (sample.intensity > 0) {
      const state: LightningState = {
        position: getFlashPosition(currentDistance, currentAltitude),
        intensity: sample.intensity * currentIntensity,
        colour: colorVec
      }
      ctx.lightning = state
    } else {
      ctx.lightning = null
    }
  })
}
