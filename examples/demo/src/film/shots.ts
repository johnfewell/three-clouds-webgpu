// The launch-film shot list. Each shot is a scene preset, a place and a
// keyframed camera path, all pure functions of shot time

import type {
  CloudsContext,
  EvolvingWeatherParams,
  QualityPreset,
  ScenePresetName
} from 'three-clouds-webgpu'

import type { GroundValue } from '../ground'
import type { PathKey, PathOptions } from './path'

export interface FilmAnchor {
  longitude: number
  latitude: number
  // Metres above the WGS84 ellipsoid that the path's up axis starts from
  height: number
}

export interface FilmShot {
  id: string
  title: string
  ground: GroundValue
  // Origin of the path for 3D tiles shots. Ocean shots use the ocean origin
  anchor?: FilmAnchor
  // Forward axis of the path: toward the sun, the moon, or true north,
  // turned by `frameHeading` degrees clockwise
  frame: 'sun' | 'moon' | 'north'
  frameHeading?: number
  preset: ScenePresetName
  // Local solar time as a day fraction, or a start and end for a time-lapse
  timeOfDay?: number | readonly [number, number]
  coverage?: number
  exposure?: number | readonly [number, number]
  quality?: QualityPreset
  duration: number
  path: readonly PathKey[]
  pathOptions?: PathOptions
  // Cloud clock seconds per film second; 1 is real time
  cloudTimeScale?: number
  // Weather texture drift in UV per cloud second (1 UV is about 400 km)
  weatherVelocity?: readonly [number, number]
  // false keeps the baked weather map, moved only by weatherVelocity
  evolvingWeather?: Partial<EvolvingWeatherParams> | false
  // Existing context knobs this shot sets after its preset, such as lightShafts
  configure?: (context: CloudsContext) => void
}

const DURATION = 20

// Keys for a slow push toward a subject at the anchor from below the cloud
// base. With the sun to one side (frame 'sun', frameHeading +-90) each
// shadow falls beside its cloud instead of hidden behind it
function approachKeys(options: {
  from: readonly [distance: number, height: number]
  to: readonly [distance: number, height: number]
  drift: number
  duration: number
}): PathKey[] {
  const { from, to, drift, duration } = options
  const pitchAt = (distance: number, height: number): number =>
    (-Math.atan2(height, distance) * 180) / Math.PI
  const mid = 0.25
  return [
    { t: 0, p: [-from[0], from[1], 0], heading: 0, pitch: pitchAt(...from) },
    {
      t: duration * mid,
      p: [
        -(from[0] + (to[0] - from[0]) * 0.12),
        from[1] + (to[1] - from[1]) * 0.12,
        drift * 0.12
      ],
      heading: -1,
      pitch: pitchAt(from[0], from[1])
    },
    {
      t: duration,
      p: [-to[0], to[1], drift],
      heading: (-Math.atan2(drift, to[0]) * 180) / Math.PI,
      pitch: pitchAt(...to)
    }
  ]
}

// Keys circling a subject: bearing from the subject to the camera sweeps
// from `from` to `to` degrees while the lens stays on the subject
function orbitKeys(options: {
  radius: number
  height: number
  targetHeight: number
  from: number
  to: number
  duration: number
  steps?: number
}): PathKey[] {
  const {
    radius,
    height,
    targetHeight,
    from,
    to,
    duration,
    steps = 8
  } = options
  const pitch = (Math.atan2(targetHeight - height, radius) * 180) / Math.PI
  const keys: PathKey[] = []
  for (let i = 0; i <= steps; ++i) {
    const s = i / steps
    const bearing = from + (to - from) * s
    const rad = (bearing * Math.PI) / 180
    keys.push({
      t: duration * s,
      p: [radius * Math.cos(rad), height, radius * Math.sin(rad)],
      heading: bearing + 180,
      pitch
    })
  }
  return keys
}

