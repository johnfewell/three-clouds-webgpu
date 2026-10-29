import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Matrix4, Vector3, type PerspectiveCamera } from 'three'
import { CloudsContext, qualityPresets } from 'three-clouds-webgpu'
import { describe, expect, it } from 'vitest'

import { CloudsEffect } from '@takram/three-clouds'

import { table } from '../../../test/helpers/cpuTwin'
import { BASE_STATE, caseByName, cases } from '../cases/index'
import {
  applyToB,
  buildCaseParityState,
  caseToParityCase,
  keyExistsOnTarget,
  PARITY_KEYS
} from './parityState'
import type { SideBHandle } from './sideB'

// the full knob surface ships through phase 4. The skip
// list is empty and every key is asserted live on BOTH sides
const SHIPPED_PHASE = 4

// Renders the final migration table exactly as it is pasted verbatim into
// docs/MIGRATION.md. The comparison test below enforces
// that the document and the PARITY_KEYS-generated table never drift
function renderMigrationTable(
  rows: Array<{ key: string; webgl: string; webgpu: string; status: string }>
): string {
  const lines = ['| Key | WebGL | WebGPU | Status |', '|---|---|---|---|']
  for (const row of rows) {
    lines.push(`| ${row.key} | ${row.webgl} | ${row.webgpu} | ${row.status} |`)
  }
  return lines.join('\n')
}

describe('PARITY_KEYS coverage', () => {
  it('every key exists on CloudsEffect (side A)', () => {
    const clouds = new CloudsEffect()
    const target = clouds as unknown as Record<string, unknown>
    const rows: Array<{
      key: string
      phase: number
      nested: string
      exists: boolean
      skipped: boolean
    }> = []

    for (const entry of PARITY_KEYS) {
      const exists = keyExistsOnTarget(target, entry)
      const skipped = entry.phase > SHIPPED_PHASE
      rows.push({
        key: entry.nested ? `${entry.nested}.${entry.key}` : entry.key,
        phase: entry.phase,
        nested: entry.nested ?? '',
        exists,
        skipped
      })
      if (!skipped) {
        expect(
          exists,
          `A missing: ${entry.key} (nested=${entry.nested ?? 'none'})`
        ).toBe(true)
      }
    }

    table('parity-keys-sideA', rows)
    clouds.dispose()
  })

  it('every key exists on CloudsContext (side B)', () => {
    const ctx = new CloudsContext()
    const target = ctx as unknown as Record<string, unknown>
    const rows: Array<{
      key: string
      phase: number
      nested: string
      exists: boolean
      skipped: boolean
    }> = []

    for (const entry of PARITY_KEYS) {
      const exists = keyExistsOnTarget(target, entry)
      const skipped = entry.phase > SHIPPED_PHASE
      rows.push({
        key: entry.nested ? `${entry.nested}.${entry.key}` : entry.key,
        phase: entry.phase,
        nested: entry.nested ?? '',
        exists,
        skipped
      })
      if (!skipped) {
        expect(
          exists,
          `B missing: ${entry.key} (nested=${entry.nested ?? 'none'})`
        ).toBe(true)
      }
    }

    table('parity-keys-sideB', rows)
    ctx.dispose()
  })

  it('final migration table matches docs/MIGRATION.md verbatim', () => {
    const clouds = new CloudsEffect()
    const ctx = new CloudsContext()
    const rows: Array<{
      key: string
      webgl: string
      webgpu: string
      status: string
    }> = []

    for (const entry of PARITY_KEYS) {
      const fullKey = entry.nested ? `${entry.nested}.${entry.key}` : entry.key
      const webgl = keyExistsOnTarget(
        clouds as unknown as Record<string, unknown>,
        entry
      )
      const webgpu = keyExistsOnTarget(
        ctx as unknown as Record<string, unknown>,
        entry
      )
      const status = webgl && webgpu ? 'ported' : webgl ? 'A-only' : 'B-only'
      rows.push({
        key: fullKey,
        webgl: String(webgl),
        webgpu: String(webgpu),
        status
      })
    }

    table('migration-final', rows)

    const markdown = renderMigrationTable(rows)
    const file = readFileSync(
      resolve(import.meta.dirname, '../../../docs/MIGRATION.md'),
      'utf8'
    )
    const match = file.match(
      /<!-- MIGRATION-TABLE:BEGIN -->\n([\s\S]*?)<!-- MIGRATION-TABLE:END -->/
    )
    expect(match, 'docs/MIGRATION.md table markers missing').not.toBeNull()
    expect(match?.[1]).toBe(`${markdown}\n`)

    clouds.dispose()
    ctx.dispose()
  })

  it('PARITY_KEYS has no duplicate entries', () => {
    const seen = new Set<string>()
    for (const entry of PARITY_KEYS) {
      const fullKey = entry.nested ? `${entry.nested}.${entry.key}` : entry.key
      expect(seen.has(fullKey), `duplicate: ${fullKey}`).toBe(false)
      seen.add(fullKey)
    }
  })

  it('all key types are valid', () => {
    const validTypes = new Set([
      'scalar',
      'boolean',
      'vector2',
      'vector3',
      'matrix4'
    ])
    for (const entry of PARITY_KEYS) {
      expect(
        validTypes.has(entry.type),
        `invalid type: ${entry.type} on ${entry.key}`
      ).toBe(true)
    }
  })
})

