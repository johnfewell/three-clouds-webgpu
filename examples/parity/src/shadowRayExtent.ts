import { DataUtils } from 'three'

export interface ShadowRayExtentInput {
  width: number
  height: number
  inverseShadowMatrix: readonly number[]
  worldToECEFMatrix: readonly number[]
  altitudeCorrection: readonly [number, number, number]
  sunDirection: readonly [number, number, number]
  bottomRadius: number
  shadowTopHeight: number
  shadowBottomHeight: number
}

export interface ShadowRayExtentField {
  /** fp16-quantised `(rayFar - rayNear) / bottomRadius`, as the atlas stores it */
  unit: Float32Array
  /** fp16 codes two evaluations may differ by, per texel. See ulpAllowance */
  ulpAllowance: Float32Array
}

const f32 = Math.fround

function multiplyMatrixVector(
  matrix: readonly number[],
  x: number,
  y: number,
  z: number,
  w: number
): [number, number, number, number] {
  const component = (row: number): number =>
    f32(
      f32(
        f32(f32(f32(matrix[row]!) * x) + f32(f32(matrix[row + 4]!) * y)) +
          f32(f32(matrix[row + 8]!) * z)
      ) + f32(f32(matrix[row + 12]!) * w)
    )
  return [component(0), component(1), component(2), component(3)]
}

function dot3(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
): number {
  return f32(f32(f32(ax * bx) + f32(ay * by)) + f32(az * bz))
}

function sphereNear(
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  radius: number
): SphereNear {
  const b = dot3(dx, dy, dz, x, y, z)
  const distanceSquared = dot3(x, y, z, x, y, z)
  const c = f32(distanceSquared - f32(radius * radius))
  const discriminant = f32(f32(b * b) - c)
  if (discriminant < 0) return { b, discriminant, t: -1 }
  return {
    b,
    discriminant,
    t: f32(f32(-b) - f32(Math.sqrt(discriminant)))
  }
}

function quantizeFloat16(value: number): number {
  return DataUtils.fromHalfFloat(DataUtils.toHalfFloat(value))
}

interface SphereNear {
  b: number
  discriminant: number
  t: number
}

function f32Ulp(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0
  return 2 ** (Math.floor(Math.log2(Math.abs(value))) - 23)
}

// The smallest fp16 step is the subnormal 2^-24, and the right floor for a value
// that quantises to zero, where one code away IS one subnormal
function float16Ulp(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 2 ** -24
  return 2 ** (Math.floor(Math.log2(Math.abs(value))) - 10)
}

// 4096 fp16 codes is 2^-1 relative, so the cap reads as "no further than a
// factor of two apart": past that they are different numbers, not two roundings
// of one. Nothing measured needs more than 215.
const MAX_ULP_ALLOWANCE = 4096

/**
 * How many fp16 codes two evaluations of the same f32 expression may differ by.
 *
 * Both the shader and this twin run `t = -b - sqrt(b*b - c)` in f32, so they can
 * only differ by the rounding that expression carries. Where the extent is the
 * size of its operands that is the one code the fp16 store costs.
 *
 * Where the ray crosses a razor-thin shell the extent is a difference of two
 * nearly equal roots and the error is set by the OPERANDS: `b*b - c` rounds by
 * up to 1.5 ulp32(b^2), sqrt halves that, both shells add. Hardware disagreed
 * by 6 codes where this allows 211
 */
function ulpAllowance(
  operand: number,
  outerDiscriminant: number,
  innerDiscriminant: number,
  quantisedUnitValue: number,
  bottomRadius: number
): number {
  // A shell the ray misses or grazes exactly contributes no sqrt sensitivity:
  // the twin and the shader take the same -1 branch for it
  const sqrtError = (discriminant: number): number =>
    discriminant > 0
      ? (1.5 * f32Ulp(operand * operand)) / (2 * Math.sqrt(discriminant))
      : 0
  const extentErrorMetres =
    2 *
    (f32Ulp(operand) +
      sqrtError(outerDiscriminant) +
      sqrtError(innerDiscriminant))
  return Math.min(
    MAX_ULP_ALLOWANCE,
    Math.max(
      1,
      Math.ceil(
        extentErrorMetres / bottomRadius / float16Ulp(quantisedUnitValue)
      )
    )
  )
}

