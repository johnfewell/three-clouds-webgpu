// The math layer against three's own classes. Every matrix and vector the
// GPU reads goes through these, so a reordered operation would move uploads by
// an ULP and break the core's bit-for-bit parity with the port

import {
  Matrix3,
  Matrix4,
  Quaternion,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem
} from 'three'

import {
  expectBitExact,
  mat4From,
  seededRandom,
  vec3Array,
  vec3From
} from '../../test/twin'
import { Mat3, Mat4, Quat, Vec3, Vec4 } from './math'

const rand = seededRandom(1)
const r = (scale = 1) => (rand() * 2 - 1) * scale

function randomThreeMatrix(): Matrix4 {
  const q = new Quaternion(r(), r(), r(), r()).normalize()
  const p = new Vector3(r(7e6), r(7e6), r(7e6))
  return new Matrix4().compose(p, q, new Vector3(1, 1, 1))
}

describe('math layer matches three r185 bit for bit', () => {
  it('invert, multiply and transpose on world-scale affine matrices', () => {
    for (let i = 0; i < 64; ++i) {
      const a = randomThreeMatrix()
      const b = randomThreeMatrix()
      const ca = mat4From(a)
      const cb = mat4From(b)
      expectBitExact(
        `invert-${i}`,
        ca.clone().invert().elements,
        a.clone().invert().elements
      )
      expectBitExact(
        `multiply-${i}`,
        ca.clone().multiply(cb).elements,
        a.clone().multiply(b).elements
      )
      expectBitExact(
        `transpose-${i}`,
        ca.clone().transpose().elements,
        a.clone().transpose().elements
      )
    }
  })

  it('invert on projections and view-projections, which are dense', () => {
    // Affine inputs zero half of invert's terms, so a reordered sum can pass
    // on them. A projection times a view fills every element
    for (let i = 0; i < 32; ++i) {
      const proj = new Matrix4().makePerspective(
        -0.5 - rand(),
        0.5 + rand(),
        0.3 + rand(),
        -0.3 - rand(),
        1 + rand() * 100,
        1e5 + rand() * 1e7,
        WebGPUCoordinateSystem
      )
      const viewProj = proj.clone().multiply(randomThreeMatrix().invert())
      expectBitExact(
        `invert-proj-${i}`,
        mat4From(proj).invert().elements,
        proj.clone().invert().elements
      )
      expectBitExact(
        `invert-viewProj-${i}`,
        mat4From(viewProj).invert().elements,
        viewProj.clone().invert().elements
      )
    }
  })

  it('invert and multiply on fully dense random matrices', () => {
    // Camera matrices keep zeros that make a reordered sum exact, so only a
    // dense matrix pins the operation order itself
    for (let i = 0; i < 64; ++i) {
      const a = new Matrix4().fromArray(
        Array.from({ length: 16 }, () => r(1e3))
      )
      const b = new Matrix4().fromArray(
        Array.from({ length: 16 }, () => r(1e3))
      )
      expectBitExact(
        `invert-dense-${i}`,
        mat4From(a).invert().elements,
        a.clone().invert().elements
      )
      expectBitExact(
        `multiply-dense-${i}`,
        mat4From(a).multiply(mat4From(b)).elements,
        a.clone().multiply(b).elements
      )
    }
  })

  it('decompose, through all four quaternion branches and odd scales', () => {
    // Rotations of pi about x, y and z pick setFromRotationMatrix's three
    // trace <= 0 branches, a small angle picks trace > 0
    const rotations = [
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3),
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI - 0.01),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI - 0.01),
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI - 0.01),
      ...Array.from({ length: 40 }, () =>
        new Quaternion(r(), r(), r(), r()).normalize()
      ),
      // pi about (1, 1, 0): m11 equals m22 exactly, the branch tie
      new Quaternion().setFromAxisAngle(
        new Vector3(1, 1, 0).normalize(),
        Math.PI
      )
    ]
    const scales = [
      new Vector3(1, 1, 1),
      new Vector3(2, 0.5, 3),
      // A negative determinant flips the x scale
      new Vector3(-1, 1, 1),
      // Singular: decompose returns identity and unit scale
      new Vector3(0, 1, 1)
    ]
    rotations.forEach((q, i) => {
      scales.forEach((s, j) => {
        const m = new Matrix4().compose(new Vector3(r(1e6), 5, -3), q, s)
        const tp = new Vector3()
        // Junk in, so a branch that forgets to write the output shows
        const tq = new Quaternion(9, 9, 9, 9)
        const ts = new Vector3()
        m.decompose(tp, tq, ts)
        const cp = new Vec3()
        const cq = new Quat(9, 9, 9, 9)
        const cs = new Vec3()
        mat4From(m).decompose(cp, cq, cs)
        expectBitExact(
          `decompose-${i}-${j}`,
          [...vec3Array(cp), cq.x, cq.y, cq.z, cq.w, ...vec3Array(cs)],
          [...vec3Array(tp), tq.x, tq.y, tq.z, tq.w, ...vec3Array(ts)]
        )
      })
    })
  })

  it('a singular matrix inverts to zero, as three does', () => {
    const m = new Matrix4().set(1, 2, 3, 4, 2, 4, 6, 8, 0, 0, 1, 0, 0, 0, 0, 1)
    expectBitExact(
      'invert-singular',
      mat4From(m).invert().elements,
      m.clone().invert().elements
    )
  })

  it('lookAt, including the parallel-up fallback', () => {
    const up = new Vector3(0, 1, 0)
    const cases: [Vector3, Vector3][] = [
      [new Vector3(0, 0, 0), new Vector3(r(), r(), r())],
      [new Vector3(r(1e6), r(1e6), r(1e6)), new Vector3(r(1e6), 0, r(1e6))],
      // eye == target and target straight above, the two degenerate branches
      [new Vector3(1, 2, 3), new Vector3(1, 2, 3)],
      [new Vector3(0, 0, 0), new Vector3(0, 5, 0)]
    ]
    cases.forEach(([eye, target], i) => {
      const t = new Matrix4().lookAt(eye, target, up)
      const c = new Mat4().lookAt(vec3From(eye), vec3From(target), vec3From(up))
      expectBitExact(`lookAt-${i}`, c.elements, t.elements)
    })
    const zUp = new Vector3(0, 0, 1)
    const t = new Matrix4().lookAt(new Vector3(), new Vector3(0, 0, 4), zUp)
    const c = new Mat4().lookAt(
      new Vec3(),
      new Vec3(0, 0, 4),
      new Vec3(0, 0, 1)
    )
    expectBitExact('lookAt-zUp', c.elements, t.elements)
  })

  it('perspective and orthographic in both coordinate systems', () => {
    const args = [-0.83, 0.91, 0.47, -0.52, 100, 1e7] as const
    expectBitExact(
      'perspective-webgpu',
      new Mat4().makePerspective(...args, 'webgpu').elements,
      new Matrix4().makePerspective(...args, WebGPUCoordinateSystem).elements
    )
    expectBitExact(
      'perspective-webgl',
      new Mat4().makePerspective(...args).elements,
      new Matrix4().makePerspective(...args).elements
    )
    const ortho = [-3001.5, 3001.5, 3001.5, -3001.5, -0, 6003] as const
    expectBitExact(
      'ortho-webgl',
      new Mat4().makeOrthographic(...ortho).elements,
      new Matrix4().makeOrthographic(...ortho).elements
    )
    expectBitExact(
      'ortho-webgpu',
      new Mat4().makeOrthographic(...ortho, 'webgpu').elements,
      new Matrix4().makeOrthographic(...ortho, WebGPUCoordinateSystem).elements
    )
  })

  it('vectors: applyMatrix4 with divide, applyMatrix3, quaternions', () => {
    for (let i = 0; i < 32; ++i) {
      const m = randomThreeMatrix()
      const proj = new Matrix4().makePerspective(
        -1,
        1,
        0.6,
        -0.6,
        100,
        1e6,
        WebGPUCoordinateSystem
      )
      const v = new Vector3(r(1e4), r(1e4), r(1e4))
      expectBitExact(
        `applyMatrix4-${i}`,
        vec3Array(
          vec3From(v).applyMatrix4(mat4From(proj).multiply(mat4From(m)))
        ),
        vec3Array(v.clone().applyMatrix4(proj.clone().multiply(m)))
      )
      const m3 = new Matrix3().setFromMatrix4(m)
      expectBitExact(
        `applyMatrix3-${i}`,
        vec3Array(
          vec3From(v).applyMatrix3(new Mat3().setFromMatrix4(mat4From(m)))
        ),
        vec3Array(v.clone().applyMatrix3(m3))
      )
      const v4 = new Vector4(v.x, v.y, v.z, 0).applyMatrix4(m)
      const c4 = new Vec4(v.x, v.y, v.z, 0).applyMatrix4(mat4From(m))
      expectBitExact(
        `vec4-${i}`,
        [c4.x, c4.y, c4.z, c4.w],
        [v4.x, v4.y, v4.z, v4.w]
      )
      const axis = new Vector3(r(), r(), r()).normalize()
      const angle = r(Math.PI)
      const q = new Quaternion().setFromAxisAngle(axis, angle)
      const cq = new Quat().setFromAxisAngle(vec3From(axis), angle)
      expectBitExact(
        `quat-${i}`,
        [cq.x, cq.y, cq.z, cq.w],
        [q.x, q.y, q.z, q.w]
      )
      expectBitExact(
        `applyQuaternion-${i}`,
        vec3Array(vec3From(v).applyQuaternion(cq)),
        vec3Array(v.clone().applyQuaternion(q))
      )
      expectBitExact(
        `compose-${i}`,
        new Mat4().compose(vec3From(v), cq, new Vec3(1, 2, 3)).elements,
        new Matrix4().compose(v, q, new Vector3(1, 2, 3)).elements
      )
      const w = new Vector3(r(), r(), r())
      expectBitExact(
        `vector-ops-${i}`,
        [
          ...vec3Array(vec3From(v).normalize()),
          vec3From(v).distanceTo(vec3From(w)),
          ...vec3Array(new Vec3().crossVectors(vec3From(v), vec3From(w))),
          ...vec3Array(new Vec3().lerpVectors(vec3From(v), vec3From(w), 0.3)),
          ...vec3Array(vec3From(v).lerp(vec3From(w), 0.7))
        ],
        [
          ...vec3Array(v.clone().normalize()),
          v.distanceTo(w),
          ...vec3Array(new Vector3().crossVectors(v, w)),
          ...vec3Array(new Vector3().lerpVectors(v, w, 0.3)),
          ...vec3Array(v.clone().lerp(w, 0.7))
        ]
      )
    }
  })
})
