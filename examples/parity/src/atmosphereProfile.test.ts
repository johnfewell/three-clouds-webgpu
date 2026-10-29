import { Material } from 'three'
import { NodeFrame } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

import { log } from '../../../test/helpers/log'
import {
  atmosphereProfileModes,
  configureAtmosphereProfile,
  effectiveAtmosphereProfile,
  profileRaymarches
} from './atmosphereProfile'
import { parseHarnessParams } from './routing'

describe('diagnostic atmosphere integration modes', () => {
  it('keeps default routing unchanged and refuses accidental capture overrides', () => {
    expect(parseHarnessParams('').atmosphereProfile).toBe('reference')
    for (const mode of atmosphereProfileModes.slice(1)) {
      expect(
        parseHarnessParams(`?e2e=1&atmosphereProfile=${mode}`).atmosphereProfile
      ).toBe(mode)
      expect(() => parseHarnessParams(`?atmosphereProfile=${mode}`)).toThrow(
        /require/
      )
      expect(() =>
        parseHarnessParams(`?e2e=1&capture=1&atmosphereProfile=${mode}`)
      ).toThrow(/require/)
    }
    expect(() => parseHarnessParams('?e2e=1&atmosphereProfile=typo')).toThrow(
      /Unknown/
    )
  })

  // ADR-013 Amendment 6: 'reference' (the default) and 'lookup-both' read the
  // LUT and keep the library's (4, 14) samples, the raymarch profiles set their
  // own. Each starts from a fresh library-default context.
  const LIBRARY: [number, number] = [4, 14]
  it.each([
    ['reference', false, LIBRARY, LIBRARY],
    ['raymarch-256', true, [256, 256], [256, 256]],
    ['samples-scene-64', true, [256, 256], [64, 64]],
    ['samples-clouds-64', true, [64, 64], [256, 256]],
    ['lookup-both', false, LIBRARY, LIBRARY]
  ] as const)(
    '%s separates consumers without creating another LUT',
    (mode, raymarch, clouds, scene) => {
      const original = new AtmosphereContext()
      expect(original.scatteringSampleCount.value.toArray()).toEqual(LIBRARY)
      const lut = original.lutNode
      configureAtmosphereProfile(original, mode)
      expect(original.raymarchScattering).toBe(raymarch)
      expect(profileRaymarches(mode)).toBe(raymarch)
      expect(original.lutNode).toBe(lut)
      const frame = new NodeFrame()
      frame.material = new Material()
      for (const [name, count] of [
        ['CloudsPass', clouds],
        ['RenderPipeline', scene],
        ['Unrelated', raymarch ? [256, 256] : LIBRARY]
      ] as const) {
        frame.material.name = name
        if (mode.startsWith('samples-'))
          original.scatteringSampleCount.update(frame)
        expect(original.scatteringSampleCount.value.toArray()).toEqual(count)
      }
      log('consumer modes', {
        mode,
        raymarch,
        clouds: clouds.join(','),
        scene: scene.join(','),
        sharedLut: original.lutNode === lut
      })
      frame.material.dispose()
      original.dispose()
    }
  )

  // ADR-011 frozen-feature neutralisation: the shadowed-scattering method is a
  // graph-time choice, so every profile pins it and no case inherits the
  // library default
  it('pins the single-branch shadow scattering the reference resolves with', () => {
    const atmosphere = new AtmosphereContext()
    const libraryDefault = atmosphere.accurateShadowScattering
    const rows = atmosphereProfileModes.map(mode => {
      configureAtmosphereProfile(atmosphere, mode)
      return { mode, accurate: atmosphere.accurateShadowScattering }
    })
    log('accurateShadowScattering', {
      libraryDefault,
      pinned: rows.map(row => `${row.mode}=${row.accurate}`).join(' ')
    })
    expect(libraryDefault).toBe(true)
    for (const row of rows) expect(row.accurate).toBe(false)
    atmosphere.dispose()
  })

  // ADR-013 A6, Decision 3: the URL's diagnostic profile wins, then the case's
  // registered exception, then the default lookup
  it('resolves URL profile, then case exception, then the lookup', () => {
    const exception = { mode: 'raymarch-256' as const }
    const rows = [
      ['reference', undefined, 'reference'],
      ['reference', exception, 'raymarch-256'],
      ['lookup-both', exception, 'lookup-both'],
      ['raymarch-256', undefined, 'raymarch-256'],
      ['samples-scene-64', exception, 'samples-scene-64']
    ] as const
    for (const [url, caseException, expected] of rows)
      expect(effectiveAtmosphereProfile(url, caseException)).toBe(expected)
    log('effective profile', {
      rows: rows.map(([u, c, e]) => `${u}+${c?.mode ?? '-'}=>${e}`).join(' ')
    })
  })
})
