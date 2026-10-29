import { expect, type Page } from '@playwright/test'
import { Matrix4, PerspectiveCamera, Vector3 } from 'three'

import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// Two-sided orientation guard (jg7u, ADR-013 A5) with two convention-free
// anchors: the sun disc on its projected row, cloud structure BELOW the horizon
// from 12 km. Proven red on main (two cancelling mirrors) and on each fix alone

const WIDTH = 1280
const HEIGHT = 720
const ER = 6378137
// Sun in the harness's units (ENU at the Tokyo anchor, hence a local elevation
// of ~11 degrees, not 7) and the yaw that centres it, pinned by the
// projected-row assertion rather than by hand
const SUN = { elevation: 7, azimuth: 325 }
const YAW_DEG = 48.17
const POSITION: [number, number, number] = [0, ER + 12000, 0]
const LOOK_AT: [number, number, number] = [
  250000 * Math.cos((YAW_DEG * Math.PI) / 180),
  ER + 12000,
  250000 * Math.sin((YAW_DEG * Math.PI) / 180)
]
// skyDomain.test.ts: the crossing starts at 407
const HORIZON_ROW = 407
const DISC_ROW_TOLERANCE = 6

function projectedSunPixel(): { col: number; row: number } {
  const DEG = Math.PI / 180
  const anchor = new Geodetic(139.7 * DEG, 35.7 * DEG, 0).toECEF()
  const rot = new Matrix4().extractRotation(
    Ellipsoid.WGS84.getEastNorthUpFrame(anchor)
  )
  const el = SUN.elevation * DEG
  const az = SUN.azimuth * DEG
  const dir = new Vector3(
    Math.sin(az) * Math.cos(el),
    Math.cos(az) * Math.cos(el),
    Math.sin(el)
  ).applyMatrix4(rot)
  const camera = new PerspectiveCamera(50, 16 / 9, 100, 1e8)
  camera.position.fromArray(POSITION)
  camera.lookAt(...LOOK_AT)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  const ndc = camera.position
    .clone()
    .add(dir.multiplyScalar(1e6))
    .project(camera)
  return {
    col: Math.round(((ndc.x + 1) / 2) * WIDTH),
    row: Math.round(((1 - ndc.y) / 2) * HEIGHT)
  }
}

interface Readback {
  width: number
  height: number
  data: number[]
}

function brightest(r: Readback): { col: number; row: number; peak: number } {
  let best = -1
  let bi = 0
  const n = r.width * r.height
  for (let i = 0; i < n; i++) {
    const l =
      0.2126 * r.data[i * 4]! +
      0.7152 * r.data[i * 4 + 1]! +
      0.0722 * r.data[i * 4 + 2]!
    if (l > best) {
      best = l
      bi = i
    }
  }
  return { col: bi % r.width, row: Math.floor(bi / r.width), peak: best }
}

// Fine-structure energy per half: luminance minus a 13x13 box mean, above and
// below the horizon. Gradients cancel, cloud texture does not. The sun disc
// (~20000 vs ~0.01-0.1) is masked where found, and each pixel is capped
const DISC_MASK_RADIUS = 48
const ENERGY_CAP = 0.5
function cloudEnergyByHalf(
  r: Readback,
  disc: { col: number; row: number }
): { above: number; below: number } {
  const { width: w, height: h } = r
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    lum[i] =
      0.2126 * r.data[i * 4]! +
      0.7152 * r.data[i * 4 + 1]! +
      0.0722 * r.data[i * 4 + 2]!
  }
  const k = 6
  let above = 0
  let below = 0
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (Math.hypot(x - disc.col, y - disc.row) <= DISC_MASK_RADIUS) continue
      let sum = 0
      let count = 0
      for (let dy = -k; dy <= k; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy))
        for (let dx = -k; dx <= k; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx))
          sum += lum[yy * w + xx]!
          count++
        }
      }
      const e = Math.min(ENERGY_CAP, Math.abs(lum[y * w + x]! - sum / count))
      if (y < HORIZON_ROW) above += e
      else below += e
    }
  }
  return { above, below }
}

