// Ported from three.js r185 src/math (MIT, Copyright (c) 2010-2026 three.js authors)
// https://github.com/mrdoob/three.js/tree/r185/src/math
// Only the methods the CPU state calls, each with three's exact operation
// order, so every float64 result and its float32 upload match the port's

export class Vec2 {
  constructor(
    public x = 0,
    public y = 0
  ) {}

  set(x: number, y: number): this {
    this.x = x
    this.y = y
    return this
  }

  copy(v: Vec2): this {
    this.x = v.x
    this.y = v.y
    return this
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y)
  }

  addScaledVector(v: Vec2, s: number): this {
    this.x += v.x * s
    this.y += v.y * s
    return this
  }
}

export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  setScalar(s: number): this {
    this.x = s
    this.y = s
    this.z = s
    return this
  }

  copy(v: Vec3): this {
    this.x = v.x
    this.y = v.y
    this.z = v.z
    return this
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z)
  }

  add(v: Vec3): this {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }

  addVectors(a: Vec3, b: Vec3): this {
    this.x = a.x + b.x
    this.y = a.y + b.y
    this.z = a.z + b.z
    return this
  }

  addScaledVector(v: Vec3, s: number): this {
    this.x += v.x * s
    this.y += v.y * s
    this.z += v.z * s
    return this
  }

  sub(v: Vec3): this {
    this.x -= v.x
    this.y -= v.y
    this.z -= v.z
    return this
  }

  subVectors(a: Vec3, b: Vec3): this {
    this.x = a.x - b.x
    this.y = a.y - b.y
    this.z = a.z - b.z
    return this
  }

  multiply(v: Vec3): this {
    this.x *= v.x
    this.y *= v.y
    this.z *= v.z
    return this
  }

  multiplyVectors(a: Vec3, b: Vec3): this {
    this.x = a.x * b.x
    this.y = a.y * b.y
    this.z = a.z * b.z
    return this
  }

  multiplyScalar(s: number): this {
    this.x *= s
    this.y *= s
    this.z *= s
    return this
  }

  divideScalar(s: number): this {
    return this.multiplyScalar(1 / s)
  }

  negate(): this {
    this.x = -this.x
    this.y = -this.y
    this.z = -this.z
    return this
  }

  min(v: Vec3): this {
    this.x = Math.min(this.x, v.x)
    this.y = Math.min(this.y, v.y)
    this.z = Math.min(this.z, v.z)
    return this
  }

  max(v: Vec3): this {
    this.x = Math.max(this.x, v.x)
    this.y = Math.max(this.y, v.y)
    this.z = Math.max(this.z, v.z)
    return this
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
  }

  normalize(): this {
    return this.divideScalar(this.length() || 1)
  }

  distanceTo(v: Vec3): number {
    const dx = this.x - v.x
    const dy = this.y - v.y
    const dz = this.z - v.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  crossVectors(a: Vec3, b: Vec3): this {
    const ax = a.x
    const ay = a.y
    const az = a.z
    const bx = b.x
    const by = b.y
    const bz = b.z
    this.x = ay * bz - az * by
    this.y = az * bx - ax * bz
    this.z = ax * by - ay * bx
    return this
  }

  cross(v: Vec3): this {
    return this.crossVectors(this, v)
  }

  lerp(v: Vec3, alpha: number): this {
    this.x += (v.x - this.x) * alpha
    this.y += (v.y - this.y) * alpha
    this.z += (v.z - this.z) * alpha
    return this
  }

  lerpVectors(v1: Vec3, v2: Vec3, alpha: number): this {
    this.x = v1.x + (v2.x - v1.x) * alpha
    this.y = v1.y + (v2.y - v1.y) * alpha
    this.z = v1.z + (v2.z - v1.z) * alpha
    return this
  }

  applyMatrix3(m: Mat3): this {
    const x = this.x
    const y = this.y
    const z = this.z
    const e = m.elements
    this.x = e[0]! * x + e[3]! * y + e[6]! * z
    this.y = e[1]! * x + e[4]! * y + e[7]! * z
    this.z = e[2]! * x + e[5]! * y + e[8]! * z
    return this
  }

  // With the perspective divide, as three's Vector3.applyMatrix4
  applyMatrix4(m: Mat4): this {
    const x = this.x
    const y = this.y
    const z = this.z
    const e = m.elements
    const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!)
    this.x = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * w
    this.y = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * w
    this.z = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * w
    return this
  }

  applyQuaternion(q: Quat): this {
    const vx = this.x
    const vy = this.y
    const vz = this.z
    const qx = q.x
    const qy = q.y
    const qz = q.z
    const qw = q.w
    const tx = 2 * (qy * vz - qz * vy)
    const ty = 2 * (qz * vx - qx * vz)
    const tz = 2 * (qx * vy - qy * vx)
    this.x = vx + qw * tx + qy * tz - qz * ty
    this.y = vy + qw * ty + qz * tx - qx * tz
    this.z = vz + qw * tz + qx * ty - qy * tx
    return this
  }

  setFromMatrixPosition(m: Mat4): this {
    const e = m.elements
    this.x = e[12]!
    this.y = e[13]!
    this.z = e[14]!
    return this
  }
}

