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

import {
  Box3,
  Matrix4,
  Object3D,
  Vector2,
  Vector3,
  WebGPUCoordinateSystem,
  type Camera,
  type PerspectiveCamera
} from 'three'
import invariant from 'tiny-invariant'

import { lerp } from '@takram/three-geospatial'

// splitFrustum, GPU Gems 3 ch. 10
// See: https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-10-parallel-split-shadow-maps-programmable-gpus

export type FrustumSplitFunction = (
  length: number,
  near: number,
  far: number,
  lambda?: number,
  result?: number[]
) => number[]

export interface FrustumSplitFunctions {
  uniform: FrustumSplitFunction
  logarithmic: FrustumSplitFunction
  practical: FrustumSplitFunction
}

export type FrustumSplitMode = keyof FrustumSplitFunctions

const modes: FrustumSplitFunctions = {
  uniform: (count, near, far, _, result = []) => {
    for (let i = 0; i < count; ++i) {
      result[i] = (near + ((far - near) * (i + 1)) / count) / far
    }
    result.length = count
    return result
  },

  logarithmic: (count, near, far, _, result = []) => {
    for (let i = 0; i < count; ++i) {
      result[i] = (near * (far / near) ** ((i + 1) / count)) / far
    }
    result.length = count
    return result
  },

  practical: (count, near, far, lambda = 0.5, result = []) => {
    for (let i = 0; i < count; ++i) {
      const uniform = (near + ((far - near) * (i + 1)) / count) / far
      const logarithmic = (near * (far / near) ** ((i + 1) / count)) / far
      result[i] = lerp(uniform, logarithmic, lambda)
    }
    result.length = count
    return result
  }
}

export const frustumSplitFunctions = modes

export function splitFrustum(
  mode: FrustumSplitMode,
  count: number,
  near: number,
  far: number,
  lambda?: number,
  result: number[] = []
): number[] {
  return modes[mode](count, near, far, lambda, result)
}

// FrustumCorners

export class FrustumCorners {
  readonly near: [Vector3, Vector3, Vector3, Vector3] = [
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3()
  ]
  readonly far: [Vector3, Vector3, Vector3, Vector3] = [
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3()
  ]

  constructor()
  constructor(camera: Camera, far: number)
  constructor(camera?: Camera, far?: number) {
    if (camera != null && far != null) {
      this.setFromCamera(camera, far)
    }
  }

  clone(): FrustumCorners {
    return new FrustumCorners().copy(this)
  }

  copy(other: FrustumCorners): this {
    for (let i = 0; i < 4; ++i) {
      this.near[i]!.copy(other.near[i]!)
      this.far[i]!.copy(other.far[i]!)
    }
    return this
  }

