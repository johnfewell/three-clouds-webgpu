// Cascade fitting against the port's CascadedShadowMaps on the same camera
// The spike replayed cascades from a recording, so its cascades never moved
// with the camera, and the core must move them exactly as the port does

import {
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGPUCoordinateSystem
} from 'three'

import {
  CascadedShadowMaps as PortCascadedShadowMaps,
  getSunDistanceFudge as portSunDistanceFudge
} from '../../../src/shadow/CascadedShadowMaps'
import { log } from '../../../test/helpers/log'
import { bitDiff, expectBitExact, mat4From, vec3From } from '../../test/twin'
import {
  createCamera,
  setCameraWorld,
  setPerspective,
  type CameraState
} from './camera'
import {
  CascadedShadowMaps,
  getSunDistanceFudge,
  splitFrustum,
  type FrustumSplitMode
} from './cascades'
import { Vec2 } from './math'

const ER = 6378137

interface Pose {
  name: string
  position: [number, number, number]
  lookAt: [number, number, number]
}

// Ladder poses (examples/parity/cases/index.ts). The first looks straight
// down +Y, which takes lookAt's parallel-up fallback
const POSES: Pose[] = [
  {
    name: 'orbit-60km',
    position: [0, ER + 60000, 0],
    lookAt: [0, ER - 20000, 0]
  },
  { name: 'horizon-grazing', position: [0, ER + 7900, 0], lookAt: [ER, 0, 0] },
  {
    name: 'above-deck-horizon',
    position: [0, ER + 12000, 0],
    lookAt: [250000, ER + 12000, 0]
  },
  {
    name: 'polar-south-60km',
    position: [-1274794, 1081104, -6196721],
    lookAt: [-1259003, 1067712, -6119447]
  }
]

const SUNS: [number, number, number][] = [
  [0, Math.SQRT1_2, -Math.SQRT1_2],
  [0.3, 0.9, 0.1],
  [-0.8, 0.05, 0.6]
]

function threeCamera(pose: Pose): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 16 / 9, 100, 1e8)
  // WebGPURenderer sets this before every render
  camera.coordinateSystem = WebGPUCoordinateSystem
  camera.updateProjectionMatrix()
  camera.position.set(...pose.position)
  camera.lookAt(...pose.lookAt)
  camera.updateMatrixWorld()
  return camera
}

function coreCamera(camera: PerspectiveCamera): CameraState {
  const c = setPerspective(createCamera(), {
    fov: camera.fov,
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far
  })
  return setCameraWorld(c, mat4From(camera.matrixWorld))
}

interface Config {
  cascadeCount: number
  mapSize: number
  splitLambda: number
  splitMode?: FrustumSplitMode
  maxFar?: number | null
  farScale?: number
}

function fit(
  config: Config,
  camera: PerspectiveCamera,
  sun: Vector3,
  distance: number
) {
  // The port spreads options over its defaults, so an undefined key would
  // replace a default rather than fall back to it
  const optional = Object.fromEntries(
    Object.entries({
      splitMode: config.splitMode,
      maxFar: config.maxFar,
      farScale: config.farScale
    }).filter(([, v]) => v !== undefined)
  )
  const port = new PortCascadedShadowMaps({
    cascadeCount: config.cascadeCount,
    mapSize: new Vector2(config.mapSize, config.mapSize),
    splitLambda: config.splitLambda,
    ...optional
  })
  port.update(camera, sun, distance)
  const core = new CascadedShadowMaps({
    cascadeCount: config.cascadeCount,
    mapSize: new Vec2(config.mapSize, config.mapSize),
    splitLambda: config.splitLambda,
    splitMode: config.splitMode,
    maxFar: config.maxFar,
    farScale: config.farScale
  })
  core.update(coreCamera(camera), vec3From(sun), distance)
  return { port, core }
}

const MATRICES = [
  'matrix',
  'inverseMatrix',
  'projectionMatrix',
  'inverseProjectionMatrix',
  'viewMatrix',
  'inverseViewMatrix'
] as const

// Every value the GPU reads from a fit, flattened in a fixed order
function flatPort(csm: PortCascadedShadowMaps): number[] {
  return [
    csm.far,
    ...csm.cascades.flatMap(c => [
      c.interval.x,
      c.interval.y,
      ...MATRICES.flatMap(k => c[k].elements)
    ])
  ]
}

function flatCore(csm: CascadedShadowMaps): number[] {
  return [
    csm.far,
    ...csm.cascades.flatMap(c => [
      c.interval.x,
      c.interval.y,
      ...MATRICES.flatMap(k => c[k].elements)
    ])
  ]
}

