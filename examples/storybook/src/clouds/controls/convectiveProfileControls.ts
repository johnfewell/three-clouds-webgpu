import type { ArgTypes } from '@storybook/react-vite'
import { useContext } from 'react'
import {
  convectiveProfileDefaults,
  type ConvectiveProfileParams
} from 'three-clouds-webgpu'

import { StoryContext } from '../../vendor/helpers/StoryContext'
import { useTransientControl } from '../../vendor/hooks/useTransientControl'

// One control per uniform in src/experimental/convectiveProfile.ts. Uniforms
// rather than graph-time state, so writing one costs a uniform update and no
// rebuild (design doc section 2.3): no history reset, no pop mid-drag
export type ConvectiveProfileArgs = {
  [K in keyof ConvectiveProfileParams as `convective-${K}`]: number
}

const fields = [
  {
    key: 'anvilCenter',
    label: 'Anvil centre (height fraction)',
    min: 0,
    max: 1,
    step: 0.01
  },
  { key: 'anvilWidth', label: 'Anvil width', min: 0.01, max: 0.5, step: 0.005 },
  {
    key: 'anvilStrength',
    label: 'Anvil strength (0 is off)',
    min: 0,
    max: 3,
    step: 0.05
  },
  {
    key: 'cellsPerWeatherTile',
    label: 'Cells per weather tile',
    min: 1,
    max: 48,
    step: 1
  },
  { key: 'cellThreshold', label: 'Cell threshold', min: 0, max: 1, step: 0.01 },
  {
    key: 'cellSoftness',
    label: 'Cell softness',
    min: 0.01,
    max: 1,
    step: 0.01
  },
  {
    key: 'cellDensity',
    label: 'Cell density boost',
    min: 0,
    max: 1,
    step: 0.01
  }
] as const satisfies readonly {
  key: keyof ConvectiveProfileParams
  label: string
  min: number
  max: number
  step: number
}[]

export const convectiveProfileArgs = (): ConvectiveProfileArgs =>
  Object.fromEntries(
    fields.map(f => [`convective-${f.key}`, convectiveProfileDefaults[f.key]])
  ) as ConvectiveProfileArgs

type RangeArg = ArgTypes[keyof ArgTypes]

const range = (
  label: string,
  min: number,
  max: number,
  step: number
): RangeArg => ({
  name: label,
  control: { type: 'range', min, max, step },
  table: { category: 'convective profile' }
})

export const convectiveProfileArgTypes =
  (): ArgTypes<ConvectiveProfileArgs> => ({
    'convective-anvilCenter': range(
      'Anvil centre (height fraction)',
      0,
      1,
      0.01
    ),
    'convective-anvilWidth': range('Anvil width', 0.01, 0.5, 0.005),
    'convective-anvilStrength': range('Anvil strength (0 is off)', 0, 3, 0.05),
    'convective-cellsPerWeatherTile': range('Cells per weather tile', 1, 48, 1),
    'convective-cellThreshold': range('Cell threshold', 0, 1, 0.01),
    'convective-cellSoftness': range('Cell softness', 0.01, 1, 0.01),
    'convective-cellDensity': range('Cell density boost', 0, 1, 0.01)
  })

export function useConvectiveProfileControls(context: {
  convectiveProfile: ConvectiveProfileParams
}): void {
  const { updateArgs } = useContext(StoryContext)
  useTransientControl(
    (args: ConvectiveProfileArgs) => args,
    (args, prev) => {
      for (const f of fields) {
        const key = `convective-${f.key}` as const
        const next = args[key]
        if (next !== prev?.[key]) context.convectiveProfile[f.key] = next
      }
      updateArgs?.(args)
    }
  )
}
