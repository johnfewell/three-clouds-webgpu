// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// Based on the following work with slight modifications
// https://github.com/StrandedKitty/three-csm/
// https://github.com/mrdoob/three.js/tree/r169/examples/jsm/csm

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * MIT License
 *
 * Copyright (c) 2019 vtHawk
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* eslint-enable no-comment-slop/max-comment-lines */

// The three.js generation named above, r169 examples/jsm/csm, is MIT too and
// its own notice travels with it
/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * The MIT License
 *
 * Copyright © 2010-2026 three.js authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
/* eslint-enable no-comment-slop/max-comment-lines */

// Cite: src/shadow/CascadedShadowMaps.ts, the port's copy, line for line on
// the core's math layer. Object3D.DEFAULT_UP is (0, 1, 0)

import type { CameraState } from './camera'
import { lerp, Mat4, Vec2, Vec3 } from './math'

// splitFrustum, GPU Gems 3 ch. 10
// See: https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-10-parallel-split-shadow-maps-programmable-gpus

export type FrustumSplitMode = 'uniform' | 'logarithmic' | 'practical'

export function splitFrustum(
  mode: FrustumSplitMode,
  count: number,
  near: number,
  far: number,
  lambda = 0.5,
  result: number[] = []
): number[] {
  for (let i = 0; i < count; ++i) {
    const uniform = (near + ((far - near) * (i + 1)) / count) / far
    const logarithmic = (near * (far / near) ** ((i + 1) / count)) / far
    result[i] =
      mode === 'uniform'
        ? uniform
        : mode === 'logarithmic'
          ? logarithmic
          : lerp(uniform, logarithmic, lambda)
  }
  result.length = count
  return result
}

type Corners = [Vec3, Vec3, Vec3, Vec3]

function corners(): Corners {
  return [new Vec3(), new Vec3(), new Vec3(), new Vec3()]
}

export class FrustumCorners {
  readonly near: Corners = corners()
  readonly far: Corners = corners()

  copy(other: FrustumCorners): this {
    for (let i = 0; i < 4; ++i) {
      this.near[i]!.copy(other.near[i]!)
      this.far[i]!.copy(other.far[i]!)
    }
    return this
  }

  setFromCamera(camera: CameraState, far: number): this {
    const inverseProjectionMatrix = camera.projectionMatrixInverse
    // The near plane's NDC z is 0 in WebGPU and -1 in WebGL
    const nearZ = camera.coordinateSystem === 'webgpu' ? 0 : -1

    // 3 --- 0
    // |     |
    // 2 --- 1
    this.near[0].set(1, 1, nearZ)
    this.near[1].set(1, -1, nearZ)
    this.near[2].set(-1, -1, nearZ)
    this.near[3].set(-1, 1, nearZ)
    for (let i = 0; i < 4; ++i) {
      this.near[i]!.applyMatrix4(inverseProjectionMatrix)
    }

    this.far[0].set(1, 1, 1)
    this.far[1].set(1, -1, 1)
    this.far[2].set(-1, -1, 1)
    this.far[3].set(-1, 1, 1)
    for (let i = 0; i < 4; ++i) {
      const corner = this.far[i]!
      corner.applyMatrix4(inverseProjectionMatrix)
      const absZ = Math.abs(corner.z)
      if (!camera.isPerspective) {
        corner.z *= Math.min(far / absZ, 1)
      } else {
        corner.multiplyScalar(Math.min(far / absZ, 1))
      }
    }
    return this
  }

  split(
    clipDepths: readonly number[],
    result: FrustumCorners[] = []
  ): FrustumCorners[] {
    for (let index = 0; index < clipDepths.length; ++index) {
      const frustum = (result[index] ??= new FrustumCorners())
      for (let i = 0; i < 4; ++i) {
        if (index === 0) {
          frustum.near[i]!.copy(this.near[i]!)
        } else {
          frustum.near[i]!.lerpVectors(
            this.near[i]!,
            this.far[i]!,
            clipDepths[index - 1]!
          )
        }
        if (index === clipDepths.length - 1) {
          frustum.far[i]!.copy(this.far[i]!)
        } else {
          frustum.far[i]!.lerpVectors(
            this.near[i]!,
            this.far[i]!,
            clipDepths[index]!
          )
        }
      }
    }
    result.length = clipDepths.length
    return result
  }

