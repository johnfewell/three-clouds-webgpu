// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: Procedural3DTexture.ts:26–92, ProceduralTexture.ts:26–92

import {
  float,
  Fn,
  instanceIndex,
  int,
  ivec2,
  ivec3,
  storageTexture,
  textureStore,
  vec2,
  vec3
} from 'three/tsl'
import {
  LinearFilter,
  LinearMipMapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  Storage3DTexture,
  StorageTexture,
  type ComputeNode,
  type Node,
  type Renderer,
  type Texture
} from 'three/webgpu'

import { storageTexture3D } from '@takram/three-geospatial/webgpu'

// The reference draws a full-screen quad per depth slice (128 draws for the
// shape, Procedural3DTexture.ts:80-81). WebGPU writes the volume in one compute
// dispatch. The sampler settings are unchanged because the marches depend on them

// The values are identical: the shader is a pure function of the normalised
// texel position, `vec3(vUv, layer / size)` there and `(id + 0) / size` here

// Generic over the texture it fills, mirroring the reference's
// `ProceduralTexture<T>`: the 3D slots must stay 3D-typed so a 2D generator
// cannot be assigned to one
export interface ProceduralTextureLike<T extends Texture = Texture> {
  readonly size: number
  // The texture the generator fills, which is what the uniforms bind
  readonly texture: T
  needsRender: boolean
  render: (renderer: Renderer) => void
  dispose: () => void
}

function applySamplerSettings(
  texture: {
    minFilter: number
    magFilter: number
    wrapS: number
    wrapT: number
    wrapR?: number
    colorSpace: string
    needsUpdate: boolean
  },
  // the minification filter is the one sampler setting that differs:
  // the 3D volumes have no mip chain and stay linear, the 2D generator minifies
  // through its mips, like the reference's ProceduralTextureBase

  // A plain LinearFilter made three's WebGPU backend pick mipmapFilter NEAREST,
  // so a fractional mip rounded to one level where the reference blends two
  minFilter: number = LinearFilter
): void {
  texture.minFilter = minFilter
  texture.magFilter = LinearFilter
  // RepeatWrapping on every axis is what lets the tiling the generators are
  // built for actually show up. A clamped sampler would seam at the border no
  // matter how carefully the noise wraps
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  if ('wrapR' in texture) texture.wrapR = RepeatWrapping
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
}

export interface Procedural3DTextureParameters {
  size: number
  // Density at a normalised position in the unit cube
  generate: (point: Node<'vec3'>) => Node<'float'>
}

// A size^3 volume filled by one compute dispatch
export class Procedural3DTexture implements ProceduralTextureLike<Storage3DTexture> {
  readonly size: number
  needsRender = true

  readonly texture: Storage3DTexture
  private readonly computeNode: ComputeNode

  constructor({ size, generate }: Procedural3DTextureParameters) {
    this.size = size
    this.texture = new Storage3DTexture(size, size, size)
    applySamplerSettings(this.texture)

    // three's Storage3DTexture defaults generateMipmaps to true, the reference's
    // WebGL3DRenderTarget to false. Inherited, the shape volume would blur along
    // the march at distance, so it is set explicitly
    ;(this.texture as unknown as { generateMipmaps: boolean }).generateMipmaps =
      false

    const target = storageTexture3D(this.texture)
    this.computeNode = Fn(() => {
      // One invocation per texel, unflattening the linear index into the
      // volume. instanceIndex is uint and the storage coordinate must be ivec3
      const i = int(instanceIndex)
      const x = i.mod(size)
      const y = i.div(size).mod(size)
      const z = i.div(size * size)
      // Half-texel on x and y only. The reference reads `vUv` (fragment centres,
      // (i + 0.5) / size) but its z is `layer / size` with no offset
      // (Procedural3DTexture.ts:82)

      // Corners on all three shift the field 0.0039 in x and y, ~0.22 of a
      // 56-cell Worley: the same statistics, a visibly different field (case 45
      // at 0.6486, "fields differ")
      const point = vec3(
        float(x).add(0.5).div(size),
        float(y).add(0.5).div(size),
        float(z).div(size)
      )
      textureStore(target, ivec3(x, y, z), generate(point))
    })().compute(size * size * size)
  }

  render(renderer: Renderer): void {
    if (!this.needsRender) return
    this.needsRender = false
    // render() stays synchronous, as in the reference (Procedural3DTexture.ts:73):
    // the awaitable compute() result is discarded, and device failures surface
    // through the renderer's error scopes
    void renderer.compute(this.computeNode)
  }

  dispose(): void {
    this.texture.dispose()
  }
}

export interface ProceduralTexture2DParameters {
  size: number
  // RGBA at a normalised uv in the unit square
  generate: (uv: Node<'vec2'>) => Node<'vec4'>
}

// A size^2 RGBA texture filled by one compute dispatch. It has mips and the 3D
// variant does not (ProceduralTexture.ts:25): the weather texture is sampled at
// grazing angles, the volumes at roughly constant density along a march
export class ProceduralTexture2D implements ProceduralTextureLike<StorageTexture> {
  readonly size: number
  needsRender = true

  readonly texture: StorageTexture
  private readonly computeNode: ComputeNode

  constructor({ size, generate }: ProceduralTexture2DParameters) {
    this.size = size
    this.texture = new StorageTexture(size, size)
    applySamplerSettings(this.texture, LinearMipMapLinearFilter)
    ;(this.texture as unknown as { generateMipmaps: boolean }).generateMipmaps =
      true

    const target = storageTexture(this.texture)
    this.computeNode = Fn(() => {
      const i = int(instanceIndex)
      const x = i.mod(size)
      const y = i.div(size)
      // Texel centres, as the reference's vUv gives (see the 3D note above)
      const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(size)
      textureStore(target, ivec2(x, y), generate(uv))
    })().compute(size * size)
  }

  render(renderer: Renderer): void {
    if (!this.needsRender) return
    this.needsRender = false
    // Synchronous like the 3D variant's render(), see there
    void renderer.compute(this.computeNode)
  }

  dispose(): void {
    this.texture.dispose()
  }
}