export const FILM_SHOTS: readonly FilmShot[] = [
  {
    id: 'ocean-sunset-skim',
    title: 'Open ocean, sunset: hold, then skim the waves into the sun',
    ground: 'ocean',
    frame: 'sun',
    preset: 'stunningSunset',
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [0, 8, 0], heading: 0, pitch: 4 },
      { t: 5, p: [15, 8, 0], heading: 0, pitch: 4 },
      { t: 10, p: [190, 6, 6], heading: 1, pitch: 3, roll: -2 },
      { t: 20, p: [1000, 5, 30], heading: 3, pitch: 3, roll: -1 }
    ]
  },
  {
    id: 'ocean-cumulus-ascent',
    title:
      'Open ocean, golden afternoon: rise off the water through the cumulus',
    ground: 'ocean',
    frame: 'sun',
    frameHeading: 60,
    preset: 'partlyCloudy',
    timeOfDay: 0.7,
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [0, 12, 0], heading: 0, pitch: 8 },
      { t: 4, p: [20, 16, 0], heading: 0, pitch: 12 },
      { t: 12, p: [900, 1300, 0], heading: -10, pitch: 18 },
      { t: 20, p: [2600, 3600, 0], heading: -25, pitch: -6 }
    ]
  },
  {
    id: 'above-the-deck-sunset',
    title: 'Above a stratocumulus deck at sunset, skimming the tops',
    ground: 'ocean',
    frame: 'sun',
    frameHeading: -8,
    preset: 'fluffy',
    timeOfDay: 0.775,
    coverage: 0.72,
    exposure: 12,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [0, 3150, 0], heading: 0, pitch: -3 },
      { t: 6, p: [250, 3120, 0], heading: 0, pitch: -3, roll: 0 },
      { t: 20, p: [2600, 2930, 120], heading: 4, pitch: -1, roll: -4 }
    ]
  },
  {
    id: 'ocean-stormy-evening-rays',
    title:
      'Open ocean, stormy evening: push in low toward sun rays under the bank',
    ground: 'ocean',
    frame: 'sun',
    preset: 'stormyEvening',
    timeOfDay: 0.745,
    exposure: 12,
    duration: DURATION,
    cloudTimeScale: 6,
    path: [
      { t: 0, p: [0, 14, 0], heading: 0, pitch: 7 },
      { t: 5, p: [20, 14, 0], heading: 0, pitch: 7 },
      { t: 20, p: [700, 22, -40], heading: -4, pitch: 9, roll: 2 }
    ]
  },
  {
    id: 'ocean-thunderstorm-dusk',
    title:
      'Open ocean, thunderstorm at dusk: slow sideways track under the deck',
    ground: 'ocean',
    frame: 'sun',
    preset: 'thunderstorm',
    timeOfDay: 0.74,
    exposure: 11,
    duration: DURATION,
    cloudTimeScale: 8,
    path: [
      { t: 0, p: [0, 10, 0], heading: 0, pitch: 12 },
      { t: 20, p: [40, 16, 260], heading: 6, pitch: 15 }
    ]
  },
  {
    id: 'towering-cumulus-flyby',
    title:
      'Towering cumulus congestus: banking flight among the towers at 3.5 km',
    ground: 'ocean',
    frame: 'sun',
    frameHeading: 100,
    preset: 'pixar',
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [0, 3500, 0], heading: 0, pitch: 0, roll: 0 },
      { t: 6, p: [400, 3500, 0], heading: 2, pitch: 0, roll: -3 },
      { t: 20, p: [2600, 3300, -500], heading: -18, pitch: -1, roll: -8 }
    ]
  },
  {
    id: 'ocean-sunset-timelapse',
    title: 'Still camera, time-lapse: clouds race past as the sun sets',
    ground: 'ocean',
    frame: 'sun',
    preset: 'stunningSunset',
    // Ends as the sun touches the horizon: just below it the cloud bases
    // light in bands (a renderer issue at that sun angle)
    timeOfDay: [0.752, 0.786],
    exposure: [10, 13],
    duration: DURATION,
    cloudTimeScale: 60,
    path: [{ t: 0, p: [0, 9, 0], heading: 0, pitch: 6 }]
  },
  {
    id: 'fuji-above-the-clouds',
    title: 'Mount Fuji: summit above the cloud deck, slow orbit',
    ground: 'fuji',
    anchor: { longitude: 138.7274, latitude: 35.3606, height: 0 },
    frame: 'north',
    preset: 'fluffy',
    timeOfDay: 0.29,
    exposure: 12,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [-9000, 4800, -3000], heading: 18, pitch: -6 },
      { t: 10, p: [-9300, 4700, 400], heading: -3, pitch: -6 },
      { t: 20, p: [-8600, 4600, 3600], heading: -22, pitch: -6 }
    ],
    pathOptions: { easeIn: false }
  },
  {
    id: 'golden-gate-sunset-swoop',
    title:
      'Golden Gate Bridge, sunset: swoop down over the bay toward the bridge',
    ground: 'goldenGate',
    anchor: { longitude: -122.4783, latitude: 37.8199, height: 0 },
    frame: 'north',
    preset: 'stunningSunset',
    timeOfDay: 0.765,
    exposure: 12,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [-1150, 600, 3300], heading: -82, pitch: -9 },
      { t: 4, p: [-1100, 585, 3050], heading: -82, pitch: -9 },
      { t: 20, p: [-300, 160, 900], heading: -84, pitch: -3 }
    ]
  },
  {
    id: 'rio-sugarloaf-flyby',
    title: 'Rio de Janeiro: fly past Sugarloaf toward Corcovado',
    ground: 'rio',
    anchor: { longitude: -43.1567, latitude: -22.9486, height: 0 },
    frame: 'north',
    preset: 'partlyCloudy',
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [-1500, 500, 300], heading: -50, pitch: -5 },
      { t: 4, p: [-1420, 495, 120], heading: -52, pitch: -5 },
      { t: 20, p: [-700, 430, -2300], heading: -85, pitch: -5, roll: 4 }
    ]
  },
  {
    id: 'cape-town-table-mountain',
    title: 'Cape Town: approach Table Mountain from the bay in evening light',
    ground: 'capeTown',
    anchor: { longitude: 18.4241, latitude: -33.9249, height: 0 },
    frame: 'north',
    preset: 'partlyCloudy',
    timeOfDay: 0.69,
    exposure: 13,
    duration: DURATION,
    cloudTimeScale: 4,
    path: [
      { t: 0, p: [4200, 600, 1050], heading: 195, pitch: -2 },
      { t: 4, p: [4050, 590, 1010], heading: 195, pitch: -2 },
      { t: 20, p: [1200, 500, 300], heading: 200, pitch: 2 }
    ]
  },
  {
    id: 'toronto-cn-tower-golden-orbit',
    title: 'Toronto: golden-hour orbit of the CN Tower, backlit by the sun',
    ground: 'toronto',
    anchor: { longitude: -79.3871, latitude: 43.6426, height: 0 },
    frame: 'north',
    preset: 'partlyCloudy',
    timeOfDay: 0.76,
    exposure: 12,
    duration: DURATION,
    cloudTimeScale: 4,
    path: orbitKeys({
      radius: 1100,
      height: 420,
      targetHeight: 330,
      from: 70,
      to: 125,
      duration: DURATION
    }),
    pathOptions: { easeIn: false }
  },
  {
    id: 'rio-cloud-shadows',
    title:
      'Rio de Janeiro, afternoon: cloud shadows sweep over Botafogo and Sugarloaf',
    ground: 'rio',
    anchor: { longitude: -43.175, latitude: -22.948, height: 0 },
    frame: 'sun',
    frameHeading: 90,
    preset: 'partlyCloudy',
    timeOfDay: 0.57,
    coverage: 0.55,
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 12,
    // A static field on a steady 12 m/s wind keeps the measured layout over
    // the city: at 12x the evolving life cycle empties the sky
    evolvingWeather: false,
    weatherVelocity: [3e-5, 0],
    path: approachKeys({
      from: [4200, 650],
      to: [2600, 560],
      drift: 700,
      duration: DURATION
    })
  },
  {
    id: 'cape-town-cloud-shadows',
    title:
      'Cape Town, midday: cloud shadows race across the city bowl to Table Mountain',
    ground: 'capeTown',
    anchor: { longitude: 18.418, latitude: -33.935, height: 0 },
    frame: 'sun',
    frameHeading: -90,
    preset: 'partlyCloudy',
    timeOfDay: 0.57,
    coverage: 0.24,
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 12,
    // A static field on a steady 12 m/s wind keeps the measured layout over
    // the city: at 12x the evolving life cycle empties the sky
    evolvingWeather: false,
    weatherVelocity: [3e-5, 0],
    path: approachKeys({
      from: [5000, 700],
      to: [3200, 620],
      drift: 700,
      duration: DURATION
    })
  },
  {
    id: 'golden-gate-cloud-shadows',
    title:
      'Golden Gate, afternoon: cloud shadows drift over the bridge and the headlands',
    ground: 'goldenGate',
    anchor: { longitude: -122.4783, latitude: 37.8199, height: 0 },
    frame: 'sun',
    frameHeading: 90,
    preset: 'partlyCloudy',
    timeOfDay: 0.57,
    coverage: 0.33,
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 12,
    // A static field on a steady 12 m/s wind keeps the measured layout over
    // the city: at 12x the evolving life cycle empties the sky
    evolvingWeather: false,
    weatherVelocity: [3e-5, 0],
    path: approachKeys({
      from: [4200, 620],
      to: [2600, 520],
      drift: -600,
      duration: DURATION
    })
  },
  {
    id: 'toronto-cloud-shadows',
    title:
      'Toronto, afternoon: cloud shadows roll over downtown and the CN Tower',
    ground: 'toronto',
    anchor: { longitude: -79.3871, latitude: 43.6426, height: 0 },
    frame: 'sun',
    frameHeading: 90,
    preset: 'partlyCloudy',
    timeOfDay: 0.57,
    coverage: 0.33,
    exposure: 10,
    duration: DURATION,
    cloudTimeScale: 12,
    // A static field on a steady 12 m/s wind keeps the measured layout over
    // the city: at 12x the evolving life cycle empties the sky
    evolvingWeather: false,
    weatherVelocity: [3e-5, 0],
    path: approachKeys({
      from: [4200, 650],
      to: [2600, 560],
      drift: 600,
      duration: DURATION
    })
  }
]

