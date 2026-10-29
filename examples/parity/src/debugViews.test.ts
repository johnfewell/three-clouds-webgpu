// The shared debug-view table

import { describe, expect, it } from 'vitest'

import { cases, effectiveState } from '../cases/index'
import {
  asDebugView,
  DEBUG_VIEWS,
  MARCH_DEBUG_DEFINES,
  RESOLVE_DEBUG_DEFINES,
  syncDebugDefines,
  type DefinableMaterial
} from './debugViews'

function material(): DefinableMaterial {
  return { defines: {}, needsUpdate: false }
}

describe('debug view table', () => {
  it('covers every view exactly once across the two materials', () => {
    // The drift guard this module exists for. A view in DebugView but in
    // neither table would render side A's beauty pass against side B's debug
    // output, a wiring gap the ladder would report as a parity failure
    const covered = [
      ...Object.keys(MARCH_DEBUG_DEFINES),
      ...Object.keys(RESOLVE_DEBUG_DEFINES)
    ]
    const expected = DEBUG_VIEWS.filter(v => v !== 'none')
    expect([...covered].sort()).toEqual([...expected].sort())
  })

  it('gives every view a distinct define', () => {
    const names = [
      ...Object.values(MARCH_DEBUG_DEFINES),
      ...Object.values(RESOLVE_DEBUG_DEFINES)
    ]
    expect(new Set(names).size).toBe(names.length)
  })

  it('narrows known names and falls back to none', () => {
    expect(asDebugView('cascades')).toBe('cascades')
    expect(asDebugView('velocity')).toBe('velocity')
    expect(asDebugView('nonsense')).toBe('none')
    expect(asDebugView(undefined)).toBe('none')
    expect(asDebugView('')).toBe('none')
  })

  it("translates the case registry's kebab-case names", () => {
    // The registry and the library disagreed on spelling and nothing bridged
    // them: 'shadow-map' is not a member of the library's DebugView, so it
    // narrowed to 'none' and the view silently rendered the beauty pass
    expect(asDebugView('shadow-map')).toBe('shadowMap')
    expect(asDebugView('checker-uv')).toBe('uv')
    expect(asDebugView('sample-count')).toBe('sampleCount')
    expect(asDebugView('front-depth')).toBe('frontDepth')
  })

  it('every debug case in the registry selects a real view', () => {
    // THE regression guard. A debug case whose name does not resolve renders
    // the beauty pass on both sides and scores as a PASS, invisible in the
    // metrics. Cases 48-51 all failed this before the mapping.
    const debugCases = cases.filter(c => {
      const state = effectiveState(c)
      return state.debug !== 'none'
    })
    expect(debugCases.length).toBeGreaterThan(0)

    const unresolved = debugCases
      .map(c => ({ name: c.name, debug: effectiveState(c).debug }))
      .filter(x => asDebugView(x.debug) === 'none')

    expect(
      unresolved,
      `these cases set a debug view the library does not have: ${unresolved
        .map(x => `${x.name}=${x.debug}`)
        .join(', ')}`
    ).toEqual([])
  })

  it('every live-control debug option selects a real view', () => {
    // Same trap by a different route: the controls emit registry names too
    const names: string[] = [
      'none',
      'cascades',
      'shadow-map',
      'checker-uv',
      'sample-count',
      'front-depth'
    ]
    for (const n of names) {
      if (n === 'none') continue
      expect(asDebugView(n), `live control '${n}'`).not.toBe('none')
    }
  })
})

describe('syncDebugDefines', () => {
  it('sets exactly the active define', () => {
    const m = material()
    expect(syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'uv')).toBe(true)
    expect(m.defines).toEqual({ DEBUG_SHOW_UV: '1' })
  })

  it('clears the previous view when switching', () => {
    const m = material()
    syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'uv')
    expect(syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'cascades')).toBe(true)
    expect(m.defines).toEqual({ DEBUG_SHOW_CASCADES: '1' })
  })

  it('reports no change when the view is unchanged', () => {
    // Side A recompiles the shader on needsUpdate, so a per-frame true here
    // would rebuild the material every frame of every capture
    const m = material()
    syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'cascades')
    expect(syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'cascades')).toBe(false)
  })

  it("leaves the material clean for 'none', and reports the change once", () => {
    const m = material()
    syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'frontDepth')
    expect(syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'none')).toBe(true)
    expect(m.defines).toEqual({})
    expect(syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'none')).toBe(false)
  })

  it('ignores views belonging to the other material', () => {
    // 'velocity' is a resolve-side view: the march material must not react
    const m = material()
    expect(syncDebugDefines(m, MARCH_DEBUG_DEFINES, 'velocity')).toBe(false)
    expect(m.defines).toEqual({})
  })

  it('creates the defines object when the material has none', () => {
    const m: DefinableMaterial = { needsUpdate: false }
    expect(syncDebugDefines(m, RESOLVE_DEBUG_DEFINES, 'velocity')).toBe(true)
    expect(m.defines).toEqual({ DEBUG_SHOW_VELOCITY: '1' })
  })
})
