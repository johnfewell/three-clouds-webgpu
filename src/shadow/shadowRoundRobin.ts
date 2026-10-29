// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// Opt-in round-robin cascade updates (experimental.shadowRoundRobin). Each
// shadow update re-renders one cascade and reuses the others with the matrices
// they were rendered with, so the atlas and its lookups stay a consistent set

import { Matrix4, Vector3, Vector4 } from 'three'

export interface RoundRobinCascade {
  readonly matrix: Matrix4
  readonly inverseMatrix: Matrix4
}

// A reused cascade is dropped once the centre of its fresh fit lands this far
// from the centre of its old map, in clip units (the map spans -1..1)
export const ROUND_ROBIN_MAX_DRIFT = 0.25

// Cosine of the largest sun turn a reused cascade tolerates, 0.25 degrees
export const ROUND_ROBIN_MIN_SUN_COS = Math.cos((0.25 * Math.PI) / 180)

const point = new Vector4()

export class ShadowRoundRobin {
  private next = 0
  private count = 0
  private readonly matrices: Matrix4[] = []
  private readonly inverseMatrices: Matrix4[] = []
  private readonly sunDirections: Vector3[] = []

  // Forget every cascade, so the next update renders all of them
  invalidate(): void {
    this.count = 0
    this.next = 0
  }

  // The one cascade to render this update, or null to render all. Call after
  // the cascades were refit. Every other cascade gets its stored matrices back
  plan(
    cascades: readonly RoundRobinCascade[],
    count: number,
    sunDirection: Vector3,
    forceAll: boolean
  ): number | null {
    if (forceAll || count < 2 || this.count !== count) return null
    for (let i = 0; i < count; i++) {
      if (this.drifted(cascades[i]!, i, sunDirection)) return null
    }
    const only = this.next % count
    this.next = (only + 1) % count
    for (let i = 0; i < count; i++) {
      if (i === only) continue
      cascades[i]!.matrix.copy(this.matrices[i]!)
      cascades[i]!.inverseMatrix.copy(this.inverseMatrices[i]!)
    }
    return only
  }

  // Store what was rendered: every cascade when `only` is null
  record(
    cascades: readonly RoundRobinCascade[],
    count: number,
    sunDirection: Vector3,
    only: number | null
  ): void {
    while (this.matrices.length < count) {
      this.matrices.push(new Matrix4())
      this.inverseMatrices.push(new Matrix4())
      this.sunDirections.push(new Vector3())
    }
    for (let i = 0; i < count; i++) {
      if (only != null && i !== only) continue
      this.matrices[i]!.copy(cascades[i]!.matrix)
      this.inverseMatrices[i]!.copy(cascades[i]!.inverseMatrix)
      this.sunDirections[i]!.copy(sunDirection)
    }
    if (only == null) {
      this.count = count
      this.next = 0
    }
  }

  private drifted(
    fresh: RoundRobinCascade,
    i: number,
    sunDirection: Vector3
  ): boolean {
    if (this.sunDirections[i]!.dot(sunDirection) < ROUND_ROBIN_MIN_SUN_COS) {
      return true
    }
    // The fresh fit's centre, seen through the map this cascade still holds
    point.set(0, 0, 0, 1).applyMatrix4(fresh.inverseMatrix)
    point.divideScalar(point.w).applyMatrix4(this.matrices[i]!)
    const x = point.x / point.w
    const y = point.y / point.w
    return Math.max(Math.abs(x), Math.abs(y)) > ROUND_ROBIN_MAX_DRIFT
  }
}
