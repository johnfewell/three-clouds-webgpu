import type { Args, ArgTypes } from '@storybook/react-vite'
import { useContext } from 'react'
import {
  applyScenePreset,
  scenePresetNames,
  scenePresets,
  type CloudsContext,
  type ScenePresetName
} from 'three-clouds-webgpu'

import { getECIToECEFRotationMatrix } from '@takram/three-atmosphere'
import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

import { StoryContext } from '../../vendor/helpers/StoryContext'
import { useTransientControl } from '../../vendor/hooks/useTransientControl'

export interface ScenePresetsArgs extends Args {
  scenePreset: ScenePresetName
  solarTimeOfDay: number
  overrideSolarTime: boolean
}

export const scenePresetsArgs = (
  scenePreset: ScenePresetName = 'stunningSunset'
): ScenePresetsArgs => ({
  scenePreset,
  solarTimeOfDay: scenePresets[scenePreset].timeOfDay,
  overrideSolarTime: false
})

export const scenePresetsArgTypes = (): ArgTypes<ScenePresetsArgs> => ({
  scenePreset: {
    name: 'Whole-scene preset',
    control: {
      type: 'select'
    },
    options: [...scenePresetNames],
    table: { category: 'scene presets' }
  },
  solarTimeOfDay: {
    name: 'Solar time of day (0=midnight, 0.5=noon, 0.75=sunset)',
    control: { type: 'range', min: 0, max: 1, step: 0.005 },
    table: { category: 'scene presets' }
  },
  overrideSolarTime: {
    name: 'Override preset time of day with slider',
    control: { type: 'boolean' },
    table: { category: 'scene presets' }
  }
})

// Near the equinox on a full moon so 17:40 sits just above the horizon and
// 04:02 places a full moon 21 degrees up
export const SCENE_PRESET_DATE = new Date('2026-03-02T12:00:00Z')

export function useScenePresetsControls(
  ctx: CloudsContext,
  atmosphereContext: AtmosphereContext,
  location: { longitude: number; latitude: number }
): void {
  const { updateArgs } = useContext(StoryContext)

  useTransientControl(
    (a: ScenePresetsArgs) => ({
      preset: a.scenePreset,
      timeOfDay: a.solarTimeOfDay,
      override: a.overrideSolarTime
    }),
    ({ preset, timeOfDay, override }, prev) => {
      const { date } = applyScenePreset(ctx, preset, {
        date: SCENE_PRESET_DATE,
        location,
        timeOfDay: override ? timeOfDay : scenePresets[preset].timeOfDay,
        sinks: [
          {
            sunDirection: atmosphereContext.sunDirectionECEF,
            moonDirection: atmosphereContext.moonDirectionECEF
          },
          {
            sunDirection: ctx.sunDirection,
            moonDirection: ctx.moonDirection
          }
        ]
      })
      getECIToECEFRotationMatrix(date, atmosphereContext.matrixECIToECEF.value)
      if (prev != null && prev.preset !== preset) {
        updateArgs?.({
          toneMappingExposure: Number(
            (10 * scenePresets[preset].exposure).toFixed(2)
          ),
          solarTimeOfDay: scenePresets[preset].timeOfDay
        })
      }
    }
  )
}
