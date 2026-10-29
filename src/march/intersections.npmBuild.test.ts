import { afterEach, describe, expect, it, vi } from 'vitest'

import { log } from '../../test/helpers/log'
import { assertR186Kernels } from './intersections'

// npm 0.9.1 and fork releases 1 to 4 have no forkBuild marker and mask only
// lanes .x and .y, so loading the march must refuse them
async function loadWithMarker(forkBuild: unknown): Promise<unknown> {
  vi.resetModules()
  vi.doMock('@takram/three-geospatial/webgpu', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    forkBuild
  }))
  return import('./intersections')
}

afterEach(() => {
  vi.doUnmock('@takram/three-geospatial/webgpu')
  vi.doUnmock('@takram/three-atmosphere/webgpu')
  vi.doUnmock('three')
  vi.resetModules()
})

describe('the march on a geospatial build without four masked lanes', () => {
  it('throws at load when the build has no marker', async () => {
    await expect(loadWithMarker(undefined)).rejects.toThrow(
      /fork build 0\.9\.1\+fork\.7/
    )
  })

  it('throws at load when the marker reports two lanes', async () => {
    await expect(
      loadWithMarker({ release: 4, raySpheresIntersectionsLanes: 2 })
    ).rejects.toThrow(/does not mask every lane of raySpheresIntersections/)
  })

  it('loads on the installed fork build', async () => {
    const geospatial = await import('@takram/three-geospatial/webgpu')
    const intersections = await import('./intersections')
    const actual = {
      forkBuild: JSON.stringify(
        (geospatial as Record<string, unknown>)['forkBuild']
      ),
      getIntersections: typeof intersections.getIntersections
    }
    log('installed-fork-marker', [actual])
    expect(actual).toEqual({
      forkBuild:
        '{"release":7,"raySpheresIntersectionsLanes":4,"r186Kernels":true}',
      getIntersections: 'function'
    })
  })
})

// Loads the march as three r186 would, with the atmosphere's marker replaced
async function loadOnR186(atmosphereMarker: unknown): Promise<unknown> {
  vi.resetModules()
  vi.doMock('three', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    REVISION: '186'
  }))
  vi.doMock('@takram/three-atmosphere/webgpu', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    forkBuild: atmosphereMarker
  }))
  return import('./intersections')
}

describe('the r186 kernel markers', () => {
  const geo7 = {
    release: 7,
    raySpheresIntersectionsLanes: 4,
    r186Kernels: true
  }
  const atm7 = { release: 7, r186Kernels: true }
  const geo5 = { release: 5, raySpheresIntersectionsLanes: 4 }

  it('require both packages to declare r186Kernels from one release, on r186 only', () => {
    const cases: Array<[string, string, unknown, unknown, boolean]> = [
      ['release 7 on r186', '186', atm7, geo7, false],
      ['186dev counts as r186', '186dev', atm7, geo7, false],
      ['atmosphere marker missing', '186', undefined, geo7, true],
      ['186dev, atmosphere marker missing', '186dev', undefined, geo7, true],
      ['geospatial without r186Kernels', '186', atm7, geo5, true],
      ['releases differ', '186', atm7, { ...geo7, release: 8 }, true],
      ['r185, atmosphere marker missing', '185', undefined, geo5, false],
      ['r184, no markers', '184', undefined, undefined, false]
    ]
    const rows = cases.map(([label, revision, atm, geo, expected]) => {
      let error = ''
      try {
        assertR186Kernels(atm, geo, revision)
      } catch (e) {
        error = (e as Error).message
      }
      return { label, revision, throws: error !== '', expected }
    })
    log('r186-kernel-markers', rows)
    expect(rows.map(r => r.throws)).toEqual(rows.map(r => r.expected))
  })

  it('names the package whose marker is missing', () => {
    expect(() => assertR186Kernels(undefined, geo7, '186')).toThrow(
      /@takram\/three-atmosphere has no forkBuild marker\. Install both fork builds from one release, 0\.19\.1\+fork\.7 \/ 0\.9\.1\+fork\.7/
    )
    expect(() => assertR186Kernels(atm7, geo5, '186')).toThrow(
      /^On three r186 .*: @takram\/three-geospatial is fork release 5 without r186Kernels\./
    )
  })

  it('names both packages and both releases on a mixed install', () => {
    expect(() =>
      assertR186Kernels(atm7, { ...geo7, release: 8 }, '186')
    ).toThrow(
      '@takram/three-atmosphere is fork release 7 and @takram/three-geospatial is fork release 8'
    )
  })

  it('refuses at load on r186 when the atmosphere build has no marker', async () => {
    await expect(loadOnR186(undefined)).rejects.toThrow(
      /@takram\/three-atmosphere has no forkBuild marker/
    )
  })

  it('loads on r186 with the installed release 7 builds', async () => {
    const atmosphere = await import('@takram/three-atmosphere/webgpu')
    const actual = {
      atmosphere: JSON.stringify(
        (atmosphere as Record<string, unknown>)['forkBuild']
      ),
      loads: typeof (
        (await loadOnR186(
          (atmosphere as Record<string, unknown>)['forkBuild']
        )) as { getIntersections: unknown }
      ).getIntersections
    }
    log('installed-atmosphere-marker', [actual])
    expect(actual).toEqual({
      atmosphere: '{"release":7,"r186Kernels":true}',
      loads: 'function'
    })
  })
})
