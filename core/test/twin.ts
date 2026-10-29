// CPU-twin helpers: the core's values against the three package's on the same
// inputs. Test-only, so this file may import three

import type { Matrix4, Quaternion, Vector3 } from 'three'

import { log } from '../../test/helpers/log'
import { Mat4, Quat, Vec3 } from '../src/cpu/math'

export function mat4From(m: Matrix4): Mat4 {
  return new Mat4().fromArray(m.elements)
}

export function vec3From(v: Vector3): Vec3 {
  return new Vec3(v.x, v.y, v.z)
}

export function quatFrom(q: Quaternion): Quat {
  return new Quat(q.x, q.y, q.z, q.w)
}

// Float64 identity per element, which implies identical float32 uploads
// Object.is so that -0 against 0 and NaN against NaN are judged exactly
export function bitDiff(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>
): { mismatches: number; maxAbs: number; f32Mismatches: number } {
  let mismatches = 0
  let f32Mismatches = 0
  let maxAbs = 0
  const n = Math.max(actual.length, expected.length)
  for (let i = 0; i < n; ++i) {
    const a = actual[i]
    const e = expected[i]
    if (!Object.is(a, e)) mismatches++
    if (!Object.is(Math.fround(a ?? NaN), Math.fround(e ?? NaN))) {
      f32Mismatches++
    }
    if (a != null && e != null) maxAbs = Math.max(maxAbs, Math.abs(a - e))
  }
  return { mismatches, maxAbs, f32Mismatches }
}

// Logs the comparison and asserts float64 identity
export function expectBitExact(
  scope: string,
  actual: ArrayLike<number>,
  expected: ArrayLike<number>
): void {
  const diff = bitDiff(actual, expected)
  log(scope, { length: expected.length, ...diff })
  expect(diff).toEqual({ mismatches: 0, maxAbs: 0, f32Mismatches: 0 })
}

export function vec3Array(v: { x: number; y: number; z: number }): number[] {
  return [v.x, v.y, v.z]
}

// Deterministic inputs, so a failure reproduces
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
