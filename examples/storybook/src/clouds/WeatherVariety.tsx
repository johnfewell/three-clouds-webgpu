// The story controls for the seeded procedural weather map, a generated map in
// place of the baked one. The opt-in is `experimental-proceduralWeather`
// (experimentalControls.ts), so Baseline is one click away
//
// Every parameter except the patterns is a uniform, so the panel writes it and
// calls update(), one dispatch and no graph rebuild

import type { Args, ArgTypes } from '@storybook/react-vite'
import { atom, getDefaultStore, useSetAtom } from 'jotai'
import { useContext, useEffect, type FC } from 'react'
import { ProceduralWeather, type WeatherPattern } from 'three-clouds-webgpu'
import { useClouds } from 'three-clouds-webgpu/r3f'

import { StoryContext } from '../vendor/helpers/StoryContext'
import { useResource } from '../vendor/hooks/useResource'

/** What `<Clouds localWeatherTexture>` binds: null means the baked PNG */
export const weatherTextureAtom = atom<ProceduralWeather | null>(null)

export interface WeatherArgs {
  'experimental-proceduralWeather': boolean
  experimentMode: 'baseline' | 'experiments'
  weatherSeed: number
  weatherCoverage: number
  weatherClumpiness: number
  weatherBands: number
  weatherGap: number
  weatherLowPattern: WeatherPattern
  weatherMidPattern: WeatherPattern
  weatherHighPattern: WeatherPattern
}

const PATTERNS: readonly string[] = ['clumps', 'bands', 'scattered']

const patternControl = (name: string) => ({
  name,
  control: { type: 'select' as const },
  options: PATTERNS,
  table: { category: 'weather variety' }
})

const rangeControl = (
  name: string,
  min: number,
  max: number,
  step: number
) => ({
  name,
  control: { type: 'range' as const, min, max, step },
  table: { category: 'weather variety' }
})

export const weatherArgs = (): WeatherArgs => ({
  'experimental-proceduralWeather': true,
  experimentMode: 'experiments',
  weatherSeed: 7,
  weatherCoverage: 0.5,
  weatherClumpiness: 0.15,
  weatherBands: 6,
  weatherGap: 0,
  weatherLowPattern: 'clumps',
  weatherMidPattern: 'clumps',
  weatherHighPattern: 'bands'
})

export const weatherArgTypes = (): Partial<ArgTypes<WeatherArgs>> => ({
  weatherSeed: rangeControl('Seed', -8, 32, 1),
  weatherCoverage: rangeControl('Coverage (all channels)', 0, 1, 0.05),
  weatherClumpiness: rangeControl('Clumpiness', 0, 1, 0.05),
  weatherBands: rangeControl('Bands (banded channels)', 1, 12, 1),
  weatherGap: rangeControl('Clear gaps', 0, 1, 0.05),
  weatherLowPattern: patternControl('Low layer pattern'),
  weatherMidPattern: patternControl('Mid layer pattern'),
  weatherHighPattern: patternControl('High layer pattern')
})

// The panel's args, read without subscribing: the panel re-renders the story on
// its own, and useTransientControl's write path is not a read hook
function useStoryArgs<T extends Args>(pick: (args: T) => unknown): unknown {
  const { argsAtom } = useContext(StoryContext)
  return pick(getDefaultStore().get(argsAtom) as T)
}

/**
 * Owns one generator for the story and hands it to `<Clouds>`. Renders nothing
 * and does nothing while the opt-in is off, so every other story is untouched
 */
export const WeatherVariety: FC = () => {
  const { context } = useClouds()
  const setTexture = useSetAtom(weatherTextureAtom)

  const args = useStoryArgs<WeatherArgs>(a => ({
    enabled:
      a.experimentMode === 'experiments' && a['experimental-proceduralWeather'],
    seed: a.weatherSeed,
    coverage: a.weatherCoverage,
    clumpiness: a.weatherClumpiness,
    bands: a.weatherBands,
    gap: a.weatherGap,
    low: a.weatherLowPattern,
    mid: a.weatherMidPattern,
    high: a.weatherHighPattern
  })) as {
    enabled: boolean
    seed: number
    coverage: number
    clumpiness: number
    bands: number
    gap: number
    low: WeatherPattern
    mid: WeatherPattern
    high: WeatherPattern
  }

  // Rebuilt only when a pattern changes, the one parameter that is graph time
  const weather = useResource(
    () =>
      new ProceduralWeather({
        size: 512,
        low: { pattern: args.low },
        mid: { pattern: args.mid },
        high: { pattern: args.high }
      }),
    [args.low, args.mid, args.high]
  )

  useEffect(() => {
    if (!args.enabled) {
      setTexture(null)
      return
    }
    // The flag installs a default generator of its own, and this one is the
    // parameterised one. The default is left allocated: disposing a texture the
    // pass has already bound would invalidate that binding
    weather.seed = args.seed
    weather.coverage.setScalar(args.coverage)
    weather.clumpiness.setScalar(args.clumpiness)
    weather.bands.setScalar(args.bands)
    weather.gap.setScalar(args.gap)
    weather.update()
    setTexture(weather)
    return () => {
      setTexture(null)
    }
  }, [args, weather, setTexture, context])

  return null
}
