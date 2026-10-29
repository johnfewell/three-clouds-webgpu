// Story controls for the evolving-weather experiment: the knobs on
// context.evolvingWeather, and a clock the story owns so it can run faster
// than real time or hold still at one moment

import { useFrame } from '@react-three/fiber'
import type { Args, ArgTypes } from '@storybook/react-vite'
import { getDefaultStore } from 'jotai'
import { useContext, useRef } from 'react'
import {
  evolvingWeatherDefaults,
  type CloudsContext,
  type EvolvingWeatherParams
} from 'three-clouds-webgpu'

import { StoryContext } from '../../vendor/helpers/StoryContext'
import { useTransientControl } from '../../vendor/hooks/useTransientControl'

export interface EvolvingWeatherArgs extends Args {
  // Off holds context.time at `evolution-time`, so a still is a pure function
  // of that number
  evolutionRunning: boolean
  evolutionSpeed: number
  evolutionTime: number
  evolutionWindSpeed: number
  evolutionWindPatternKm: number
  evolutionCellLifetime: number
  evolutionLifeStrength: number
}

export const evolvingWeatherArgs = (): EvolvingWeatherArgs => ({
  evolutionRunning: true,
  evolutionSpeed: 10,
  evolutionTime: 0,
  evolutionWindSpeed: evolvingWeatherDefaults.windSpeed,
  evolutionWindPatternKm: evolvingWeatherDefaults.windPatternSize / 1000,
  evolutionCellLifetime: evolvingWeatherDefaults.cellLifetime,
  evolutionLifeStrength: evolvingWeatherDefaults.lifeStrength
})

const category = { table: { category: 'evolving weather' } }

export const evolvingWeatherArgTypes = (): ArgTypes<EvolvingWeatherArgs> => ({
  evolutionRunning: {
    name: 'clock running',
    control: { type: 'boolean' },
    ...category
  },
  evolutionSpeed: {
    name: 'clock speed (x real time)',
    control: { type: 'range', min: 1, max: 200, step: 1 },
    ...category
  },
  evolutionTime: {
    name: 'time (s)',
    control: { type: 'range', min: 0, max: 7200, step: 10 },
    ...category
  },
  evolutionWindSpeed: {
    name: 'wind speed (m/s)',
    control: { type: 'range', min: 0, max: 100, step: 1 },
    ...category
  },
  evolutionWindPatternKm: {
    name: 'wind pattern size (km)',
    control: { type: 'range', min: 50, max: 2000, step: 10 },
    ...category
  },
  evolutionCellLifetime: {
    name: 'cell lifetime (s)',
    control: { type: 'range', min: 30, max: 3600, step: 10 },
    ...category
  },
  evolutionLifeStrength: {
    name: 'grow and fade strength',
    control: { type: 'range', min: 0, max: 1, step: 0.01 },
    ...category
  }
})

// The clock is written from a frame subscription rather than a prop: the pass
// advances context.time itself every frame, at priority 1, so this has to run
// after it. r3f calls subscribers in ascending priority
export function useEvolvingWeather(context: CloudsContext): void {
  const { argsAtom } = useContext(StoryContext)
  // Applied on the first render too, so args from the story or the URL count
  useTransientControl<Args & EvolvingWeatherArgs, EvolvingWeatherParams>(
    args => ({
      windSpeed: args.evolutionWindSpeed,
      windPatternSize: args.evolutionWindPatternKm * 1000,
      cellLifetime: args.evolutionCellLifetime,
      lifeStrength: args.evolutionLifeStrength
    }),
    value => {
      if (Number.isFinite(value.windSpeed)) {
        Object.assign(context.evolvingWeather, value)
      }
    }
  )

  const clock = useRef<number | null>(null)
  const scrubbed = useRef<number | null>(null)
  useFrame((_, delta) => {
    const args = getDefaultStore().get(argsAtom) as Partial<EvolvingWeatherArgs>
    // Stories without these args keep the pass's own clock
    if (args.evolutionTime == null) return
    // Moving the time slider seeks, whether or not the clock runs
    if (clock.current == null || args.evolutionTime !== scrubbed.current) {
      clock.current = args.evolutionTime
      scrubbed.current = args.evolutionTime
    }
    if (args.evolutionRunning) {
      clock.current += delta * (args.evolutionSpeed ?? 1)
    }
    context.time = clock.current
  }, 2)
}