describe('caseToParityCase', () => {
  it('converts baseline-medium to a valid ParityCase', () => {
    const cd = caseByName('baseline-medium')!
    const pc = caseToParityCase(cd)
    expect(pc.name).toBe('baseline-medium')
    expect(pc.width).toBe(1280)
    expect(pc.height).toBe(720)
    expect(pc.pixelRatio).toBe(1)
    expect(pc.time).toBe(0)
    expect(pc.frame).toBe(0)
    expect(pc.warmup).toBe(64)
    expect(pc.sun).toEqual({ elevation: 45, azimuth: 180 })
    expect(pc.lighting).toBe('post')
  })

  it('camera callback sets position and lookAt', () => {
    const cd = caseByName('inside-deck')!
    const pc = caseToParityCase(cd)
    const cam = { position: { fromArray: vi.fn() }, lookAt: vi.fn() }
    pc.camera(cam as unknown as PerspectiveCamera)
    expect(cam.position.fromArray).toHaveBeenCalledWith(
      Array.from(cd.pose.position)
    )
    expect(cam.lookAt).toHaveBeenCalledWith(...cd.pose.lookAt)
  })

  it('maps CaseState to ParityKnobs', () => {
    const cd = caseByName('baseline-medium')!
    const pc = caseToParityCase(cd)
    expect(pc.knobs.enabled).toBe(true)
    expect(pc.knobs.haze).toBe(false)
    expect(pc.knobs.shadow).toBe(false)
    expect(pc.knobs.lightShafts).toBe(false)
    expect(pc.knobs.temporalUpscale).toBe(false)
    expect(pc.knobs.accuratePhaseFunction).toBe(false)
    expect(pc.knobs.debug).toBe('none')
    expect(pc.knobs.maxIterationCountToGround).toBe(0)
  })

  it('converts all Phase 0–1 cases without throwing', () => {
    const p01 = cases.filter(c => c.phase <= 1)
    expect(p01.length).toBeGreaterThan(0)
    for (const cd of p01) {
      expect(() => caseToParityCase(cd)).not.toThrow()
    }
  })

  // case 28's delta is the world→ECEF
  // frame, and both applyCase implementations install pc.worldToECEF
  it('builds worldToECEF from ecefRotationY', () => {
    const rows: Array<{ case: string; rotY: number; matches: boolean }> = []
    for (const cd of cases) {
      const pc = caseToParityCase(cd)
      const rotY = cd.ecefRotationY ?? 0
      const expected = new Matrix4().makeRotationY((rotY * Math.PI) / 180)
      const matches = pc.worldToECEF.elements.every(
        (v, i) => Math.abs(v - expected.elements[i]!) < 1e-12
      )
      expect(matches, `case "${cd.name}" worldToECEF mismatch`).toBe(true)
      if (rotY !== 0) rows.push({ case: cd.name, rotY, matches })
    }
    expect(rows.length).toBeGreaterThan(0)
    table('worldToECEF (rotated cases)', rows)
  })

  it('a Y rotation leaves an on-axis camera position in ECEF', () => {
    const cd = caseByName('ecef-rotated')!
    const pc = caseToParityCase(cd)
    const world = new Vector3().fromArray(Array.from(cd.pose.position))
    const ecef = world.clone().applyMatrix4(pc.worldToECEF)
    expect(ecef.x).toBe(0)
    expect(ecef.z).toBe(0)
    expect(ecef.y).toBe(world.y)
    table('ecef-rotated camera', [
      { world: world.toArray().join(','), ecef: ecef.toArray().join(',') }
    ])
  })
})

