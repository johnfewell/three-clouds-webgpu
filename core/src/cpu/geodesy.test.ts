// Geodesy against takram's own functions. The altitude correction and the
// camera height are march uniforms, so they must match to the last bit

import { Vector3 } from 'three'

import { getAltitudeCorrectionOffset as takramAltitudeCorrection } from '@takram/three-atmosphere'
import {
  Ellipsoid as TakramEllipsoid,
  Geodetic as TakramGeodetic
} from '@takram/three-geospatial'

import { log } from '../../../test/helpers/log'
import {
  bitDiff,
  expectBitExact,
  seededRandom,
  vec3Array,
  vec3From
} from '../../test/twin'
import {
  Ellipsoid,
  geodeticHeight,
  geodeticToECEF,
  getAltitudeCorrectionOffset
} from './geodesy'
import { Vec3 } from './math'

const ER = 6378137
const rand = seededRandom(7)

// Ladder camera positions, then random directions at heights from deep inside
// the planet to geostationary
function positions(): Vector3[] {
  const ladder = [
    [0, ER + 60000, 0],
    [0, ER + 7900, 0],
    [0, ER + 12000, 0],
    [-1274794, 1081104, -6196721],
    [-3991973, 3385439, 3736223]
  ].map(p => new Vector3(...(p as [number, number, number])))
  const random = Array.from({ length: 200 }, () => {
    const dir = new Vector3(
      rand() - 0.5,
      rand() - 0.5,
      rand() - 0.5
    ).normalize()
    const height = [-6e6, -5e6, -1e4, -1, 0, 1, 500, 8000, 6e4, 4e7][
      Math.floor(rand() * 10)
    ]!
    return dir.multiplyScalar(ER + height)
  })
  return [...ladder, ...random]
}

describe('geodesy matches takram bit for bit', () => {
  const ellipsoid = Ellipsoid.WGS84
  const takram = TakramEllipsoid.WGS84

  it('WGS84 radii', () => {
    expectBitExact('radii', vec3Array(ellipsoid.radii), vec3Array(takram.radii))
  })

  it('surface projection, normal, height and altitude correction', () => {
    const rows: Record<string, unknown>[] = []
    for (const p of positions()) {
      const cp = vec3From(p)
      const projected = ellipsoid.projectOnSurface(cp)
      const expected = takram.projectOnSurface(p)
      const normal = ellipsoid.getSurfaceNormal(cp)
      const height = geodeticHeight(cp)
      const correction = getAltitudeCorrectionOffset(
        cp,
        6360000,
        ellipsoid,
        new Vec3()
      )
      const actual = [
        ...(projected != null ? vec3Array(projected) : []),
        ...vec3Array(normal),
        height ?? NaN,
        ...vec3Array(correction)
      ]
      const want = [
        ...(expected != null ? vec3Array(expected) : []),
        ...vec3Array(takram.getSurfaceNormal(p)),
        new TakramGeodetic().setFromECEF(p).height,
        ...vec3Array(
          takramAltitudeCorrection(p, 6360000, takram, new Vector3())
        )
      ]
      const d = bitDiff(actual, want)
      rows.push({ p: vec3Array(p), ...d })
      expect(d.mismatches).toBe(0)
    }
    log('geodesy-sweep', rows)
    expect(rows.length).toBe(205)
  })

  it('the centre projects to nothing, as takram throws there', () => {
    const centre = new Vec3()
    expect(ellipsoid.projectOnSurface(centre)).toBeUndefined()
    expect(geodeticHeight(centre)).toBeUndefined()
    expect(() => new TakramGeodetic().setFromECEF(new Vector3())).toThrow()
    expectBitExact(
      'centre-correction',
      vec3Array(
        getAltitudeCorrectionOffset(centre, 6360000, ellipsoid, new Vec3())
      ),
      vec3Array(
        takramAltitudeCorrection(new Vector3(), 6360000, takram, new Vector3())
      )
    )
  })

  it('geodetic to ECEF for observers', () => {
    for (let i = 0; i < 50; ++i) {
      const lon = (rand() * 2 - 1) * Math.PI
      const lat = (rand() - 0.5) * Math.PI
      const h = rand() * 9000 - 500
      expectBitExact(
        `toECEF-${i}`,
        vec3Array(geodeticToECEF(lon, lat, h)),
        vec3Array(new TakramGeodetic(lon, lat, h).toECEF())
      )
    }
  })
})