export class Vec4 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0
  ) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
    return this
  }

  // No perspective divide, as three's Vector4.applyMatrix4
  applyMatrix4(m: Mat4): this {
    const x = this.x
    const y = this.y
    const z = this.z
    const w = this.w
    const e = m.elements
    this.x = e[0]! * x + e[4]! * y + e[8]! * z + e[12]! * w
    this.y = e[1]! * x + e[5]! * y + e[9]! * z + e[13]! * w
    this.z = e[2]! * x + e[6]! * y + e[10]! * z + e[14]! * w
    this.w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]! * w
    return this
  }
}

export class Quat {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1
  ) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
    return this
  }

  identity(): this {
    return this.set(0, 0, 0, 1)
  }

  // Assumes the upper 3x3 of m is a pure rotation
  setFromRotationMatrix(m: Mat4): this {
    const te = m.elements
    const m11 = te[0]!
    const m12 = te[4]!
    const m13 = te[8]!
    const m21 = te[1]!
    const m22 = te[5]!
    const m23 = te[9]!
    const m31 = te[2]!
    const m32 = te[6]!
    const m33 = te[10]!
    const trace = m11 + m22 + m33
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0)
      return this.set(
        (m32 - m23) * s,
        (m13 - m31) * s,
        (m21 - m12) * s,
        0.25 / s
      )
    }
    if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33)
      return this.set(
        0.25 * s,
        (m12 + m21) / s,
        (m13 + m31) / s,
        (m32 - m23) / s
      )
    }
    if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33)
      return this.set(
        (m12 + m21) / s,
        0.25 * s,
        (m23 + m32) / s,
        (m13 - m31) / s
      )
    }
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22)
    return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)
  }

  setFromAxisAngle(axis: Vec3, angle: number): this {
    const halfAngle = angle / 2
    const s = Math.sin(halfAngle)
    this.x = axis.x * s
    this.y = axis.y * s
    this.z = axis.z * s
    this.w = Math.cos(halfAngle)
    return this
  }
}

// Row-major arguments, column-major storage, as three's Matrix3
export class Mat3 {
  readonly elements: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]

  // Row-major arguments, as three's Matrix3.set
  set(
    n11: number,
    n12: number,
    n13: number,
    n21: number,
    n22: number,
    n23: number,
    n31: number,
    n32: number,
    n33: number
  ): this {
    const te = this.elements
    te[0] = n11
    te[1] = n21
    te[2] = n31
    te[3] = n12
    te[4] = n22
    te[5] = n32
    te[6] = n13
    te[7] = n23
    te[8] = n33
    return this
  }

  // Texture.updateMatrix's transform. At the defaults it is the identity
  // with a -0 in element 1, which a bit-exact upload must keep
  setUvTransform(
    tx: number,
    ty: number,
    sx: number,
    sy: number,
    rotation: number,
    cx: number,
    cy: number
  ): this {
    const c = Math.cos(rotation)
    const s = Math.sin(rotation)
    return this.set(
      sx * c,
      sx * s,
      -sx * (c * cx + s * cy) + cx + tx,
      -sy * s,
      sy * c,
      -sy * (-s * cx + c * cy) + cy + ty,
      0,
      0,
      1
    )
  }

  // The upper-left 3x3, as three's Matrix3.setFromMatrix4
  setFromMatrix4(m: Mat4): this {
    const me = m.elements
    const te = this.elements
    te[0] = me[0]!
    te[1] = me[1]!
    te[2] = me[2]!
    te[3] = me[4]!
    te[4] = me[5]!
    te[5] = me[6]!
    te[6] = me[8]!
    te[7] = me[9]!
    te[8] = me[10]!
    return this
  }
}