// shadow.frag:142–144 substitutes this when the ray misses the inner shell. It
// is a SHADOW quantity: clouds.maxRayDistance clamps the primary march and never
// bounds this attachment, and on hardware the two ceilings differ by 5x
export const SHADOW_RAY_FAR_FALLBACK = 1e6

/** The largest `rayFar - rayNear` any texel of the shadow march can be handed */
export function shadowRayExtentCeilingUnit(bottomRadius: number): number {
  return SHADOW_RAY_FAR_FALLBACK / bottomRadius
}

/** Reconstructs shadow.frag's per-texel `rayFar - rayNear` attachment value */
export function reconstructShadowRayExtent(
  input: ShadowRayExtentInput
): ShadowRayExtentField {
  const {
    width,
    height,
    inverseShadowMatrix,
    worldToECEFMatrix,
    altitudeCorrection,
    sunDirection,
    bottomRadius,
    shadowTopHeight,
    shadowBottomHeight
  } = input
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    inverseShadowMatrix.length !== 16 ||
    worldToECEFMatrix.length !== 16 ||
    !Number.isFinite(bottomRadius) ||
    bottomRadius <= 0
  ) {
    throw new Error('Invalid shadow ray-extent geometry')
  }

  const sunX = f32(sunDirection[0])
  const sunY = f32(sunDirection[1])
  const sunZ = f32(sunDirection[2])
  const directionLength = f32(Math.hypot(sunX, sunY, sunZ))
  if (!Number.isFinite(directionLength) || directionLength === 0) {
    throw new Error('Invalid shadow sun direction')
  }
  const dx = f32(-sunX / directionLength)
  const dy = f32(-sunY / directionLength)
  const dz = f32(-sunZ / directionLength)
  const radius = f32(bottomRadius)
  const outerRadius = f32(radius + f32(shadowTopHeight))
  const innerRadius = f32(radius + f32(shadowBottomHeight))
  const unit = new Float32Array(width * height)
  const ulpAllowanceField = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const clipY = f32(f32(((y + 0.5) / height) * 2) - 1)
    for (let x = 0; x < width; x++) {
      const clipX = f32(f32(((x + 0.5) / width) * 2) - 1)
      const point = multiplyMatrixVector(
        inverseShadowMatrix,
        clipX,
        clipY,
        -1,
        1
      )
      const inverseW = f32(1 / point[3])
      const worldPoint = multiplyMatrixVector(
        worldToECEFMatrix,
        f32(point[0] * inverseW),
        f32(point[1] * inverseW),
        f32(point[2] * inverseW),
        1
      )
      const px = f32(worldPoint[0] + f32(altitudeCorrection[0]))
      const py = f32(worldPoint[1] + f32(altitudeCorrection[1]))
      const pz = f32(worldPoint[2] + f32(altitudeCorrection[2]))
      const outer = sphereNear(px, py, pz, dx, dy, dz, outerRadius)
      const inner = sphereNear(px, py, pz, dx, dy, dz, innerRadius)
      const rayNear = Math.max(0, outer.t)
      // rayNear exceeds the fallback where a cascade texel's sun position sits
      // outside the outer shell, and the extent goes negative by the reference's
      // own arithmetic (28 such texels measured on hardware)
      const rayFar = inner.t < 0 ? SHADOW_RAY_FAR_FALLBACK : inner.t
      const index = y * width + x
      unit[index] = quantizeFloat16(f32(f32(rayFar - rayNear) / radius))
      ulpAllowanceField[index] = ulpAllowance(
        outer.b,
        outer.discriminant,
        inner.discriminant,
        unit[index],
        radius
      )
    }
  }
  return { unit, ulpAllowance: ulpAllowanceField }
}
