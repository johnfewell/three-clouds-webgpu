// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// Every render target the pass owns, and the ping-pong clear that invalidates a
// history pair. Each factory names its own attachments, because an mrt()
// resolves its keys against the bound target's texture names

import {
  Color,
  DataArrayTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter
} from 'three'
import { struct } from 'three/tsl'
import {
  RenderTarget,
  StorageArrayTexture,
  StorageTexture,
  type NodeFrame
} from 'three/webgpu'

export function createLayerTarget(lightShafts: boolean): RenderTarget {
  const rt = new RenderTarget(1, 1, {
    count: lightShafts ? 3 : 2,
    depthBuffer: false,
    type: HalfFloatType
  })
  rt.textures[0]!.name = 'layer'
  rt.textures[1]!.name = 'depthVelocity'
  if (lightShafts) {
    rt.textures[2]!.name = 'shadowLength'
  }
  return rt
}

// Cite: CloudsPass.ts:139–147. Colour, plus the shadow length as a second
// attachment when light shafts are on: one resolve pass writes both, as the
// reference's cloudsResolve.frag does (see buildCloudsResolve)
export function createResolveTarget(
  _name: string,
  lightShafts: boolean,
  compute = false
): RenderTarget {
  const rt = new RenderTarget(1, 1, {
    count: lightShafts ? 2 : 1,
    depthBuffer: false,
    type: HalfFloatType
  })
  if (compute) {
    rt.textures = rt.textures.map(original => {
      const storage = new StorageTexture().copy(original)
      storage.generateMipmaps = false
      storage.isRenderTargetTexture = true
      return storage
    })
  }
  rt.textures[0]!.name = 'output'
  if (lightShafts) {
    rt.textures[1]!.name = 'shadowLength'
  }
  return rt
}

// The one place the atlas's sampling contract is written down: the real
// targets and the pre-allocation placeholder must both come from here. Cite:
// ShadowPass.ts:21–31

// three picks `textureSample` or `textureLoad` at build time, from the texture
// bound then, which is this 1×1 placeholder. DataArrayTexture defaults to
// Nearest, and a later swap to the Linear atlas never recompiles

// A bare placeholder point-sampled every side-B cloud shadow into hard texels
// where the reference filters (ShadowPass.ts:27-28)
export function createShadowAtlasTexture(
  width: number,
  height: number,
  depth: number,
  { renderTarget }: { renderTarget: boolean }
): DataArrayTexture {
  // A consumer may upload the placeholder before the render target exists,
  // and render-target textures need no CPU buffer, placeholders need real texels
  const data = renderTarget ? null : new Uint16Array(width * height * depth * 4)
  const tex = new DataArrayTexture(data, width, height, depth)
  tex.type = HalfFloatType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.isRenderTargetTexture = renderTarget
  tex.name = 'shadowAtlas'
  return tex
}

// The aerial consumer's shadow-length read before the resolve targets exist
// As with the atlas placeholder, it carries the real target's sampling contract
// (HalfFloat, Linear), swapped for the history once that exists
export function createShadowLengthPlaceholder(): DataTexture {
  // One real RGBA half-float texel of zeros, not null data: a consumer that
  // binds this before the pass has built uploads it, and writeTexture takes
  // a buffer, not null (WebGPUTextureUtils._copyBufferToTexture)
  const tex = new DataTexture(new Uint16Array(4), 1, 1)
  tex.type = HalfFloatType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.name = 'shadowLengthPlaceholder'
  return tex
}

// MRT keys of the shadow march pass = the names of its target's textures
export const SHADOW_ATLAS = 'shadowAtlas'
export const SHADOW_VELOCITY = 'shadowVelocity'

// One march per texel feeds both attachments: a Fn returns ONE node, so the
// pair travels as a struct, read with .get() at the mrt() (cloudsFragment.ts
// does the same for the march's layer + depthVelocity)
export const shadowPassOutput = /*#__PURE__*/ struct(
  { atlas: 'vec4', velocity: 'vec4' },
  'ShadowPassOutput'
)

// Cite: ShadowPass.ts:21–31, ShadowPass.ts:155–161
export function createShadowTarget(
  width: number,
  height: number,
  depth: number,
  compute = false,
  // A second attachment for the depth velocity, written by the march pass
  // itself (MRT, one layer per cascade pass), as the reference's
  // shadow.frag:24-35 does, instead of a separate velocity pass per cascade
  withVelocity = false
): RenderTarget {
  const rt = new RenderTarget(width, height, {
    depthBuffer: false,
    count: withVelocity ? 2 : 1
  })
  const tex = createShadowAtlasTexture(width, height, depth, {
    renderTarget: true
  })
  if (withVelocity) {
    const velocity = createShadowAtlasTexture(width, height, depth, {
      renderTarget: true
    })
    velocity.name = SHADOW_VELOCITY
    for (const t of rt.textures) t.dispose()
    rt.textures = [tex, velocity]
    rt.depth = depth
    return rt
  }
  rt.texture.dispose()
  rt.texture = compute
    ? new StorageArrayTexture(width, height, depth).copy(tex)
    : tex
  // Texture.copy replaces the storage constructor's array flag with the
  // DataArrayTexture source's false flag, so preserve the binding dimension
  if (compute) rt.texture.isArrayTexture = true
  rt.depth = depth
  return rt
}

// Both targets are cleared, since the next swap brings back a warm one
// (measured: one clear left the resize path at SSIM 0.831, both 0.951)
export function clearHistoryPair(
  renderer: NonNullable<NodeFrame['renderer']>,
  a: RenderTarget | null,
  b: RenderTarget | null,
  layers = 1
): void {
  const previous = renderer.getRenderTarget()
  const face = renderer.getActiveCubeFace()
  const mip = renderer.getActiveMipmapLevel()
  const color = renderer.getClearColor(new Color())
  const alpha = renderer.getClearAlpha()
  // RendererUtils resets alpha to 1, and inheriting it seeds opaque black clouds
  // in the Bayer phases the first march has not written yet
  renderer.setClearColor(0, 0)
  try {
    for (const target of [a, b]) {
      if (target == null) continue
      for (let layer = 0; layer < layers; layer++) {
        renderer.setRenderTarget(target, layer)
        renderer.clear(true, true, true)
      }
    }
  } finally {
    renderer.setClearColor(color, alpha)
    renderer.setRenderTarget(previous, face, mip)
  }
}
