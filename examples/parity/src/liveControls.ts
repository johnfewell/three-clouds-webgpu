import GUI from 'lil-gui'

import type { ViewMode } from './routing'
import type { ViewState } from './viewModes'

export type KnobType = 'boolean' | 'number' | 'select' | 'readonly'

export interface KnobDef {
  readonly key: string
  readonly label: string
  readonly group: string
  readonly type: KnobType
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: readonly string[]
  readonly phase: number
}

export const PARITY_KNOB_DEFS: readonly KnobDef[] = [
  {
    key: 'enabled',
    label: 'enabled',
    group: 'General',
    type: 'boolean',
    phase: 0
  },
  {
    key: 'qualityPreset',
    label: 'qualityPreset',
    group: 'General',
    type: 'select',
    options: ['low', 'medium', 'high', 'ultra'],
    phase: 1
  },
  {
    key: 'resolutionScale',
    label: 'resolutionScale',
    group: 'General',
    type: 'number',
    min: 0.25,
    max: 1,
    step: 0.25,
    phase: 1
  },
  {
    key: 'temporalUpscale',
    label: 'temporalUpscale',
    group: 'General',
    type: 'boolean',
    phase: 2
  },
  {
    key: 'temporalAntialiasing',
    label: 'temporalAntialiasing',
    group: 'General',
    type: 'boolean',
    phase: 2
  },

  {
    key: 'coverage',
    label: 'coverage',
    group: 'Density',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    phase: 1
  },
  {
    key: 'shapeDetail',
    label: 'shapeDetail',
    group: 'Density',
    type: 'boolean',
    phase: 1
  },
  {
    key: 'turbulence',
    label: 'turbulence',
    group: 'Density',
    type: 'boolean',
    phase: 1
  },
  {
    key: 'layers',
    label: 'layers',
    group: 'Density',
    type: 'select',
    options: ['1', '2', '4'],
    phase: 1
  },

  {
    key: 'multiScatteringOctaves',
    label: 'multiScatteringOctaves',
    group: 'Lighting',
    type: 'number',
    min: 1,
    max: 8,
    step: 1,
    phase: 1
  },
  {
    key: 'accurateSunSkyLight',
    label: 'accurateSunSkyLight',
    group: 'Lighting',
    type: 'boolean',
    phase: 1
  },
  {
    key: 'accuratePhaseFunction',
    label: 'accuratePhaseFunction',
    group: 'Lighting',
    type: 'boolean',
    phase: 4
  },
  {
    key: 'groundBounceScale',
    label: 'groundBounceScale',
    group: 'Lighting',
    type: 'number',
    min: 0,
    max: 2,
    step: 0.1,
    phase: 4
  },

  {
    key: 'haze',
    label: 'haze',
    group: 'Environment',
    type: 'boolean',
    phase: 4
  },
  {
    key: 'lightShafts',
    label: 'lightShafts',
    group: 'Environment',
    type: 'boolean',
    phase: 3
  },
  {
    key: 'correctAltitude',
    label: 'correctAltitude',
    group: 'Environment',
    type: 'boolean',
    phase: 1
  },

  {
    key: 'shadow',
    label: 'shadow',
    group: 'Shadows',
    type: 'boolean',
    phase: 3
  },
  {
    key: 'shadowCascadeCount',
    label: 'shadow.cascadeCount',
    group: 'Shadows',
    type: 'number',
    min: 1,
    max: 4,
    step: 1,
    phase: 3
  },
  {
    key: 'shadowMapSize',
    label: 'shadow.mapSize',
    group: 'Shadows',
    type: 'select',
    options: ['256', '512', '1024'],
    phase: 3
  },

  {
    key: 'maxIterationCountToGround',
    label: 'maxIterationCountToGround',
    group: 'Rendering',
    type: 'number',
    min: 0,
    max: 10,
    step: 1,
    phase: 1
  },
  {
    // Construction-time on both sides (renderer option), so this control is
    // display-only. It exists because PARITY_KEYS_PHASE covers every CaseState key
    // and the panel mirrors that set (case 46)
    key: 'proceduralTextures',
    label: 'procedural textures',
    group: 'Rendering',
    type: 'boolean',
    phase: 4
  },
  {
    // Construction-time on both sides, like logarithmicDepthBuffer
    key: 'logarithmicDepthBuffer',
    label: 'log depth',
    group: 'Rendering',
    type: 'boolean',
    phase: 4
  },
  {
    key: 'debug',
    label: 'debug',
    group: 'Rendering',
    type: 'select',
    options: [
      'none',
      'cascades',
      'shadow-map',
      'checker-uv',
      'sample-count',
      'front-depth'
    ],
    phase: 4
  },

  {
    key: 'warmup',
    label: 'warmup',
    group: 'Capture',
    type: 'number',
    min: 1,
    max: 256,
    step: 1,
    phase: 0
  }
]

