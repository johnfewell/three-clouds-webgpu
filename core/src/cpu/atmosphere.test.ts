// The atmosphere context's per-render values against takram's own
// AtmosphereContext, driven through its uniforms' render updates. These feed
// the composite, the sky and the stars, so they must match to the bit

import {
  Matrix4,
  PerspectiveCamera,
  Vector3,
  WebGPUCoordinateSystem
} from 'three'

import {
  getECIToECEFRotationMatrix as takramECIToECEF,
  getMoonFixedToECIRotationMatrix as takramMoonFixedToECI
} from '@takram/three-atmosphere'
import {
  AtmosphereContext,
  MoonNode,
  StarsNode,
  SunNode
} from '@takram/three-atmosphere/webgpu'

import { log } from '../../../test/helpers/log'
import { bitDiff, expectBitExact, mat4From, vec3From } from '../../test/twin'
import {
  createAtmosphereInputs,
  createAtmosphereUniformValues,
  updateAtmosphereUniformValues
} from './atmosphere'
import { createCamera, setCameraWorld, setPerspective } from './camera'
import {
  getECIToECEFRotationMatrix,
  getMoonFixedToECIRotationMatrix
} from './celestial'

const ER = 6378137

const DATES = [
  new Date('2026-10-04T12:00:00Z'),
  new Date('2026-03-20T06:15:00Z'),
  new Date('2000-01-01T12:00:00Z'),
  Date.UTC(2031, 6, 15, 3, 7, 11)
]

interface UpdatableUniform<T> {
  value: T
  update: (frame: unknown) => void
}

function renderUpdate<T>(node: unknown, camera: PerspectiveCamera): T {
  const uniform = node as UpdatableUniform<T>
  uniform.update({ camera })
  return uniform.value
}