describe('cascade fitting matches the port bit for bit', () => {
  it('camera projection, inverse and view inverse use three formulas', () => {
    for (const pose of POSES) {
      const camera = threeCamera(pose)
      const core = coreCamera(camera)
      expectBitExact(
        `camera-${pose.name}`,
        [
          ...core.projectionMatrix.elements,
          ...core.projectionMatrixInverse.elements,
          ...core.matrixWorldInverse.elements
        ],
        [
          ...camera.projectionMatrix.elements,
          ...camera.projectionMatrixInverse.elements,
          ...camera.matrixWorldInverse.elements
        ]
      )
    }
  })

  it('splitFrustum in all three modes', () => {
    for (const mode of ['uniform', 'logarithmic', 'practical'] as const) {
      const port = new PortCascadedShadowMaps({
        cascadeCount: 4,
        mapSize: new Vector2(512, 512),
        splitMode: mode,
        splitLambda: 0.6
      })
      port.update(threeCamera(POSES[0]!), new Vector3(0, 1, 0))
      expectBitExact(
        `split-${mode}`,
        splitFrustum(mode, 4, 100, 1e8, 0.6),
        [1, 2, 3, 4].map(i => port.cascades[i - 1]!.interval.y)
      )
    }
  })

  it('every pose, sun, cascade count and map size', () => {
    const rows: Record<string, unknown>[] = []
    for (const pose of POSES) {
      const camera = threeCamera(pose)
      for (const s of SUNS) {
        const sun = new Vector3(...s).normalize()
        const up = new Vector3(...pose.position).normalize()
        const distance = portSunDistanceFudge(sun, up)
        expect(getSunDistanceFudge(vec3From(sun), vec3From(up))).toBe(distance)
        for (const cascadeCount of [1, 2, 3, 4]) {
          for (const mapSize of [256, 512, 1024]) {
            const { port, core } = fit(
              { cascadeCount, mapSize, splitLambda: 0.6 },
              camera,
              sun,
              distance
            )
            const d = bitDiff(flatCore(core), flatPort(port))
            rows.push({ pose: pose.name, sun: s, cascadeCount, mapSize, ...d })
            expect(d.mismatches).toBe(0)
          }
        }
      }
    }
    log('cascade-sweep', rows)
    expect(rows).toHaveLength(POSES.length * SUNS.length * 4 * 3)
  })

  it('maxFar, farScale and the other split modes', () => {
    const camera = threeCamera(POSES[1]!)
    const sun = new Vector3(0.3, 0.9, 0.1).normalize()
    const configs: Config[] = [
      { cascadeCount: 3, mapSize: 512, splitLambda: 0.6, maxFar: 2e5 },
      { cascadeCount: 3, mapSize: 512, splitLambda: 0.6, farScale: 0.01 },
      { cascadeCount: 4, mapSize: 512, splitLambda: 0.5, splitMode: 'uniform' },
      {
        cascadeCount: 2,
        mapSize: 512,
        splitLambda: 0.5,
        splitMode: 'logarithmic'
      }
    ]
    configs.forEach((config, i) => {
      const { port, core } = fit(config, camera, sun, 1e4)
      expectBitExact(`config-${i}`, flatCore(core), flatPort(port))
    })
  })

  it('a camera moved 1 km moves the cascades exactly as the port does', () => {
    const config = { cascadeCount: 3, mapSize: 512, splitLambda: 0.6 }
    const sun = new Vector3(0, Math.SQRT1_2, -Math.SQRT1_2)
    // A move along x is perpendicular to this sun's plane, and the port's own
    // texel snapping absorbs it, so its fit is unchanged on both sides. Along
    // y or z the unsnapped light-space depth moves
    const axes = [
      { axis: 0, moves: false },
      { axis: 1, moves: true },
      { axis: 2, moves: true }
    ]
    for (const pose of POSES) {
      const a = fit(config, threeCamera(pose), sun, 1e4)
      for (const { axis, moves } of axes) {
        const offset = (v: [number, number, number]) =>
          v.map((x, i) => (i === axis ? x + 1000 : x)) as [
            number,
            number,
            number
          ]
        const moved: Pose = {
          ...pose,
          position: offset(pose.position),
          lookAt: offset(pose.lookAt)
        }
        const b = fit(config, threeCamera(moved), sun, 1e4)
        const scope = `moved-${pose.name}-${'xyz'[axis]}`
        expectBitExact(scope, flatCore(b.core), flatPort(b.port))
        // Positive control: a move that changes the port's fit must change
        // it here too, or the equality compares two frozen fits
        const moveDiff = bitDiff(flatCore(b.core), flatCore(a.core))
        const portDiff = bitDiff(flatPort(b.port), flatPort(a.port))
        log(`${scope}-control`, {
          core: moveDiff.mismatches,
          port: portDiff.mismatches
        })
        expect(moveDiff.mismatches).toBe(portDiff.mismatches)
        if (moves) expect(moveDiff.mismatches).toBeGreaterThan(0)
      }
    }
  })

  it('one instance refit across counts and poses keeps no stale state', () => {
    const config = { cascadeCount: 4, mapSize: 512, splitLambda: 0.6 }
    const port = new PortCascadedShadowMaps({
      ...config,
      mapSize: new Vector2(512, 512)
    })
    const core = new CascadedShadowMaps({
      ...config,
      mapSize: new Vec2(512, 512)
    })
    const sun = new Vector3(0.3, 0.9, 0.1).normalize()
    const sequence: [number, Pose][] = [
      [4, POSES[0]!],
      [2, POSES[1]!],
      [3, POSES[3]!],
      [4, POSES[2]!]
    ]
    sequence.forEach(([count, pose], i) => {
      port.cascadeCount = count
      core.cascadeCount = count
      const camera = threeCamera(pose)
      port.update(camera, sun, 5e5)
      core.update(coreCamera(camera), vec3From(sun), 5e5)
      expectBitExact(`refit-${i}`, flatCore(core), flatPort(port))
    })
  })
})