  applyMatrix4(matrix: Mat4): this {
    for (let i = 0; i < 4; ++i) {
      this.near[i]!.applyMatrix4(matrix)
      this.far[i]!.applyMatrix4(matrix)
    }
    return this
  }
}

export interface Cascade {
  readonly interval: Vec2
  readonly matrix: Mat4
  readonly inverseMatrix: Mat4
  readonly projectionMatrix: Mat4
  readonly inverseProjectionMatrix: Mat4
  readonly viewMatrix: Mat4
  readonly inverseViewMatrix: Mat4
}

export interface CascadedShadowMapsOptions {
  cascadeCount: number
  mapSize: Vec2
  maxFar?: number | null
  farScale?: number
  splitMode?: FrustumSplitMode
  splitLambda?: number
  margin?: number
  fade?: boolean
}

// The shadow shaders are built for at most this many cascades
export const MAX_CASCADE_COUNT = 4

const DEFAULT_UP = /*#__PURE__*/ new Vec3(0, 1, 0)
const vectorScratch1 = /*#__PURE__*/ new Vec3()
const vectorScratch2 = /*#__PURE__*/ new Vec3()
const frustumScratch = /*#__PURE__*/ new FrustumCorners()
const boxMin = /*#__PURE__*/ new Vec3()
const boxMax = /*#__PURE__*/ new Vec3()

function createCascade(): Cascade {
  return {
    interval: new Vec2(),
    matrix: new Mat4(),
    inverseMatrix: new Mat4(),
    projectionMatrix: new Mat4(),
    inverseProjectionMatrix: new Mat4(),
    viewMatrix: new Mat4(),
    inverseViewMatrix: new Mat4()
  }
}

export class CascadedShadowMaps {
  readonly cascades: Cascade[] = []
  readonly mapSize = new Vec2()
  maxFar: number | null
  farScale: number
  splitMode: FrustumSplitMode
  splitLambda: number
  margin: number
  fade: boolean

  private readonly cameraFrustum = new FrustumCorners()
  private readonly frusta: FrustumCorners[] = []
  private readonly splits: number[] = []
  // Module scratch in the port, which only ever writes their rotation part
  private readonly lightOrientationMatrix = new Mat4()
  private readonly cameraToLightMatrix = new Mat4()
  private _far = 0

  constructor(options: CascadedShadowMapsOptions) {
    this.cascadeCount = options.cascadeCount
    this.mapSize.copy(options.mapSize)
    this.maxFar = options.maxFar ?? null
    this.farScale = options.farScale ?? 1
    this.splitMode = options.splitMode ?? 'practical'
    this.splitLambda = options.splitLambda ?? 0.5
    this.margin = options.margin ?? 0
    this.fade = options.fade ?? true
  }

  get cascadeCount(): number {
    return this.cascades.length
  }

  set cascadeCount(value: number) {
    for (let i = 0; i < value; ++i) {
      this.cascades[i] ??= createCascade()
    }
    this.cascades.length = value
  }

  get far(): number {
    return this._far
  }

  private updateIntervals(camera: CameraState): void {
    const cascadeCount = this.cascadeCount
    const splits = this.splits
    splitFrustum(
      this.splitMode,
      cascadeCount,
      camera.near,
      this.far,
      this.splitLambda,
      splits
    )
    this.cameraFrustum.setFromCamera(camera, this.far)
    this.cameraFrustum.split(splits, this.frusta)
    for (let i = 0; i < cascadeCount; ++i) {
      this.cascades[i]!.interval.set(splits[i - 1] ?? 0, splits[i] ?? 0)
    }
  }