  setFromCamera(camera: Camera, far: number): this {
    const isOrthographic =
      (camera as unknown as { isOrthographicCamera?: boolean })
        .isOrthographicCamera === true
    const inverseProjectionMatrix = camera.projectionMatrixInverse

    // The near plane's NDC z is -1 in WebGL and 0 in WebGPU. The reference's -1
    // unprojects to half the near distance under WebGPU: on shadow-plane with
    // near=100 it gave (41.45, 23.32, -50) against side A's (82.90, 46.63, -100)

    // getFrustumRadius is dominated by the far-plane diagonal, so the radius
    // stayed identical to side A's. The light-space bbox also spans the near
    // corners, so each cascade's centre moved

    // Texel snapping hid that in most configurations, but in
    // shadow-cascades-2x512 a Math.round flip moved a cascade one texel
    const nearZ = camera.reversedDepth
      ? 1
      : camera.coordinateSystem === WebGPUCoordinateSystem
        ? 0
        : -1
    const farZ = camera.reversedDepth ? 0 : 1

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

    this.far[0].set(1, 1, farZ)
    this.far[1].set(1, -1, farZ)
    this.far[2].set(-1, -1, farZ)
    this.far[3].set(-1, 1, farZ)
    for (let i = 0; i < 4; ++i) {
      const corner = this.far[i]!
      corner.applyMatrix4(inverseProjectionMatrix)
      const absZ = Math.abs(corner.z)
      if (isOrthographic) {
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
      if (index === 0) {
        for (let i = 0; i < 4; ++i) {
          frustum.near[i]!.copy(this.near[i]!)
        }
      } else {
        for (let i = 0; i < 4; ++i) {
          frustum.near[i]!.lerpVectors(
            this.near[i]!,
            this.far[i]!,
            clipDepths[index - 1]!
          )
        }
      }
      if (index === clipDepths.length - 1) {
        for (let i = 0; i < 4; ++i) {
          frustum.far[i]!.copy(this.far[i]!)
        }
      } else {
        for (let i = 0; i < 4; ++i) {
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

  applyMatrix4(matrix: Matrix4): this {
    for (let i = 0; i < 4; ++i) {
      this.near[i]!.applyMatrix4(matrix)
      this.far[i]!.applyMatrix4(matrix)
    }
    return this
  }
}

// CascadedShadowMaps

const vectorScratch1 = /*#__PURE__*/ new Vector3()
const vectorScratch2 = /*#__PURE__*/ new Vector3()
const matrixScratch1 = /*#__PURE__*/ new Matrix4()
const matrixScratch2 = /*#__PURE__*/ new Matrix4()
const frustumScratch = /*#__PURE__*/ new FrustumCorners()
const boxScratch = /*#__PURE__*/ new Box3()

export interface Cascade {
  readonly interval: Vector2
  readonly matrix: Matrix4
  readonly inverseMatrix: Matrix4
  readonly projectionMatrix: Matrix4
  readonly inverseProjectionMatrix: Matrix4
  readonly viewMatrix: Matrix4
  readonly inverseViewMatrix: Matrix4
}

export interface CascadedShadowMapsOptions {
  cascadeCount: number
  mapSize: Vector2
  maxFar?: number | null
  farScale?: number
  splitMode?: FrustumSplitMode
  splitLambda?: number
  margin?: number
  fade?: boolean
}

export const cascadedShadowMapsDefaults = {
  maxFar: null,
  farScale: 1,
  splitMode: 'practical',
  splitLambda: 0.5,
  margin: 0,
  fade: true
} satisfies Partial<CascadedShadowMapsOptions>

// The most cascades the shadow shaders are built for
// Cite: cascadedShadowMaps.glsl, whose selection loops run to 4 guarded by
// `UNROLLED_LOOP_INDEX < SHADOW_CASCADE_COUNT`

// Cite: CloudsMaterial.ts:236-242 allocates the interval and matrix uniform
// arrays at this length ("Populate the max number of elements")

// Allocating the max lets a cascade-count change reuse the same arrays
// instead of reallocating them
export const MAX_CASCADE_COUNT = 4

export class CascadedShadowMaps {
  readonly cascades: Cascade[] = []

  readonly mapSize = new Vector2()
  maxFar: number | null
  farScale: number
  splitMode: FrustumSplitMode
  splitLambda: number
  margin: number
  fade: boolean

  private readonly cameraFrustum = new FrustumCorners()
  private readonly frusta: FrustumCorners[] = []
  private readonly splits: number[] = []
  private _far = 0

  constructor(options: CascadedShadowMapsOptions) {
    const {
      cascadeCount,
      mapSize,
      maxFar,
      farScale,
      splitMode,
      splitLambda,
      margin,
      fade
    } = {
      ...cascadedShadowMapsDefaults,
      ...options
    }
    this.cascadeCount = cascadeCount
    this.mapSize.copy(mapSize)
    this.maxFar = maxFar
    this.farScale = farScale
    this.splitMode = splitMode
    this.splitLambda = splitLambda
    this.margin = margin
    this.fade = fade
  }

  get cascadeCount(): number {
    return this.cascades.length
  }

  set cascadeCount(value: number) {
    if (value !== this.cascadeCount) {
      for (let i = 0; i < value; ++i) {
        this.cascades[i] ??= {
          interval: new Vector2(),
          matrix: new Matrix4(),
          inverseMatrix: new Matrix4(),
          projectionMatrix: new Matrix4(),
          inverseProjectionMatrix: new Matrix4(),
          viewMatrix: new Matrix4(),
          inverseViewMatrix: new Matrix4()
        }
      }
      this.cascades.length = value
    }
  }

  get far(): number {
    return this._far
  }

  private updateIntervals(camera: PerspectiveCamera): void {
    const cascadeCount = this.cascadeCount
    const splits = this.splits
    const far = this.far
    splitFrustum(
      this.splitMode,
      cascadeCount,
      camera.near,
      far,
      this.splitLambda,
      splits
    )
    this.cameraFrustum.setFromCamera(camera, far)
    this.cameraFrustum.split(splits, this.frusta)

    const cascades = this.cascades
    for (let i = 0; i < cascadeCount; ++i) {
      cascades[i]!.interval.set(splits[i - 1] ?? 0, splits[i] ?? 0)
    }
  }

  private getFrustumRadius(
    camera: PerspectiveCamera,
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

  private updateMatrices(
    camera: PerspectiveCamera,
    sunDirection: Vector3,
    distance = 1
  ): void {
    const lightOrientationMatrix = matrixScratch1.lookAt(
      vectorScratch1.setScalar(0),
      vectorScratch2.copy(sunDirection).multiplyScalar(-1),
      Object3D.DEFAULT_UP
    )
    const cameraToLightMatrix = matrixScratch2.multiplyMatrices(
      matrixScratch2.copy(lightOrientationMatrix).invert(),
      camera.matrixWorld
    )

    const frusta = this.frusta
    const cascades = this.cascades
    invariant(frusta.length === cascades.length)
    const margin = this.margin
    const mapSize = this.mapSize

    for (let i = 0; i < frusta.length; ++i) {
      const frustum = frusta[i]!
      const cascade = cascades[i]!

      const radius = this.getFrustumRadius(camera, frustum)
      const left = -radius
      const right = radius
      const top = radius
      const bottom = -radius
      cascade.projectionMatrix.makeOrthographic(
        left,
        right,
        top,
        bottom,
        -this.margin,
        radius * 2 + this.margin
      )

      const { near, far } = frustumScratch
        .copy(frustum)
        .applyMatrix4(cameraToLightMatrix)
      const bbox = boxScratch.makeEmpty()
      for (let j = 0; j < 4; j++) {
        bbox.expandByPoint(near[j]!)
        bbox.expandByPoint(far[j]!)
      }
      const center = bbox.getCenter(vectorScratch1)
      center.z = bbox.max.z + margin

      const texelWidth = (right - left) / mapSize.width
      const texelHeight = (top - bottom) / mapSize.height
      center.x = Math.round(center.x / texelWidth) * texelWidth
      center.y = Math.round(center.y / texelHeight) * texelHeight

      center.applyMatrix4(lightOrientationMatrix)
      const position = vectorScratch2
        .copy(sunDirection)
        .multiplyScalar(distance)
        .add(center)
      cascade.inverseViewMatrix
        .lookAt(center, position, Object3D.DEFAULT_UP)
        .setPosition(position)
    }
  }

  update(
    camera: PerspectiveCamera,
    sunDirection: Vector3,
    distance?: number
  ): void {
    this._far =
      this.maxFar != null
        ? Math.min(this.maxFar, camera.far * this.farScale)
        : camera.far * this.farScale

    this.updateIntervals(camera)
    this.updateMatrices(camera, sunDirection, distance)

    const cascades = this.cascades
    const cascadeCount = this.cascadeCount
    for (let i = 0; i < cascadeCount; ++i) {
      const {
        matrix,
        inverseMatrix,
        projectionMatrix,
        inverseProjectionMatrix,
        viewMatrix,
        inverseViewMatrix
      } = cascades[i]!
      inverseProjectionMatrix.copy(projectionMatrix).invert()
      viewMatrix.copy(inverseViewMatrix).invert()
      matrix.copy(projectionMatrix).multiply(viewMatrix)
      inverseMatrix.copy(inverseViewMatrix).multiply(inverseProjectionMatrix)
    }
  }
}

// getSunDistanceFudge, horizon fudge for shadow distance
// TODO(port): Position the sun on the top atmosphere sphere

export function getSunDistanceFudge(
  sunDirection: Vector3,
  surfaceNormal: Vector3
): number {
  const zenithAngle = sunDirection.dot(surfaceNormal)
  return lerp(1e6, 1e3, zenithAngle)
}
