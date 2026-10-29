import { Vector3, type PerspectiveCamera } from 'three'
import { describe, expect, it } from 'vitest'

import { Ellipsoid } from '@takram/three-geospatial'

import { createParityCamera } from '../src/parityCamera'
import { caseByName, type CasePose } from './index'

// ARM BC selects "sky" on FAR-PLANE DEPTH (3l31), and the only large depth
// writer is the ellipsoid, so a pose's sky domain is the frustum rays that miss
// it. The 0.4 floor clears the 1-5 % noise bands and survives camera tweaks
export const SKY_FRACTION_FLOOR = 0.4

const WIDTH = 1280
const HEIGHT = 720

export interface SkyRowProfile {
  // Far-plane pixels per row, row 0 = TOP of the frame (the committed-PNG and
  // readback convention: capture.mjs writes A and B with the same y-flip so
  // the pair is directly comparable, top-left origin)
  perRow: number[]
  // Last row that is entirely sky and first row with no sky at all. The rows
  // between are the curved horizon crossing the frame
  lastFullSkyRow: number
  firstNoSkyRow: number
}

export function skyRowProfile(pose: CasePose): SkyRowProfile {
  const perRow = farPlanePerRow(pose)
  let lastFullSkyRow = -1
  for (let y = 0; y < HEIGHT; y++) {
    if (perRow[y] === WIDTH) lastFullSkyRow = y
    else break
  }
  let firstNoSkyRow = HEIGHT
  for (let y = 0; y < HEIGHT; y++) {
    if (perRow[y] === 0) {
      firstNoSkyRow = y
      break
    }
  }
  return { perRow, lastFullSkyRow, firstNoSkyRow }
}

function farPlanePerRow(pose: CasePose): number[] {
  const camera = createParityCamera('perspective') as PerspectiveCamera
  camera.position.fromArray(pose.position)
  camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2])
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  const radii = Ellipsoid.WGS84.radii
  const origin = camera.position.clone().divide(radii)
  const oo = origin.dot(origin)
  const point = new Vector3()
  const dir = new Vector3()
  const perRow: number[] = []
  for (let y = 0; y < HEIGHT; y++) {
    const ndcY = 1 - ((y + 0.5) / HEIGHT) * 2
    let count = 0
    for (let x = 0; x < WIDTH; x++) {
      const ndcX = ((x + 0.5) / WIDTH) * 2 - 1
      point.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position)
      dir.copy(point).divide(radii)
      const a = dir.dot(dir)
      const b = 2 * origin.dot(dir)
      const c = oo - 1
      const disc = b * b - 4 * a * c
      if (disc < 0) {
        count++
      } else {
        const tNear = (-b - Math.sqrt(disc)) / (2 * a)
        const tFar = (-b + Math.sqrt(disc)) / (2 * a)
        if (tNear <= 0 && tFar <= 0) count++
      }
    }
    perRow.push(count)
  }
  return perRow
}

export function farPlanePixels(pose: CasePose): {
  count: number
  total: number
  fraction: number
} {
  const camera = createParityCamera('perspective') as PerspectiveCamera
  camera.position.fromArray(pose.position)
  camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2])
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()

  // Scale ECEF by the ellipsoid radii componentwise: the ellipsoid becomes the
  // unit sphere and the ray-sphere quadratic decides hit or miss exactly
  const radii = Ellipsoid.WGS84.radii
  const origin = camera.position.clone().divide(radii)
  const oo = origin.dot(origin)
  // the camera is outside the ellipsoid
  expect(oo).toBeGreaterThan(1)

  const point = new Vector3()
  const dir = new Vector3()
  let count = 0
  for (let y = 0; y < HEIGHT; y++) {
    const ndcY = 1 - ((y + 0.5) / HEIGHT) * 2
    for (let x = 0; x < WIDTH; x++) {
      const ndcX = ((x + 0.5) / WIDTH) * 2 - 1
      point.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position)
      dir.copy(point).divide(radii)
      const a = dir.dot(dir)
      const b = 2 * origin.dot(dir)
      const c = oo - 1
      const disc = b * b - 4 * a * c
      // Miss when the ray never meets the sphere, or meets it only behind the
      // camera (both roots negative): those pixels reach the far plane
      if (disc < 0) {
        count++
      } else {
        const tNear = (-b - Math.sqrt(disc)) / (2 * a)
        const tFar = (-b + Math.sqrt(disc)) / (2 * a)
        if (tNear <= 0 && tFar <= 0) count++
      }
    }
  }
  const total = WIDTH * HEIGHT
  return { count, total, fraction: count / total }
}