async function readLinear(page: Page, side: 'A' | 'B'): Promise<Readback> {
  return page.evaluate(async s => {
    const r = await (window as ParityWindow).__parity.readLinear(s)
    return { width: r.width, height: r.height, data: Array.from(r.data) }
  }, side)
}

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'skyOrientation')
})

test.describe('sky-pose orientation guard (both sides, linear buffers)', () => {
  test('the projected sun disc and the cloud layer sit where physics puts them on BOTH sides', async ({
    page
  }) => {
    test.setTimeout(240_000)
    await loadCase(page, 'sky-horizon-low-sun')
    for (const side of ['A', 'B'] as const) {
      await page.evaluate(
        s =>
          (window as ParityWindow).__parity.renderOnce(s, {
            time: 0,
            frame: 0,
            warmup: 64,
            resetHistory: true
          }),
        side
      )
    }
    // Same altitude and pitch as the case, yawed toward the sun so the disc
    // is in frame above the horizon on both sides
    await page.evaluate(
      ([pos, la, sun]) => {
        const p = (window as ParityWindow).__parity as unknown as {
          sideAHandle: {
            camera: {
              position: { fromArray: (a: number[]) => void }
              lookAt: (x: number, y: number, z: number) => void
              updateMatrixWorld: () => void
              updateProjectionMatrix: () => void
            }
            setSun: (e: number, a: number) => void
            render: (dt: number) => void
          }
          sideBHandle: {
            camera: {
              position: { fromArray: (a: number[]) => void }
              lookAt: (x: number, y: number, z: number) => void
              updateMatrixWorld: () => void
              updateProjectionMatrix: () => void
            }
            setSun: (e: number, a: number) => void
          }
        }
        for (const h of [p.sideAHandle, p.sideBHandle]) {
          h.camera.position.fromArray(pos)
          h.camera.lookAt(la[0], la[1], la[2])
          h.camera.updateMatrixWorld()
          h.camera.updateProjectionMatrix()
          h.setSun(sun.elevation, sun.azimuth)
        }
        for (let i = 0; i < 8; i++) p.sideAHandle.render(0)
      },
      [POSITION, LOOK_AT, SUN] as const
    )
    const expected = projectedSunPixel()
    const A = await readLinear(page, 'A')
    const B = await readLinear(page, 'B')
    expect(A.width).toBe(WIDTH)
    expect(B.width).toBe(WIDTH)
    const discA = brightest(A)
    const discB = brightest(B)
    const energyA = cloudEnergyByHalf(A, discA)
    const energyB = cloudEnergyByHalf(B, discB)
    console.log(
      `[skyOrientation] projected sun (${expected.col}, ${expected.row}) | A disc (${discA.col}, ${discA.row}) B disc (${discB.col}, ${discB.row}) | cloud energy above/below horizon: A ${energyA.above.toFixed(1)}/${energyA.below.toFixed(1)} B ${energyB.above.toFixed(1)}/${energyB.below.toFixed(1)}`
    )
    // Anchor 1: the disc on its projected row, both sides. A mirrored buffer
    // puts it on row HEIGHT - 1 - expected.row instead
    expect(Math.abs(discA.row - expected.row)).toBeLessThanOrEqual(
      DISC_ROW_TOLERANCE
    )
    expect(Math.abs(discB.row - expected.row)).toBeLessThanOrEqual(
      DISC_ROW_TOLERANCE
    )
    expect(Math.abs(discA.col - expected.col)).toBeLessThanOrEqual(
      DISC_ROW_TOLERANCE
    )
    expect(Math.abs(discB.col - expected.col)).toBeLessThanOrEqual(
      DISC_ROW_TOLERANCE
    )
    // Anchor 2: cloud texture below the horizon, both sides
    expect(energyA.below).toBeGreaterThan(energyA.above)
    expect(energyB.below).toBeGreaterThan(energyB.above)
  })
})