describe('atmosphere context values match takram bit for bit', () => {
  it('the moon body-fixed frame', () => {
    // Many dates: a reordered degree conversion changes only some spins
    const dates = Array.from(
      { length: 200 },
      (_, i) => Date.UTC(1990, 0, 1) + i * 5.3e9 + (i % 7) * 3.1e7
    )
    for (const date of dates) {
      expectBitExact(
        `moon-fixed-${String(date)}`,
        getMoonFixedToECIRotationMatrix(date).elements,
        takramMoonFixedToECI(date).elements
      )
    }
  })

  it('per-render values over poses, frames and dates', () => {
    const rows: Record<string, unknown>[] = []
    const poses: [number, number, number][][] = [
      [
        [0, ER + 60000, 0],
        [0, ER - 20000, 0]
      ],
      [
        [-1274794, 1081104, -6196721],
        [-1259003, 1067712, -6119447]
      ],
      [
        [0, ER + 7900, 0],
        [ER, 0, 0]
      ]
    ]
    const frames = [
      new Matrix4(),
      new Matrix4().makeRotationY((28 * Math.PI) / 180),
      new Matrix4().makeRotationAxis(new Vector3(1, 2, 3).normalize(), 0.7)
    ]
    for (const [[position, lookAt], worldToECEF, date] of poses.flatMap(p =>
      frames.flatMap(f => DATES.map(d => [p, f, d] as const))
    )) {
      const camera = new PerspectiveCamera(50, 16 / 9, 100, 1e8)
      camera.coordinateSystem = WebGPUCoordinateSystem
      camera.updateProjectionMatrix()
      camera.position.set(...position!)
      camera.lookAt(...lookAt!)
      camera.updateMatrixWorld()

      const eciToECEF = takramECIToECEF(date)
      const moonFixed = takramMoonFixedToECI(date).premultiply(eciToECEF)
      const sun = new Vector3(0.3, 0.9, 0.1).normalize()
      const moon = new Vector3(-0.2, 0.4, 0.9).normalize()

      const ctx = new AtmosphereContext()
      ctx.matrixWorldToECEF.value.copy(worldToECEF)
      ctx.matrixECIToECEF.value.copy(eciToECEF)
      ctx.matrixMoonFixedToECEF.value.copy(moonFixed)
      ctx.sunDirectionECEF.value.copy(sun)
      ctx.moonDirectionECEF.value.copy(moon)
      const port = [
        ...ctx.matrixWorldToECEF.value.elements,
        ...renderUpdate<Matrix4>(ctx.matrixECEFToWorld, camera).elements,
        ...ctx.matrixECIToECEF.value.elements,
        ...ctx.matrixMoonFixedToECEF.value.elements,
        ...sun.toArray(),
        ...moon.toArray(),
        ...renderUpdate<Vector3>(ctx.cameraPositionECEF, camera).toArray(),
        ...renderUpdate<Vector3>(ctx.altitudeCorrectionECEF, camera).toArray(),
        renderUpdate<number>(ctx.cameraHeight, camera)
      ]

      const inputs = createAtmosphereInputs()
      inputs.matrixWorldToECEF.copy(mat4From(worldToECEF))
      inputs.matrixECIToECEF.copy(getECIToECEFRotationMatrix(date))
      inputs.matrixMoonFixedToECEF.copy(
        getMoonFixedToECIRotationMatrix(date).premultiply(
          getECIToECEFRotationMatrix(date)
        )
      )
      inputs.sunDirectionECEF.copy(vec3From(sun))
      inputs.moonDirectionECEF.copy(vec3From(moon))
      const coreCamera = setCameraWorld(
        setPerspective(createCamera(), {
          fov: 50,
          aspect: 16 / 9,
          near: 100,
          far: 1e8
        }),
        mat4From(camera.matrixWorld)
      )
      const u = updateAtmosphereUniformValues(
        createAtmosphereUniformValues(),
        inputs,
        coreCamera
      )
      const core = [
        ...u.matrixWorldToECEF.elements,
        ...u.matrixECEFToWorld.elements,
        ...u.matrixECIToECEF.elements,
        ...u.matrixMoonFixedToECEF.elements,
        u.sunDirectionECEF.x,
        u.sunDirectionECEF.y,
        u.sunDirectionECEF.z,
        u.moonDirectionECEF.x,
        u.moonDirectionECEF.y,
        u.moonDirectionECEF.z,
        u.cameraPositionECEF.x,
        u.cameraPositionECEF.y,
        u.cameraPositionECEF.z,
        u.altitudeCorrectionECEF.x,
        u.altitudeCorrectionECEF.y,
        u.altitudeCorrectionECEF.z,
        u.cameraHeight
      ]
      const d = bitDiff(core, port)
      rows.push({ position, date: String(date), ...d })
      expect(d.mismatches).toBe(0)
    }
    log('atmosphere-sweep', rows)
    expect(rows).toHaveLength(poses.length * frames.length * DATES.length)
  })

  it('the sky nodes defaults', () => {
    const inputs = createAtmosphereInputs()
    const sun = new SunNode()
    const moon = new MoonNode()
    // An empty catalogue: only the uniforms' defaults are read
    const stars = new StarsNode(new ArrayBuffer(0))
    const atmosphere = new AtmosphereContext()
    expectBitExact(
      'sky-defaults',
      [
        inputs.sunAngularRadius,
        inputs.sunIntensity,
        inputs.moonAngularRadius,
        inputs.moonIntensity,
        inputs.starsPointSize,
        inputs.starsIntensity,
        inputs.starsMagnitudeRange.x,
        inputs.starsMagnitudeRange.y,
        inputs.bottomRadius,
        inputs.ellipsoid.radii.x,
        inputs.ellipsoid.radii.y,
        inputs.ellipsoid.radii.z
      ],
      [
        sun.angularRadius.value,
        sun.intensity.value,
        moon.angularRadius.value,
        moon.intensity.value,
        stars.pointSize.value,
        stars.intensity.value,
        stars.magnitudeRange.value.x,
        stars.magnitudeRange.value.y,
        atmosphere.parameters.bottomRadius,
        ...atmosphere.ellipsoid.radii.toArray()
      ]
    )
  })
})