function poseOf(name: string): CasePose {
  const c = caseByName(name)
  if (c == null) throw new Error(`case ${name} is not in the registry`)
  return c.pose
}

describe('sky domain (far-plane pixels) of the BC bench geometry', () => {
  it('the inside-deck bench pose has ZERO far-plane pixels — the measured control', () => {
    const r = farPlanePixels(poseOf('inside-deck-low-sun'))
    console.log(
      `[skyDomain] inside-deck-low-sun far-plane pixels: ${r.count} / ${r.total}`
    )
    expect(poseOf('shafts-inside-deck')).toBe(poseOf('inside-deck-low-sun'))
    expect(r.count).toBe(0)
  })

  it('the sky-horizon pair shares one pose whose camera has escaped the deck', () => {
    const pose = poseOf('sky-horizon-low-sun')
    expect(poseOf('shafts-sky-horizon')).toBe(pose)
    // Highest default layer: CloudLayers.ts channel 'b', altitude 7500 + height
    // 500. Pinned by hand here (a claim); the hardware read on the case is the
    // evidence that the sky above the horizon is uncovered
    const altitude = new Vector3().fromArray(pose.position).length() - 6378137
    expect(altitude).toBeGreaterThan(8000)
  })

  it('the sky-horizon pose has a non-empty far-plane domain at or above the declared floor', () => {
    const r = farPlanePixels(poseOf('sky-horizon-low-sun'))
    // The count is printed BEFORE any statistic is read over it
    console.log(
      `[skyDomain] sky-horizon-low-sun far-plane pixels: ${r.count} / ${r.total} = ${(r.fraction * 100).toFixed(2)}% (declared floor ${SKY_FRACTION_FLOOR * 100}%)`
    )
    expect(r.count).toBeGreaterThan(0)
    expect(r.fraction).toBeGreaterThanOrEqual(SKY_FRACTION_FLOOR)
  })
})

// ROW ALIGNMENT: BC run 9 saw A and B flipped
// here (corr -0.66, flipped +0.94). From 12 km looking level the sky is ONE
// band at the TOP, so a mask with sky rows at the bottom is flipped
describe('row alignment of the sky domain on the sky-horizon pose', () => {
  it('the far-plane band is contiguous from the TOP and the per-row count never increases downward', () => {
    const pose = caseByName('sky-horizon-low-sun')!.pose
    const profile = skyRowProfile(pose)
    console.log(
      `[skyDomain] sky-horizon-low-sun rows: lastFullSkyRow ${profile.lastFullSkyRow}, firstNoSkyRow ${profile.firstNoSkyRow} of ${HEIGHT}; row 0 sky ${profile.perRow[0]}, row ${HEIGHT - 1} sky ${profile.perRow[HEIGHT - 1]}`
    )
    // Sky at the top, none at the bottom
    expect(profile.perRow[0]).toBe(WIDTH)
    expect(profile.perRow[HEIGHT - 1]).toBe(0)
    // A single top band: full-sky rows first, then the horizon crossing, then
    // no sky, with no sky row below the first no-sky row
    expect(profile.lastFullSkyRow).toBeGreaterThan(0)
    expect(profile.firstNoSkyRow).toBeGreaterThan(profile.lastFullSkyRow)
    for (let y = profile.firstNoSkyRow; y < HEIGHT; y++) {
      expect(profile.perRow[y], `row ${y}`).toBe(0)
    }
    // Monotone: moving down the frame never adds sky
    for (let y = 1; y < HEIGHT; y++) {
      const above = profile.perRow[y - 1] ?? 0
      expect(profile.perRow[y], `row ${y}`).toBeLessThanOrEqual(above)
    }
    // The horizon sits below centre (12 km dip ~3.5 degrees of a 50-degree
    // frame): the crossing starts in the lower half
    expect(profile.lastFullSkyRow).toBeGreaterThan(HEIGHT / 2)
    // The horizon crossing is a shallow curve, a few rows tall, not a band
    expect(profile.firstNoSkyRow - profile.lastFullSkyRow).toBeLessThan(
      HEIGHT / 10
    )
  })

  it('flipping the model puts the sky at the bottom — the check can fail', () => {
    // The assertion above is only a check if the opposite orientation would
    // fail it: read the same profile bottom-up and the first-row test flips
    const profile = skyRowProfile(caseByName('sky-horizon-low-sun')!.pose)
    const flipped = [...profile.perRow].reverse()
    expect(flipped[0]).toBe(0)
    expect(flipped[HEIGHT - 1]).toBe(WIDTH)
  })
})