describe('buildCaseParityState', () => {
  it('returns correct preset-expanded state for baseline-medium', () => {
    const cd = caseByName('baseline-medium')!
    const ps = buildCaseParityState(cd)
    const preset = qualityPresets.medium
    expect(ps.coverage).toBe(BASE_STATE.coverage)
    expect(ps.clouds?.maxIterationCount).toBe(preset.clouds.maxIterationCount)
    expect(ps.clouds?.minStepSize).toBe(preset.clouds.minStepSize)
    expect(ps.shadow?.temporalJitter).toBe(preset.shadow.temporalJitter)
  })

  it('applies preset-low uniforms for preset-low case', () => {
    const cd = caseByName('preset-low')!
    const ps = buildCaseParityState(cd)
    const lowPreset = qualityPresets.low
    expect(ps.clouds?.maxIterationCount).toBe(
      lowPreset.clouds.maxIterationCount
    )
    expect(ps.clouds?.minStepSize).toBe(lowPreset.clouds.minStepSize)
    expect(ps.shapeDetail).toBe(false)
  })

  it('overrides coverage for coverage cases', () => {
    expect(buildCaseParityState(caseByName('coverage-020')!).coverage).toBe(0.2)
    expect(buildCaseParityState(caseByName('coverage-070')!).coverage).toBe(0.7)
    expect(buildCaseParityState(caseByName('coverage-090')!).coverage).toBe(0.9)
  })

  it('overrides multiScatteringOctaves for octaves cases', () => {
    const ps1 = buildCaseParityState(caseByName('octaves-1')!)
    const ps4 = buildCaseParityState(caseByName('octaves-4')!)
    const ps8 = buildCaseParityState(caseByName('octaves-8')!)
    expect(ps1.clouds?.multiScatteringOctaves).toBe(1)
    expect(ps4.clouds?.multiScatteringOctaves).toBe(4)
    expect(ps8.clouds?.multiScatteringOctaves).toBe(8)
  })

  it('sets resolutionScale for res cases', () => {
    expect(buildCaseParityState(caseByName('res-050')!).resolutionScale).toBe(
      0.5
    )
    expect(buildCaseParityState(caseByName('res-100')!).resolutionScale).toBe(1)
  })

  it('produces valid state for all Phase 0–1 cases', () => {
    const p01 = cases.filter(c => c.phase <= 1)
    for (const cd of p01) {
      const ps = buildCaseParityState(cd)
      expect(ps.clouds).toBeDefined()
      expect(ps.shadow).toBeDefined()
      expect(typeof ps.coverage).toBe('number')
      expect(typeof ps.resolutionScale).toBe('number')
    }
  })
})

// the reference renders its shadow map every update, the port's
// preset every 2nd frame, so side B is pinned to interval 1 per case load
// applyToB reads only the contexts, so the stub leaves the rest out
function stubSideB(ctx: CloudsContext): SideBHandle {
  return { cloudsContext: ctx, atmosphereContext: {} } as unknown as SideBHandle
}

describe('shadow.updateInterval pin on side B', () => {
  it('every case loads side B at interval 1, over the port default', () => {
    expect(qualityPresets.medium.shadow.updateInterval).not.toBe(1)
    expect(cases.length).toBeGreaterThan(0)
    const rows: Array<{ case: string; before: number; after: number }> = []
    for (const cd of cases) {
      const ctx = new CloudsContext()
      const before = ctx.shadow.updateInterval
      const sideB = stubSideB(ctx)
      applyToB(buildCaseParityState(cd), sideB)
      rows.push({ case: cd.name, before, after: ctx.shadow.updateInterval })
      expect(ctx.shadow.updateInterval, cd.name).toBe(1)
    }
    table('side B shadow.updateInterval after case load', rows)
  })

  it('a set() partial without the key leaves a deliberate interval alone', () => {
    const ctx = new CloudsContext()
    ctx.shadow.updateInterval = 3
    const sideB = stubSideB(ctx)
    applyToB({ shadow: { temporalPass: false } } as never, sideB)
    expect(ctx.shadow.updateInterval).toBe(3)
  })
})

// The harness merges preset data with pins through shorthand writes
// Those writes now forward to the graph setters, so re-applying is a no-op
const GRAPH_SHAPE_KEYS = [
  'multiScatteringOctaves',
  'accurateSunSkyLight',
  'accuratePhaseFunction'
] as const

type Bag = Record<string, unknown>

// One narrowing function instead of a double assertion per read site
function readField(target: object, key: string): unknown {
  return (target as Bag)[key]
}

// The same narrowing for the writable shorthand, where the key is assigned
function writableFields(target: object): Bag {
  return target as Bag
}

function show(value: unknown): string {
  return JSON.stringify(value ?? null)
}

// Module scope so the row literal is not nested inside four callbacks
function pinRow(
  caseName: string,
  key: string,
  pinned: unknown,
  contextDefault: unknown,
  afterApplyToB: unknown
): Record<string, unknown> {
  return {
    case: caseName,
    key,
    pinned: show(pinned),
    contextDefault: show(contextDefault),
    afterApplyToB: show(afterApplyToB)
  }
}

