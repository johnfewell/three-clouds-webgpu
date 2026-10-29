// Sun and moon directions against takram's, and the moonlight retarget against
// the port's moonlightCPU. The sun direction is a march uniform and the input
// to cascade fitting, so it must match to the bit

import { Vector3 } from 'three'

import {
  getECIToECEFRotationMatrix as takramECIToECEF,
  getMoonDirectionECEF as takramMoon,
  getSunDirectionECEF as takramSun
} from '@takram/three-atmosphere'
import { Geodetic } from '@takram/three-geospatial'

import { moonlightCPU } from '../../../src/experimental/moonlight'
import { log } from '../../../test/helpers/log'
import {
  bitDiff,
  expectBitExact,
  seededRandom,
  vec3Array,
  vec3From
} from '../../test/twin'
import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECEF,
  getSunDirectionECEF,
  moonlight
} from './celestial'
import { geodeticToECEF } from './geodesy'
import { Vec3 } from './math'

const rand = seededRandom(11)
const DEG = Math.PI / 180

const DATES = [
  new Date('2026-10-04T12:00:00Z'),
  new Date('2026-10-04T21:30:00Z'),
  new Date('2026-03-20T06:15:00Z'),
  new Date('2000-01-01T12:00:00Z'),
  Date.UTC(2031, 6, 15, 3, 7, 11)
]

describe('celestial directions match takram bit for bit', () => {
  it('the ECI to ECEF rotation', () => {
    for (const date of DATES) {
      expectBitExact(
        `eci-ecef-${String(date)}`,
        getECIToECEFRotationMatrix(date).elements,
        takramECIToECEF(date).elements
      )
    }
  })

  it('sun and moon, geocentric and from observers', () => {
    const rows: Record<string, unknown>[] = []
    const observers: (readonly [number, number, number] | null)[] = [
      null,
      [0, 45, 0],
      [139.7, 35.7, 40],
      [-74, 40.7, 10],
      [12, -75, 2500]
    ]
    for (const date of DATES) {
      for (const o of observers) {
        const takramObserver =
          o == null
            ? undefined
            : new Geodetic(o[0] * DEG, o[1] * DEG, o[2]).toECEF()
        const coreObserver =
          o == null ? undefined : geodeticToECEF(o[0] * DEG, o[1] * DEG, o[2])
        const d = bitDiff(
          [
            ...vec3Array(getSunDirectionECEF(date, new Vec3(), coreObserver)),
            ...vec3Array(getMoonDirectionECEF(date, new Vec3(), coreObserver))
          ],
          [
            ...vec3Array(takramSun(date, new Vector3(), takramObserver)),
            ...vec3Array(takramMoon(date, new Vector3(), takramObserver))
          ]
        )
        rows.push({ date: String(date), observer: o, ...d })
        expect(d.mismatches).toBe(0)
      }
    }
    log('celestial-sweep', rows)
    expect(rows).toHaveLength(DATES.length * observers.length)
  })
})

describe('moonlight matches the port bit for bit', () => {
  it('twilight sweep, with and without a moon, gain on and off', () => {
    const rows: Record<string, unknown>[] = []
    const camera = new Vector3(0, 6378137 + 60000, 0)
    for (let i = 0; i < 200; ++i) {
      // Elevations from well above to well below the horizon at this camera
      const elevation = (rand() * 30 - 15) * DEG
      const azimuth = rand() * 2 * Math.PI
      const sun = new Vector3(
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth)
      )
      const moon =
        i % 5 === 0
          ? new Vector3()
          : new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize()
      const gain = i % 3 === 0 ? 0 : rand() * 4
      const color = new Vector3(0.8, 0.9, 1.1)
      const portOut = {
        lightDirection: new Vector3(),
        irradianceRatio: new Vector3()
      }
      const portMeta = moonlightCPU(sun, moon, camera, gain, color, portOut)
      const coreOut = {
        lightDirection: new Vec3(),
        irradianceRatio: new Vec3()
      }
      const coreMeta = moonlight(
        vec3From(sun),
        vec3From(moon),
        vec3From(camera),
        gain,
        vec3From(color),
        coreOut
      )
      const d = bitDiff(
        [
          ...vec3Array(coreOut.lightDirection),
          ...vec3Array(coreOut.irradianceRatio),
          coreMeta.blend,
          coreMeta.illuminated
        ],
        [
          ...vec3Array(portOut.lightDirection),
          ...vec3Array(portOut.irradianceRatio),
          portMeta.blend,
          portMeta.illuminated
        ]
      )
      rows.push({
        elevationDeg: elevation / DEG,
        gain,
        blend: portMeta.blend,
        ...d
      })
      expect(d.mismatches).toBe(0)
    }
    log('moonlight-sweep', rows)
    // The sweep must reach the twilight band, or it only tested the sun path
    expect(
      rows.some(r => (r.blend as number) > 0 && (r.blend as number) < 1)
    ).toBe(true)
    expect(rows.some(r => r.blend === 1)).toBe(true)
  })

  it('a zero sun and a camera at the centre', () => {
    for (const [sun, camera] of [
      [new Vector3(), new Vector3(1, 2, 3)],
      [new Vector3(0, 1, 0), new Vector3()]
    ] as const) {
      const portOut = {
        lightDirection: new Vector3(),
        irradianceRatio: new Vector3()
      }
      moonlightCPU(
        sun,
        new Vector3(1, 0, 0),
        camera,
        1,
        new Vector3(1, 1, 1),
        portOut
      )
      const coreOut = {
        lightDirection: new Vec3(),
        irradianceRatio: new Vec3()
      }
      moonlight(
        vec3From(sun),
        new Vec3(1, 0, 0),
        vec3From(camera),
        1,
        new Vec3(1, 1, 1),
        coreOut
      )
      expectBitExact(
        'moonlight-degenerate',
        [
          ...vec3Array(coreOut.lightDirection),
          ...vec3Array(coreOut.irradianceRatio)
        ],
        [
          ...vec3Array(portOut.lightDirection),
          ...vec3Array(portOut.irradianceRatio)
        ]
      )
    }
  })
})
