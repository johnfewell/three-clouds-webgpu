// The debug-view table shared by both sides. Side A
// uses a GLSL define, side B CloudsContext.debug, so the list lives in one
// place: a view on one side only would score debug vs beauty as a failure
// Cite: clouds.frag (DEBUG_SHOW_*, DEBUG_MARCH_INTERVALS),
// cloudsResolve.frag:167-175 (DEBUG_SHOW_SHADOW_LENGTH, DEBUG_SHOW_VELOCITY)

import type { DebugView } from 'three-clouds-webgpu'

import type { DebugView as CaseDebugName } from '../cases/index'

// Views whose define lives on the march material (CloudsMaterial)
export const MARCH_DEBUG_DEFINES: Readonly<Record<string, string>> = {
  cascades: 'DEBUG_SHOW_CASCADES',
  shadowMap: 'DEBUG_SHOW_SHADOW_MAP',
  uv: 'DEBUG_SHOW_UV',
  sampleCount: 'DEBUG_SHOW_SAMPLE_COUNT',
  frontDepth: 'DEBUG_SHOW_FRONT_DEPTH',
  marchIntervals: 'DEBUG_MARCH_INTERVALS'
}

// Views whose define lives on the resolve material (CloudsResolveMaterial)
export const RESOLVE_DEBUG_DEFINES: Readonly<Record<string, string>> = {
  shadowLength: 'DEBUG_SHOW_SHADOW_LENGTH',
  velocity: 'DEBUG_SHOW_VELOCITY'
}

export const DEBUG_VIEWS: readonly DebugView[] = [
  'none',
  'cascades',
  'shadowMap',
  'uv',
  'sampleCount',
  'frontDepth',
  'shadowLength',
  'velocity',
  'marchIntervals'
]

// The registry speaks kebab-case, the library camelCase. Untranslated, cases
// 48-51 rendered the beauty pass on both sides and scored as passes. The
// Record type makes an unmapped registry name a compile error
const CASE_DEBUG_VIEWS: Record<CaseDebugName, DebugView> = {
  none: 'none',
  cascades: 'cascades',
  'shadow-map': 'shadowMap',
  'checker-uv': 'uv',
  'sample-count': 'sampleCount',
  'front-depth': 'frontDepth'
}

// debug arrives as a plain string (it round-trips through the URL) and is
// narrowed here. Unknown names fall back to 'none' rather than throwing
// mid-capture, so debugViews.test.ts asserts every registry name resolves
export function asDebugView(value: string | undefined): DebugView {
  if (value == null) return 'none'
  const mapped = CASE_DEBUG_VIEWS[value as CaseDebugName]
  if (mapped != null) return mapped
  return DEBUG_VIEWS.includes(value as DebugView)
    ? (value as DebugView)
    : 'none'
}

// Applies the one active define and clears the rest, returning whether anything
// changed. Set needsUpdate only on a change: side A recompiles on that flag,
// and doing it every frame would stall the capture and defeat the warmup
export interface DefinableMaterial {
  defines?: Record<string, unknown> | undefined
  needsUpdate: boolean
}

export function syncDebugDefines(
  material: DefinableMaterial,
  table: Readonly<Record<string, string>>,
  view: string
): boolean {
  const defines = (material.defines ??= {})
  const wanted = table[view]
  let changed = false

  for (const name of Object.values(table)) {
    const shouldBeOn = name === wanted
    const isOn = defines[name] != null
    if (shouldBeOn && !isOn) {
      defines[name] = '1'
      changed = true
    } else if (!shouldBeOn && isOn) {
      delete defines[name]
      changed = true
    }
  }

  return changed
}