export const KNOB_GROUPS = [
  'General',
  'Density',
  'Lighting',
  'Environment',
  'Shadows',
  'Rendering',
  'Capture'
] as const

export interface LiveState {
  [key: string]: boolean | number | string
}

export function defaultLiveState(): LiveState {
  const state: LiveState = {}
  for (const def of PARITY_KNOB_DEFS) {
    if (def.type === 'boolean') state[def.key] = false
    else if (def.type === 'number') state[def.key] = def.min ?? 0
    else if (def.type === 'select') state[def.key] = def.options?.[0] ?? ''
  }
  state['enabled'] = true
  state['qualityPreset'] = 'medium'
  state['resolutionScale'] = 1
  state['coverage'] = 0.3
  state['multiScatteringOctaves'] = 8
  state['layers'] = '1'
  state['shadowCascadeCount'] = 3
  state['shadowMapSize'] = '256'
  state['debug'] = 'none'
  state['warmup'] = 64
  state['temporalAntialiasing'] = true
  return state
}

export type KnobChangeCallback = (
  key: string,
  value: boolean | number | string
) => void

export function buildPanel(
  container: HTMLElement,
  state: LiveState,
  viewState: ViewState,
  onChange: KnobChangeCallback,
  onViewChange: (mode: ViewMode) => void
): GUI {
  const gui = new GUI({ container, title: 'Parity Controls', width: 280 })

  const viewFolder = gui.addFolder('View')
  viewFolder
    .add({ mode: viewState.mode }, 'mode', ['ab', 'wipe', 'onion', 'diff'])
    .name('view')
    .onChange((v: ViewMode) => onViewChange(v))
  viewFolder
    .add(viewState, 'wipePosition', 0, 1, 0.01)
    .name('wipe')
    .onChange(() => onChange('_viewUpdate', true))
  viewFolder
    .add(viewState, 'onionOpacity', 0, 1, 0.01)
    .name('opacity')
    .onChange(() => onChange('_viewUpdate', true))

  const sunFolder = gui.addFolder('Sun')
  const sunState = { elevation: 45, azimuth: 180 }
  sunFolder
    .add(sunState, 'elevation', -10, 90, 1)
    .onChange((v: number) => onChange('sunElevation', v))
  sunFolder
    .add(sunState, 'azimuth', 0, 360, 1)
    .onChange((v: number) => onChange('sunAzimuth', v))

  const timeFolder = gui.addFolder('Time')
  const timeState = { time: 0, frame: 0, frameLock: false }
  timeFolder
    .add(timeState, 'time', 0, 60, 0.01)
    .onChange((v: number) => onChange('time', v))
  timeFolder
    .add(timeState, 'frame', 0, 1000, 1)
    .onChange((v: number) => onChange('frame', v))
  timeFolder
    .add(timeState, 'frameLock')
    .name('frame lock')
    .onChange((v: boolean) => onChange('frameLock', v))

  const folders = new Map<string, GUI>()
  for (const group of KNOB_GROUPS) {
    folders.set(group, gui.addFolder(group))
  }

  for (const def of PARITY_KNOB_DEFS) {
    const folder = folders.get(def.group)!
    switch (def.type) {
      case 'boolean':
        folder
          .add(state, def.key)
          .name(def.label)
          .onChange((v: boolean) => onChange(def.key, v))
        break
      case 'number':
        folder
          .add(state, def.key, def.min, def.max, def.step)
          .name(def.label)
          .onChange((v: number) => onChange(def.key, v))
        break
      case 'select':
        folder
          .add(state, def.key, [...(def.options ?? [])])
          .name(def.label)
          .onChange((v: string) => onChange(def.key, v))
        break
    }
  }

  const readouts = gui.addFolder('Readouts')
  readouts
    .add({ gpuA: 'n/a', gpuB: 'n/a', ssim: 'n/a' }, 'gpuA')
    .name('GPU ms A')
    .disable()
  readouts
    .add({ gpuA: 'n/a', gpuB: 'n/a', ssim: 'n/a' }, 'gpuB')
    .name('GPU ms B')
    .disable()
  readouts
    .add({ gpuA: 'n/a', gpuB: 'n/a', ssim: 'n/a' }, 'ssim')
    .name('SSIM')
    .disable()

  return gui
}

export function knobKeySet(): Set<string> {
  return new Set(PARITY_KNOB_DEFS.map(d => d.key))
}

export function knobsByGroup(): Map<string, KnobDef[]> {
  const map = new Map<string, KnobDef[]>()
  for (const def of PARITY_KNOB_DEFS) {
    const arr = map.get(def.group) ?? []
    arr.push(def)
    map.set(def.group, arr)
  }
  return map
}
