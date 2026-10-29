import { describe, expect, it } from 'vitest'

import { Geodetic } from '@takram/three-geospatial'

import { createParityCamera } from '../src/parityCamera'
import { ANCHOR_LAT, ANCHOR_LON, SPHERE_HEIGHT } from '../src/scenes/synthetic'
import {
  BASE_STATE,
  caseByName,
  cases,
  casesByNumber,
  effectiveState,
  PARITY_KEYS_PHASE,
  type CaseDefinition,
  type CaseState
} from './index'

function logTable(label: string, rows: Record<string, string | number>[]) {
  console.log(`\n[cases] ${label}`)
  if (rows.length === 0) return
  const keys = Object.keys(rows[0]!)
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k]).length))
  )
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join(' | ')
  console.log(header)
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'))
  for (const row of rows) {
    console.log(
      keys.map((k, i) => String(row[k]).padEnd(widths[i]!)).join(' | ')
    )
  }
}

describe('case registry numbering', () => {
  // 58 = 55 + the grazing-sun pair + shafts-inside-deck's twin
  //, 59 = shadow-sphere's twin, 61 = the sky-horizon pair (3l31)
  // Retired numbers are listed, never renumbered: results are keyed by number
  const RETIRED = new Map<number, string>([
    [53, 'ortho-camera — the ray construction is perspective-only']
  ])

  it('numbers span 1–61 with no gaps except the retired ones', () => {
    const nums = new Set(cases.map(c => c.number))
    for (let n = 1; n <= 61; n++) {
      if (RETIRED.has(n)) {
        expect(
          nums.has(n),
          `case ${n} is retired (${RETIRED.get(n)!}) and must not be in the registry`
        ).toBe(false)
        continue
      }
      expect(nums.has(n), `missing case number ${n}`).toBe(true)
    }
    for (const n of nums) {
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(61)
    }
    logTable('number coverage', [{ min: 1, max: 61, unique: nums.size }])
  })

  it('names are unique', () => {
    const names = cases.map(c => c.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
    logTable('name uniqueness', [
      { total: names.length, unique: unique.size, duplicates: 0 }
    ])
  })

  it('variant groups share a number and each entry has a variant field', () => {
    const byNumber = new Map<number, CaseDefinition[]>()
    for (const c of cases) {
      const arr = byNumber.get(c.number) ?? []
      arr.push(c)
      byNumber.set(c.number, arr)
    }

    const variantGroups: { number: number; names: string }[] = []
    for (const [num, group] of byNumber) {
      if (group.length > 1) {
        for (const c of group) {
          expect(
            c.variant,
            `case "${c.name}" (#${num}) is in a variant group but has no variant field`
          ).toBeDefined()
        }
        variantGroups.push({
          number: num,
          names: group.map(c => c.name).join(', ')
        })
      }
    }

    expect(variantGroups.length).toBeGreaterThan(0)
    logTable(
      'variant groups',
      variantGroups.map(g => ({
        number: g.number,
        variants: g.names
      }))
    )
  })

  it('non-variant cases omit the variant field', () => {
    const byNumber = new Map<number, CaseDefinition[]>()
    for (const c of cases) {
      const arr = byNumber.get(c.number) ?? []
      arr.push(c)
      byNumber.set(c.number, arr)
    }
    for (const [, group] of byNumber) {
      if (group.length === 1) {
        expect(group[0]!.variant).toBeUndefined()
      }
    }
  })
})

describe('schema validity', () => {
  it('every case has required fields with valid types', () => {
    for (const c of cases) {
      expect(typeof c.name).toBe('string')
      expect(c.name.length).toBeGreaterThan(0)
      expect(typeof c.number).toBe('number')
      expect([0, 1, 2, 3, 4]).toContain(c.phase)
      expect(c.pose.position).toHaveLength(3)
      expect(c.pose.lookAt).toHaveLength(3)
      expect(typeof c.sun.elevation).toBe('number')
      expect(typeof c.sun.azimuth).toBe('number')
      expect(typeof c.time).toBe('number')
      expect(typeof c.frame).toBe('number')
      expect(typeof c.warmup).toBe('number')
      expect(c.warmup).toBeGreaterThan(0)
      expect(['synthetic', 'world']).toContain(c.scene)
    }
  })

  it('state deltas only contain valid CaseState keys', () => {
    const validKeys = new Set(Object.keys(BASE_STATE))
    for (const c of cases) {
      for (const key of Object.keys(c.state)) {
        expect(
          validKeys.has(key),
          `case "${c.name}" has invalid state key "${key}"`
        ).toBe(true)
      }
    }
  })

  it('effectiveState produces a complete CaseState for every case', () => {
    const allKeys = Object.keys(BASE_STATE) as (keyof CaseState)[]
    for (const c of cases) {
      const eff = effectiveState(c)
      for (const k of allKeys) {
        expect(
          eff[k],
          `case "${c.name}" missing key "${k}" in effective state`
        ).toBeDefined()
      }
    }
  })
})

describe('phase constraints (ADR-011 frozen-feature neutralisation)', () => {
  it('a phase-N case does not change keys of phase > N from BASE_STATE', () => {
    const violations: {
      case_: string
      key: string
      phase: number
      casePhase: number
    }[] = []

    for (const c of cases) {
      const eff = effectiveState(c)
      for (const [key, keyPhase] of Object.entries(PARITY_KEYS_PHASE)) {
        if (keyPhase > c.phase) {
          const k = key as keyof CaseState
          if (eff[k] !== BASE_STATE[k]) {
            violations.push({
              case_: c.name,
              key,
              phase: keyPhase,
              casePhase: c.phase
            })
          }
        }
      }
    }

    if (violations.length > 0) {
      logTable(
        'phase violations',
        violations.map(v => ({
          case: v.case_,
          key: v.key,
          keyPhase: v.phase,
          casePhase: v.casePhase
        }))
      )
    }
    expect(violations).toHaveLength(0)
  })

  it('BASE_STATE covers every PARITY_KEYS_PHASE key', () => {
    for (const key of Object.keys(PARITY_KEYS_PHASE)) {
      expect(
        key in BASE_STATE,
        `PARITY_KEYS_PHASE has "${key}" but BASE_STATE does not`
      ).toBe(true)
    }
  })
})

describe('consumer-policy pairs', () => {
  it('cases 38 and 40 differ only by the light-shafts altitude policy', () => {
    const shaftsOn = caseByName('shafts-low-sun')!
    const shaftsOff = caseByName('shafts-orbit-off')!
    const {
      name: _onName,
      number: _onNumber,
      state: _onDelta,
      ...onSetup
    } = shaftsOn
    const {
      name: _offName,
      number: _offNumber,
      state: _offDelta,
      ...offSetup
    } = shaftsOff
    const { lightShafts: onLightShafts, ...onState } = effectiveState(shaftsOn)
    const { lightShafts: offLightShafts, ...offState } =
      effectiveState(shaftsOff)

    expect([shaftsOn.number, shaftsOff.number]).toEqual([38, 40])
    expect(offSetup).toEqual(onSetup)
    expect(offState).toEqual(onState)
    expect(onLightShafts).toBe(true)
    expect(offLightShafts).toBe(false)

    logTable('cases 38/40 consumer-policy pair', [
      {
        case: shaftsOn.name,
        number: shaftsOn.number,
        lightShafts: String(onLightShafts)
      },
      {
        case: shaftsOff.name,
        number: shaftsOff.number,
        lightShafts: String(offLightShafts)
      }
    ])
  })
})

describe('ECEF frame axis (case 28, no clouds)', () => {
  it('case 28 is identity vs a rotated frame, not correctAltitude', () => {
    const group = casesByNumber(28)
    expect(group.map(c => c.name).sort()).toEqual([
      'ecef-identity',
      'ecef-rotated'
    ])

    const identity = caseByName('ecef-identity')!
    const rotated = caseByName('ecef-rotated')!
    expect(identity.ecefRotationY ?? 0).toBe(0)
    expect(rotated.ecefRotationY).toBeDefined()
    expect(Math.abs(rotated.ecefRotationY!)).toBeGreaterThan(0)

    // Everything but the frame is shared, so a diff between the two variants
    // is the frame transform and nothing else
    expect(rotated.pose).toBe(identity.pose)
    expect(rotated.sun).toEqual(identity.sun)
    expect(effectiveState(rotated)).toEqual(effectiveState(identity))

    logTable('case 28 variants', [
      { name: identity.name, ecefRotationY: identity.ecefRotationY ?? 0 },
      { name: rotated.name, ecefRotationY: rotated.ecefRotationY! }
    ])
  })

  // With `correctAltitude` OFF the deck sits at bottomRadius + altitude, above
  // the WGS84 ground only poleward of MIN_UNCORRECTED_LAT (7tk, case 55: ws3)
  // src/CloudsContext.ts:208
  const BOTTOM_RADIUS = 6360000
  // src/CloudLayers.ts:37 (DEFAULT layer 0)
  const LAYER_ALTITUDE = 750
  const WGS84_A = 6378137
  const WGS84_B = 6356752.314245179
  const MIN_UNCORRECTED_LAT = 64.476

  // Geocentric radius of the WGS84 surface directly under a geocentric latitude
  function surfaceRadiusAt(latDeg: number): number {
    const t = (latDeg * Math.PI) / 180
    const c = Math.cos(t)
    const s = Math.sin(t)
    return (WGS84_A * WGS84_B) / Math.hypot(WGS84_B * c, WGS84_A * s)
  }

  function geocentricLatDeg(pose: CaseDefinition['pose']): number {
    const [x, y, z] = pose.position
    return (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI
  }

  it('no EQUATORIAL case turns correctAltitude off', () => {
    const off = cases.filter(c => !effectiveState(c).correctAltitude)
    for (const c of off) {
      const lat = geocentricLatDeg(c.pose)
      expect(
        Math.abs(lat),
        `case "${c.name}" sets correctAltitude=false at latitude ` +
          `${lat.toFixed(3)}°, where the uncorrected deck is ` +
          `${(BOTTOM_RADIUS + LAYER_ALTITUDE - surfaceRadiusAt(lat)).toFixed(1)} m ` +
          'relative to the ground mesh — it must be poleward of ' +
          `${MIN_UNCORRECTED_LAT}° or neither side marches`
      ).toBeGreaterThan(MIN_UNCORRECTED_LAT)
    }
    // Every other case must leave the flag at its BASE_STATE value
    for (const c of cases) {
      if (off.includes(c)) continue
      expect(
        effectiveState(c).correctAltitude,
        `case "${c.name}" must not change correctAltitude`
      ).toBe(BASE_STATE.correctAltitude)
    }
    logTable(
      'correctAltitude=false cases',
      off.map(c => ({
        name: c.name,
        lat: geocentricLatDeg(c.pose).toFixed(3),
        deckAGL: (
          BOTTOM_RADIUS +
          LAYER_ALTITUDE -
          surfaceRadiusAt(geocentricLatDeg(c.pose))
        ).toFixed(1)
      }))
    )
  })

  it('case 55 isolates correctAltitude and both variants clear the ground', () => {
    const group = casesByNumber(55)
    expect(group.map(c => c.name).sort()).toEqual([
      'polar-altitude-corrected',
      'polar-altitude-uncorrected'
    ])

    const on = caseByName('polar-altitude-corrected')!
    const off = caseByName('polar-altitude-uncorrected')!
    expect(effectiveState(on).correctAltitude).toBe(true)
    expect(effectiveState(off).correctAltitude).toBe(false)

    // Everything but the flag is shared, so a diff between the two variants is
    // the altitude correction and nothing else
    expect(off.pose).toBe(on.pose)
    expect(off.sun).toEqual(on.sun)
    expect(off.phase).toBe(on.phase)
    expect({ ...effectiveState(off), correctAltitude: true }).toEqual(
      effectiveState(on)
    )

    // The uncorrected deck must sit ABOVE the ground mesh, or the case is the
    // same dead end it replaced
    const lat = geocentricLatDeg(on.pose)
    const deckAGL = BOTTOM_RADIUS + LAYER_ALTITUDE - surfaceRadiusAt(lat)
    expect(Math.abs(lat)).toBeGreaterThan(MIN_UNCORRECTED_LAT)
    expect(deckAGL).toBeGreaterThan(0)

    logTable('case 55 (correctAltitude axis)', [
      { name: on.name, correctAltitude: 'true', deckAGL: '750.0 (geodetic)' },
      { name: off.name, correctAltitude: 'false', deckAGL: deckAGL.toFixed(1) }
    ])
  })

  // The rotation axis is ECEF Y and the ladder's poses lie on +Y, so a rotated
  // case leaves the camera's ECEF position (and so the altitude correction
  // and the distance to the ground) untouched
  it('a rotated case poses the camera on the rotation axis', () => {
    for (const c of cases) {
      if ((c.ecefRotationY ?? 0) === 0) continue
      for (const p of [c.pose.position, c.pose.lookAt]) {
        expect(
          p[0] === 0 && p[2] === 0,
          `case "${c.name}" sets ecefRotationY but its pose ${JSON.stringify(p)} is off the Y axis`
        ).toBe(true)
      }
    }
  })
})

describe('lighting constraint (AUDIT-4)', () => {
  function receiverNdc(pose: CaseDefinition['pose']): [number, number, number] {
    const camera = createParityCamera('perspective')
    camera.position.fromArray(pose.position)
    camera.lookAt(...pose.lookAt)
    camera.updateMatrixWorld(true)
    const receiver = new Geodetic(
      (ANCHOR_LON * Math.PI) / 180,
      (ANCHOR_LAT * Math.PI) / 180,
      SPHERE_HEIGHT
    ).toECEF()
    return receiver.project(camera).toArray()
  }

  it('only case 35 (shadow-sphere) uses lighting "lights"', () => {
    const lightsCase = cases.filter(c => c.lighting === 'lights')
    expect(lightsCase).toHaveLength(1)
    expect(lightsCase[0]!.name).toBe('shadow-sphere')
    expect(lightsCase[0]!.number).toBe(35)
  })

  it('only the lights case declares a b-only shaded-fraction receipt', () => {
    // ADR-011 Amendment 13: b-only is the lights path, where side A has no
    // shadow consumer. Any other case dividing the two fractions is the defect
    const bOnly = cases.filter(
      c => c.shadedFractionReceipt?.compare === 'b-only'
    )
    expect(bOnly.map(c => c.name)).toEqual(['shadow-sphere'])
  })

  it('case 35 keeps its light-reactive receiver inside the frustum', () => {
    const legacyNdc = receiverNdc({
      position: [0, 6378137 + 60000, 0],
      lookAt: [0, 6378137 - 20000, 0]
    })
    expect(Math.abs(legacyNdc[0])).toBeGreaterThan(1)
    expect(Math.abs(legacyNdc[1])).toBeGreaterThan(1)

    const currentNdc = receiverNdc(caseByName('shadow-sphere')!.pose)
    expect(Math.abs(currentNdc[0])).toBeLessThan(1)
    expect(Math.abs(currentNdc[1])).toBeLessThan(1)
    expect(currentNdc[2]).toBeGreaterThanOrEqual(-1)
    expect(currentNdc[2]).toBeLessThanOrEqual(1)
    logTable('case 35 receiver projection', [
      {
        pose: 'legacy',
        x: legacyNdc[0].toFixed(3),
        y: legacyNdc[1].toFixed(3)
      },
      {
        pose: 'current',
        x: currentNdc[0].toFixed(3),
        y: currentNdc[1].toFixed(3)
      }
    ])
  })

  it('all other cases omit lighting or use "post"', () => {
    for (const c of cases) {
      if (c.name === 'shadow-sphere') continue
      expect(
        c.lighting === undefined || c.lighting === 'post',
        `case "${c.name}" has lighting="${c.lighting}" but should be "post" or omitted`
      ).toBe(true)
    }
  })
})

describe('helpers', () => {
  it('caseByName finds baseline-medium', () => {
    const c = caseByName('baseline-medium')
    expect(c).toBeDefined()
    expect(c!.number).toBe(1)
    expect(c!.phase).toBe(0)
  })

  it('casesByNumber returns variant groups', () => {
    const group19 = casesByNumber(19)
    expect(group19.length).toBe(2)
    expect(group19.map(c => c.name).sort()).toEqual(['res-050', 'res-100'])
  })
})

describe('summary table', () => {
  it('logs the full ladder', () => {
    logTable(
      'parity ladder',
      cases.map(c => ({
        '#': c.number,
        name: c.name,
        phase: c.phase,
        scene: c.scene,
        variant: c.variant ?? '',
        seq: c.sequence ? `${c.sequence.frames}f` : '',
        look: c.lookOnly ? 'yes' : ''
      }))
    )
  })

  it('logs phase distribution', () => {
    const dist = [0, 1, 2, 3, 4].map(p => ({
      phase: p,
      count: cases.filter(c => c.phase === p).length
    }))
    logTable('phase distribution', dist)
  })
})

// ADR-013 Amendment 6, Decision 3: side B reads the LUT on every case except
// one declaring a standing exception. The register holds what the ladder
// showed to need it, and adding one needs a further amendment
describe('atmosphere exception register (ADR-013 A6)', () => {
  it('holds only below-deck-1km, with its mode and measured reason', () => {
    const entries = cases.filter(c => c.atmosphereException != null)
    logTable(
      'atmosphere exceptions',
      entries.map(c => ({
        case: c.name,
        mode: c.atmosphereException!.mode,
        reason: c.atmosphereException!.reason.slice(0, 60)
      }))
    )
    expect(entries.map(c => c.name)).toEqual(['below-deck-1km'])
    const exception = caseByName('below-deck-1km')!.atmosphereException!
    expect(exception.mode).toBe('raymarch-256')
    expect(exception.reason).toMatch(/ADR-013 Amendment 6/)
    expect(exception.reason).toMatch(/0\.1001/)
  })
})
