export interface PointOfViewProps {
  longitude: number
  latitude: number
  height?: number
  heading: number
  pitch: number
  distance: number
}

export const GROUND_LOCATIONS = {
  fuji: {
    title: 'Mount Fuji',
    pov: {
      longitude: 138.634,
      latitude: 35.5,
      heading: -91,
      pitch: -27,
      distance: 8444
    }
  },
  capeTown: {
    title: 'Cape Town',
    pov: {
      longitude: 18.4241,
      latitude: -33.9249,
      height: 0,
      heading: 180,
      pitch: -8,
      distance: 6000
    }
  },
  goldenGate: {
    title: 'Golden Gate',
    pov: {
      longitude: -122.4783,
      latitude: 37.8199,
      height: 0,
      heading: -20,
      pitch: -6,
      distance: 4000
    }
  },
  rio: {
    title: 'Rio de Janeiro',
    pov: {
      longitude: -43.1567,
      latitude: -22.9486,
      height: 0,
      heading: 160,
      pitch: -6,
      distance: 4000
    }
  },
  tokyo: {
    title: 'Tokyo',
    pov: {
      longitude: 139.8146,
      latitude: 35.7455,
      heading: -110,
      pitch: -9,
      distance: 1000
    }
  },
  london: {
    title: 'London',
    pov: {
      longitude: -0.1293,
      latitude: 51.4836,
      heading: -94,
      pitch: -7,
      distance: 3231
    }
  },
  toronto: {
    title: 'Toronto',
    pov: {
      longitude: -79.3871,
      latitude: 43.6426,
      heading: 90,
      pitch: -6,
      distance: 3500
    }
  }
} as const satisfies Record<string, { title: string; pov: PointOfViewProps }>

export type GroundLocationKey = keyof typeof GROUND_LOCATIONS
export type GroundValue = 'bare' | 'ocean' | GroundLocationKey

const rawIonToken: unknown = import.meta.env.VITE_ION_API_TOKEN
export const ionToken =
  typeof rawIonToken === 'string' ? rawIonToken.trim() : ''
export const hasIonToken = ionToken.length > 0
const rawOceanAvailable: unknown = import.meta.env.VITE_OCEAN_AVAILABLE
export const hasOcean = rawOceanAvailable === 'true'

export interface GroundState {
  readonly value: GroundValue
  readonly pov: PointOfViewProps
  readonly tiles: boolean
  readonly ocean: boolean
  readonly albedoScale: number | undefined
}

// The label beside the ground select. Bare ground is not a location, so it
// cannot be looked up in the table: the exported demo without the ocean build
// crashed here on its first hardware smoke (2026-10-28)
export function groundLabel(ground: GroundState): string {
  if (ground.ocean) return 'Ocean'
  if (ground.value === 'bare') return 'Bare ground'
  return GROUND_LOCATIONS[ground.value as GroundLocationKey].title
}

export function resolveGround(
  value: GroundValue,
  oceanPov: PointOfViewProps
): GroundState {
  if (value === 'bare' || (!hasOcean && (value === 'ocean' || !hasIonToken))) {
    return {
      value: 'bare',
      pov: oceanPov,
      tiles: false,
      ocean: false,
      albedoScale: undefined
    }
  }
  if (value === 'ocean' || !hasIonToken) {
    return {
      value: 'ocean',
      pov: oceanPov,
      tiles: false,
      ocean: true,
      albedoScale: undefined
    }
  }
  const location = GROUND_LOCATIONS[value]
  return {
    value,
    pov: location.pov,
    tiles: true,
    ocean: false,
    albedoScale: 2 / Math.PI
  }
}