  private getFrustumRadius(
    camera: CameraState,
    frustum: FrustumCorners
  ): number {
    const nearCorners = frustum.near
    const farCorners = frustum.far
    let diagonalLength = Math.max(
      farCorners[0].distanceTo(farCorners[2]),
      farCorners[0].distanceTo(nearCorners[2])
    )
    if (this.fade) {
      const near = camera.near
      const far = this.far
      const distance = farCorners[0].z / (far - near)
      diagonalLength += 0.25 * distance ** 2 * (far - near)
    }
    return diagonalLength * 0.5
  }

  // The light-space centre of a frustum, snapped to the cascade's texels
  private snappedCenter(frustum: FrustumCorners, radius: number): Vec3 {
    const { near, far } = frustumScratch
      .copy(frustum)
      .applyMatrix4(this.cameraToLightMatrix)
    boxMin.setScalar(Infinity)
    boxMax.setScalar(-Infinity)
    for (let j = 0; j < 4; j++) {
      boxMin.min(near[j]!).min(far[j]!)
      boxMax.max(near[j]!).max(far[j]!)
    }
    // Box3.getCenter on a non-empty box
    const center = vectorScratch1.addVectors(boxMin, boxMax).multiplyScalar(0.5)
    center.z = boxMax.z + this.margin
    const texelWidth = (radius - -radius) / this.mapSize.x
    const texelHeight = (radius - -radius) / this.mapSize.y
    center.x = Math.round(center.x / texelWidth) * texelWidth
    center.y = Math.round(center.y / texelHeight) * texelHeight
    return center
  }

  private updateMatrices(
    camera: CameraState,
    sunDirection: Vec3,
    distance = 1
  ): void {
    const lightOrientationMatrix = this.lightOrientationMatrix.lookAt(
      vectorScratch1.setScalar(0),
      vectorScratch2.copy(sunDirection).multiplyScalar(-1),
      DEFAULT_UP
    )
    this.cameraToLightMatrix.multiplyMatrices(
      this.cameraToLightMatrix.copy(lightOrientationMatrix).invert(),
      camera.matrixWorld
    )

    for (let i = 0; i < this.frusta.length; ++i) {
      const frustum = this.frusta[i]!
      const cascade = this.cascades[i]!
      const radius = this.getFrustumRadius(camera, frustum)
      cascade.projectionMatrix.makeOrthographic(
        -radius,
        radius,
        radius,
        -radius,
        -this.margin,
        radius * 2 + this.margin
      )
      const center = this.snappedCenter(frustum, radius)
      center.applyMatrix4(lightOrientationMatrix)
      const position = vectorScratch2
        .copy(sunDirection)
        .multiplyScalar(distance)
        .add(center)
      cascade.inverseViewMatrix
        .lookAt(center, position, DEFAULT_UP)
        .setPosition(position)
    }
  }

  update(camera: CameraState, sunDirection: Vec3, distance?: number): void {
    this._far =
      this.maxFar != null
        ? Math.min(this.maxFar, camera.far * this.farScale)
        : camera.far * this.farScale

    this.updateIntervals(camera)
    this.updateMatrices(camera, sunDirection, distance)

    for (const cascade of this.cascades) {
      cascade.inverseProjectionMatrix.copy(cascade.projectionMatrix).invert()
      cascade.viewMatrix.copy(cascade.inverseViewMatrix).invert()
      cascade.matrix.copy(cascade.projectionMatrix).multiply(cascade.viewMatrix)
      cascade.inverseMatrix
        .copy(cascade.inverseViewMatrix)
        .multiply(cascade.inverseProjectionMatrix)
    }
  }
}

// getSunDistanceFudge, horizon fudge for shadow distance
// TODO(port): Position the sun on the top atmosphere sphere
export function getSunDistanceFudge(
  sunDirection: Vec3,
  surfaceNormal: Vec3
): number {
  const zenithAngle = sunDirection.dot(surfaceNormal)
  return lerp(1e6, 1e3, zenithAngle)
}