// Writes {"clouds.hazeDensityScale": 1e-5, "haze": false} style overrides
function assignPaths(target: object, values: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split('.')
    let node = target as Record<string, unknown>
    for (const key of keys.slice(0, -1)) {
      node = node[key] as Record<string, unknown>
    }
    node[keys[keys.length - 1]] = value
  }
}

function numberParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)
  if (raw == null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

// Scouting overrides: tod, exp, cov, fh (frame heading) and cts (cloud time
// scale) replace the shot's value so a look can be tried without editing
export function findFilmShot(
  id: string | null,
  params: URLSearchParams = new URLSearchParams()
): FilmShot | undefined {
  const shot = FILM_SHOTS.find(candidate => candidate.id === id)
  if (shot == null) return undefined
  const timeOfDay = numberParam(params, 'tod')
  const exposure = numberParam(params, 'exp')
  const coverage = numberParam(params, 'cov')
  const frameHeading = numberParam(params, 'fh')
  const shafts = params.get('shafts')
  const cfg = params.get('cfg')
  const cloudTimeScale = numberParam(params, 'cts')
  // pose=forward,up,right,heading,pitch holds the camera at one key
  const pose = params.get('pose')?.split(',').map(Number)
  return {
    ...shot,
    ...(timeOfDay != null && { timeOfDay }),
    ...(exposure != null && { exposure }),
    ...(coverage != null && { coverage }),
    ...(frameHeading != null && { frameHeading }),
    ...(cloudTimeScale != null && { cloudTimeScale }),
    ...(pose?.length === 5 && {
      path: [
        {
          t: 0,
          p: [pose[0], pose[1], pose[2]] as const,
          heading: pose[3],
          pitch: pose[4]
        }
      ]
    }),
    ...((shafts != null || cfg != null) && {
      configure: (context: CloudsContext) => {
        shot.configure?.(context)
        if (shafts != null) context.lightShafts = shafts === '1'
        if (cfg != null) assignPaths(context, JSON.parse(cfg))
      }
    })
  }
}