describe('graph-shape pins reach B through shorthand writes', () => {
  it('applyKeys forwards graph fields and an explicit re-apply is a no-op', () => {
    const fresh = new CloudsContext()
    const ctx = new CloudsContext()
    const pinned = buildCaseParityState(caseByName('octaves-1')!)
    const clouds = writableFields(ctx.clouds)
    for (const [k, v] of Object.entries(pinned.clouds ?? {})) {
      clouds[k] = v
    }
    const rows = GRAPH_SHAPE_KEYS.map(k => ({
      key: k,
      pinned: show(readField(pinned.clouds ?? {}, k)),
      shorthand: show(clouds[k]),
      graphField: show(readField(ctx, k)),
      contextDefault: show(readField(fresh, k))
    }))
    table('octaves-1, applyKeys only (no re-apply)', rows)

    expect(clouds['multiScatteringOctaves']).toBe(1)
    expect(ctx.multiScatteringOctaves).toBe(1)
    expect(ctx.graphVersion).toBeGreaterThan(fresh.graphVersion)
    const graphVersionAfterPins = ctx.graphVersion
    const graphFields = writableFields(ctx)
    for (const key of GRAPH_SHAPE_KEYS) {
      expect(ctx.graphFlags()[key]).toBe(clouds[key])
      graphFields[key] = clouds[key]
    }
    expect(ctx.graphVersion).toBe(graphVersionAfterPins)
    table('graph-shape re-apply is redundant', [
      { before: graphVersionAfterPins, after: ctx.graphVersion }
    ])
  })

  it('applyToB puts every pinned value on the field the graph reads', () => {
    const affected: string[] = []
    const rows: Array<Record<string, unknown>> = []
    const fresh = new CloudsContext()

    // One row per (case, key) whose pin differs from the default
    // Returned rather than pushed into, so the loops stay flat
    const rowsFor = (
      cd: (typeof cases)[number]
    ): Array<Record<string, unknown>> => {
      const ctx = new CloudsContext()
      const state = buildCaseParityState(cd)
      applyToB(state, stubSideB(ctx))
      const pinned = (state.clouds ?? {}) as Bag
      return GRAPH_SHAPE_KEYS.flatMap(k => {
        const want = readField(pinned, k)
        if (want === undefined) return []
        expect(readField(ctx, k), `${cd.name}.${k}`).toBe(want)
        const def = readField(fresh, k)
        if (show(want) === show(def)) return []
        return [pinRow(cd.name, k, want, def, readField(ctx, k))]
      })
    }

    for (const cd of cases) {
      for (const row of rowsFor(cd)) {
        rows.push(row)
        affected.push(`${String(row['case'])}.${String(row['key'])}`)
      }
    }
    table('graph-shape pins that differ from the context default', rows)

    // the guard is worthless if nothing is at stake, so assert the stake
    expect(affected.length).toBeGreaterThan(60)
    expect(affected).toContain('baseline-medium.accurateSunSkyLight')
    expect(affected).toContain('octaves-1.multiScatteringOctaves')
    expect(affected).toContain('draine-phase.accuratePhaseFunction')
  })

  it('the harness merges preset data with pins without assigning ctx.qualityPreset', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, 'parityState.ts'),
      'utf8'
    )
    for (const file of ['sideB.ts', 'main.ts']) {
      const text = readFileSync(resolve(import.meta.dirname, file), 'utf8')
      expect(text, file).not.toMatch(/\.qualityPreset\s*=/)
    }
    // the preset is read as DATA, never applied through the setter
    expect(src).toMatch(/qualityPresets\[eff\.qualityPreset\]/)
    expect(src).not.toMatch(/ctx\.qualityPreset\s*=/)
  })

  it('a preset applied AFTER a pin overwrites it: order is not safe', () => {
    // The task asked whether a pin beats a LATER preset. It does not: the
    // preset setter rewrites all three fields, so the pin is discarded
    const pinThenPreset = new CloudsContext()
    pinThenPreset.multiScatteringOctaves = 4
    pinThenPreset.qualityPreset = 'medium'
    const presetThenPin = new CloudsContext()
    presetThenPin.qualityPreset = 'medium'
    presetThenPin.multiScatteringOctaves = 4

    const rows = [
      {
        order: 'pin(4) then preset(medium)',
        result: String(pinThenPreset.multiScatteringOctaves),
        pinSurvives: pinThenPreset.multiScatteringOctaves === 4 ? 'yes' : 'NO'
      },
      {
        order: 'preset(medium) then pin(4)',
        result: String(presetThenPin.multiScatteringOctaves),
        pinSurvives: presetThenPin.multiScatteringOctaves === 4 ? 'yes' : 'NO'
      }
    ]
    table('qualityPreset vs explicit pin, both orders', rows)

    // the red the task was worried about is real, in this direction
    expect(pinThenPreset.multiScatteringOctaves).toBe(8)
    expect(presetThenPin.multiScatteringOctaves).toBe(4)
  })
})
