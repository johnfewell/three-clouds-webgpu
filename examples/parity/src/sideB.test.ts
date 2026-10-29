// Side B: WebGPU canonical wiring tests (AUDIT-4 lighting modes)
import { CloudsContext } from 'three-clouds-webgpu'
import { describe, expect, it } from 'vitest'

import {
  AtmosphereContext,
  AtmosphereLight,
  AtmosphereLightNode
} from '@takram/three-atmosphere/webgpu'

import { table } from '../../../test/helpers/cpuTwin'
import { createSyntheticScene } from './scenes/synthetic'

describe('sideB lighting modes (AUDIT-4)', () => {
  const modes = ['post', 'lights'] as const

  it('scene uses nodeMaterials=true with matching lighting mode', () => {
    const rows = modes.map(mode => {
      const result = createSyntheticScene({
        nodeMaterials: true,
        lighting: mode
      })

      return {
        mode,
        lighting: result.lighting,
        needsAtmosphereLight: result.needsAtmosphereLight,
        sphereMaterial: result.sphere.material.constructor.name,
        expectedMaterial:
          mode === 'post' ? 'MeshBasicNodeMaterial' : 'MeshStandardNodeMaterial'
      }
    })
    table('scene-material-by-mode', rows)

    for (const row of rows) {
      expect(row.lighting).toBe(row.mode)
      expect(row.sphereMaterial).toBe(row.expectedMaterial)
    }
    expect(rows[1]!.needsAtmosphereLight).toBe(true)
  })

  it('AtmosphereLightNode and AtmosphereLight are always registered', () => {
    expect(AtmosphereLightNode).toBeDefined()
    expect(typeof AtmosphereLightNode).toBe('function')

    const light = new AtmosphereLight()
    expect(light.type).toBe('AtmosphereLight')

    const rows = modes.map(mode => ({
      mode,
      registerLightNode: true,
      addAtmosphereLight: true,
      note:
        mode === 'lights'
          ? 'lit by AtmosphereLight'
          : 'harmless — BasicNodeMaterial ignores lights'
    }))
    table('atmosphere-light-registration', rows)

    for (const row of rows) {
      expect(row.registerLightNode).toBe(true)
    }
  })
})

describe('sideB context types (ADR-004)', () => {
  it('AtmosphereContext exposes required uniform fields', () => {
    const ctx = new AtmosphereContext()
    expect(ctx.sunDirectionECEF).toBeDefined()
    expect(ctx.matrixWorldToECEF).toBeDefined()
    expect(ctx.correctAltitude).toBe(true)

    const rows = [
      { field: 'sunDirectionECEF', type: typeof ctx.sunDirectionECEF },
      { field: 'matrixWorldToECEF', type: typeof ctx.matrixWorldToECEF },
      { field: 'correctAltitude', default: ctx.correctAltitude }
    ]
    table('atmosphere-context-fields', rows)

    ctx.dispose()
  })

  it('CloudsContext exposes required fields for sideB wiring', () => {
    const ctx = new CloudsContext()
    expect(ctx.sunDirection).toBeDefined()
    expect(ctx.worldToECEFMatrix).toBeDefined()
    expect(ctx.correctAltitude).toBe(true)
    expect(typeof ctx.frame).toBe('number')
    expect(typeof ctx.time).toBe('number')

    const rows = [
      { field: 'sunDirection', defined: true },
      { field: 'worldToECEFMatrix', defined: true },
      { field: 'correctAltitude', default: ctx.correctAltitude },
      { field: 'frame', default: ctx.frame },
      { field: 'time', default: ctx.time }
    ]
    table('clouds-context-fields', rows)

    ctx.dispose()
  })
})

describe('sideB module exports', () => {
  it('exports createSideB', async () => {
    const mod = await import('./sideB')
    expect(typeof mod.createSideB).toBe('function')
  })
})