const _x = /*#__PURE__*/ new Vec3()
const _y = /*#__PURE__*/ new Vec3()
const _z = /*#__PURE__*/ new Vec3()

// Column-major storage, as three's Matrix4 and WGSL's mat4x4f
export class Mat4 {
  readonly elements: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

  // Row-major arguments, as three's Matrix4.set
  set(
    n11: number,
    n12: number,
    n13: number,
    n14: number,
    n21: number,
    n22: number,
    n23: number,
    n24: number,
    n31: number,
    n32: number,
    n33: number,
    n34: number,
    n41: number,
    n42: number,
    n43: number,
    n44: number
  ): this {
    const te = this.elements
    te[0] = n11
    te[4] = n12
    te[8] = n13
    te[12] = n14
    te[1] = n21
    te[5] = n22
    te[9] = n23
    te[13] = n24
    te[2] = n31
    te[6] = n32
    te[10] = n33
    te[14] = n34
    te[3] = n41
    te[7] = n42
    te[11] = n43
    te[15] = n44
    return this
  }

  identity(): this {
    return this.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
  }

  copy(m: Mat4): this {
    const te = this.elements
    const me = m.elements
    for (let i = 0; i < 16; ++i) te[i] = me[i]!
    return this
  }

  clone(): Mat4 {
    return new Mat4().copy(this)
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    const te = this.elements
    for (let i = 0; i < 16; ++i) te[i] = array[i + offset]!
    return this
  }

  makeBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): this {
    return this.set(
      xAxis.x,
      yAxis.x,
      zAxis.x,
      0,
      xAxis.y,
      yAxis.y,
      zAxis.y,
      0,
      xAxis.z,
      yAxis.z,
      zAxis.z,
      0,
      0,
      0,
      0,
      1
    )
  }

  makeTranslation(x: number, y: number, z: number): this {
    return this.set(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1)
  }

  setPosition(v: Vec3): this {
    const te = this.elements
    te[12] = v.x
    te[13] = v.y
    te[14] = v.z
    return this
  }

  // Writes the rotation part only, as three's Matrix4.lookAt
  lookAt(eye: Vec3, target: Vec3, up: Vec3): this {
    const te = this.elements
    _z.subVectors(eye, target)
    if (_z.lengthSq() === 0) {
      _z.z = 1
    }
    _z.normalize()
    _x.crossVectors(up, _z)
    if (_x.lengthSq() === 0) {
      if (Math.abs(up.z) === 1) {
        _z.x += 0.0001
      } else {
        _z.z += 0.0001
      }
      _z.normalize()
      _x.crossVectors(up, _z)
    }
    _x.normalize()
    _y.crossVectors(_z, _x)
    te[0] = _x.x
    te[4] = _y.x
    te[8] = _z.x
    te[1] = _x.y
    te[5] = _y.y
    te[9] = _z.y
    te[2] = _x.z
    te[6] = _y.z
    te[10] = _z.z
    return this
  }

  multiply(m: Mat4): this {
    return this.multiplyMatrices(this, m)
  }

  premultiply(m: Mat4): this {
    return this.multiplyMatrices(m, this)
  }

  multiplyMatrices(a: Mat4, b: Mat4): this {
    const ae = a.elements
    const be = b.elements
    const te = this.elements
    const a11 = ae[0]!
    const a12 = ae[4]!
    const a13 = ae[8]!
    const a14 = ae[12]!
    const a21 = ae[1]!
    const a22 = ae[5]!
    const a23 = ae[9]!
    const a24 = ae[13]!
    const a31 = ae[2]!
    const a32 = ae[6]!
    const a33 = ae[10]!
    const a34 = ae[14]!
    const a41 = ae[3]!
    const a42 = ae[7]!
    const a43 = ae[11]!
    const a44 = ae[15]!
    const b11 = be[0]!
    const b12 = be[4]!
    const b13 = be[8]!
    const b14 = be[12]!
    const b21 = be[1]!
    const b22 = be[5]!
    const b23 = be[9]!
    const b24 = be[13]!
    const b31 = be[2]!
    const b32 = be[6]!
    const b33 = be[10]!
    const b34 = be[14]!
    const b41 = be[3]!
    const b42 = be[7]!
    const b43 = be[11]!
    const b44 = be[15]!
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44
    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44
    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44
    return this
  }

  transpose(): this {
    const te = this.elements
    let tmp: number
    tmp = te[1]!
    te[1] = te[4]!
    te[4] = tmp
    tmp = te[2]!
    te[2] = te[8]!
    te[8] = tmp
    tmp = te[6]!
    te[6] = te[9]!
    te[9] = tmp
    tmp = te[3]!
    te[3] = te[12]!
    te[12] = tmp
    tmp = te[7]!
    te[7] = te[13]!
    te[13] = tmp
    tmp = te[11]!
    te[11] = te[14]!
    te[14] = tmp
    return this
  }

  // three's analytic inverse (after gl-matrix). A singular matrix becomes zero
  invert(): this {
    const te = this.elements
    const n11 = te[0]!
    const n21 = te[1]!
    const n31 = te[2]!
    const n41 = te[3]!
    const n12 = te[4]!
    const n22 = te[5]!
    const n32 = te[6]!
    const n42 = te[7]!
    const n13 = te[8]!
    const n23 = te[9]!
    const n33 = te[10]!
    const n43 = te[11]!
    const n14 = te[12]!
    const n24 = te[13]!
    const n34 = te[14]!
    const n44 = te[15]!
    const t1 = n11 * n22 - n21 * n12
    const t2 = n11 * n32 - n31 * n12
    const t3 = n11 * n42 - n41 * n12
    const t4 = n21 * n32 - n31 * n22
    const t5 = n21 * n42 - n41 * n22
    const t6 = n31 * n42 - n41 * n32
    const t7 = n13 * n24 - n23 * n14
    const t8 = n13 * n34 - n33 * n14
    const t9 = n13 * n44 - n43 * n14
    const t10 = n23 * n34 - n33 * n24
    const t11 = n23 * n44 - n43 * n24
    const t12 = n33 * n44 - n43 * n34
    const det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7
    if (det === 0) {
      return this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    }
    const detInv = 1 / det
    te[0] = (n22 * t12 - n32 * t11 + n42 * t10) * detInv
    te[1] = (n31 * t11 - n21 * t12 - n41 * t10) * detInv
    te[2] = (n24 * t6 - n34 * t5 + n44 * t4) * detInv
    te[3] = (n33 * t5 - n23 * t6 - n43 * t4) * detInv
    te[4] = (n32 * t9 - n12 * t12 - n42 * t8) * detInv
    te[5] = (n11 * t12 - n31 * t9 + n41 * t8) * detInv
    te[6] = (n34 * t3 - n14 * t6 - n44 * t2) * detInv
    te[7] = (n13 * t6 - n33 * t3 + n43 * t2) * detInv
    te[8] = (n12 * t11 - n22 * t9 + n42 * t7) * detInv
    te[9] = (n21 * t9 - n11 * t11 - n41 * t7) * detInv
    te[10] = (n14 * t5 - n24 * t3 + n44 * t1) * detInv
    te[11] = (n23 * t3 - n13 * t5 - n43 * t1) * detInv
    te[12] = (n22 * t8 - n12 * t10 - n32 * t7) * detInv
    te[13] = (n11 * t10 - n21 * t8 + n31 * t7) * detInv
    te[14] = (n24 * t2 - n14 * t4 - n34 * t1) * detInv
    te[15] = (n13 * t4 - n23 * t2 + n33 * t1) * detInv
    return this
  }

  determinantAffine(): number {
    const te = this.elements
    const n11 = te[0]!
    const n12 = te[4]!
    const n13 = te[8]!
    const n21 = te[1]!
    const n22 = te[5]!
    const n23 = te[9]!
    const n31 = te[2]!
    const n32 = te[6]!
    const n33 = te[10]!
    return (
      n11 * (n22 * n33 - n23 * n32) -
      n12 * (n21 * n33 - n23 * n31) +
      n13 * (n21 * n32 - n22 * n31)
    )
  }

  decompose(position: Vec3, quaternion: Quat, scale: Vec3): this {
    const te = this.elements
    position.x = te[12]!
    position.y = te[13]!
    position.z = te[14]!
    const det = this.determinantAffine()
    if (det === 0) {
      scale.set(1, 1, 1)
      quaternion.identity()
      return this
    }
    let sx = _x.set(te[0]!, te[1]!, te[2]!).length()
    const sy = _x.set(te[4]!, te[5]!, te[6]!).length()
    const sz = _x.set(te[8]!, te[9]!, te[10]!).length()
    if (det < 0) sx = -sx
    const m = _m1.copy(this)
    const me = m.elements
    const invSX = 1 / sx
    const invSY = 1 / sy
    const invSZ = 1 / sz
    me[0]! *= invSX
    me[1]! *= invSX
    me[2]! *= invSX
    me[4]! *= invSY
    me[5]! *= invSY
    me[6]! *= invSY
    me[8]! *= invSZ
    me[9]! *= invSZ
    me[10]! *= invSZ
    quaternion.setFromRotationMatrix(m)
    scale.x = sx
    scale.y = sy
    scale.z = sz
    return this
  }

  compose(position: Vec3, quaternion: Quat, scale: Vec3): this {
    const te = this.elements
    const x = quaternion.x
    const y = quaternion.y
    const z = quaternion.z
    const w = quaternion.w
    const x2 = x + x
    const y2 = y + y
    const z2 = z + z
    const xx = x * x2
    const xy = x * y2
    const xz = x * z2
    const yy = y * y2
    const yz = y * z2
    const zz = z * z2
    const wx = w * x2
    const wy = w * y2
    const wz = w * z2
    const sx = scale.x
    const sy = scale.y
    const sz = scale.z
    te[0] = (1 - (yy + zz)) * sx
    te[1] = (xy + wz) * sx
    te[2] = (xz - wy) * sx
    te[3] = 0
    te[4] = (xy - wz) * sy
    te[5] = (1 - (xx + zz)) * sy
    te[6] = (yz + wx) * sy
    te[7] = 0
    te[8] = (xz + wy) * sz
    te[9] = (yz - wx) * sz
    te[10] = (1 - (xx + yy)) * sz
    te[11] = 0
    te[12] = position.x
    te[13] = position.y
    te[14] = position.z
    te[15] = 1
    return this
  }

  // The WebGPU form: clip z in [0, 1]. three's default (WebGL) is [-1, 1]
  makePerspective(
    left: number,
    right: number,
    top: number,
    bottom: number,
    near: number,
    far: number,
    coordinateSystem: CoordinateSystem = 'webgl'
  ): this {
    const te = this.elements
    const x = (2 * near) / (right - left)
    const y = (2 * near) / (top - bottom)
    const a = (right + left) / (right - left)
    const b = (top + bottom) / (top - bottom)
    const c =
      coordinateSystem === 'webgl'
        ? -(far + near) / (far - near)
        : -far / (far - near)
    const d =
      coordinateSystem === 'webgl'
        ? (-2 * far * near) / (far - near)
        : (-far * near) / (far - near)
    te[0] = x
    te[4] = 0
    te[8] = a
    te[12] = 0
    te[1] = 0
    te[5] = y
    te[9] = b
    te[13] = 0
    te[2] = 0
    te[6] = 0
    te[10] = c
    te[14] = d
    te[3] = 0
    te[7] = 0
    te[11] = -1
    te[15] = 0
    return this
  }

  makeOrthographic(
    left: number,
    right: number,
    top: number,
    bottom: number,
    near: number,
    far: number,
    coordinateSystem: CoordinateSystem = 'webgl'
  ): this {
    const te = this.elements
    const x = 2 / (right - left)
    const y = 2 / (top - bottom)
    const a = -(right + left) / (right - left)
    const b = -(top + bottom) / (top - bottom)
    const c =
      coordinateSystem === 'webgl' ? -2 / (far - near) : -1 / (far - near)
    const d =
      coordinateSystem === 'webgl'
        ? -(far + near) / (far - near)
        : -near / (far - near)
    te[0] = x
    te[4] = 0
    te[8] = 0
    te[12] = a
    te[1] = 0
    te[5] = y
    te[9] = 0
    te[13] = b
    te[2] = 0
    te[6] = 0
    te[10] = c
    te[14] = d
    te[3] = 0
    te[7] = 0
    te[11] = 0
    te[15] = 1
    return this
  }
}

const _m1 = /*#__PURE__*/ new Mat4()

// three's WebGLCoordinateSystem and WebGPUCoordinateSystem
export type CoordinateSystem = 'webgl' | 'webgpu'

// three's MathUtils.lerp, which takram's `lerp` re-exports
export function lerp(x: number, y: number, t: number): number {
  return (1 - t) * x + t * y
}

export const DEG2RAD = Math.PI / 180
