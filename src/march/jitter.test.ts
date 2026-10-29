// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { int } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, expectWGSL } from '../../test/helpers/compileWGSL'
import { createJitterTexture } from '../textures/loadBakedCloudTextures'
import { getSTBN } from './jitter'

describe('getSTBN', () => {
  const stbnTex = createJitterTexture()
  const frame = int(0)
  const stbnNode = getSTBN(stbnTex, frame)

  it('compiles to WGSL with 1/size-scaled UV division', () => {
    const { fragment } = compileWGSL(stbnNode)
    expectWGSL(fragment).toContain('/ vec3<f32>( 128.0, 128.0, 64.0 )')
  })

  it('uses repeat wrapping, not clamp-to-edge wrapping', () => {
    const { fragment } = compileWGSL(stbnNode)
    expectWGSL(fragment).toContain('tsl_repeatWrapping_float')
    expectWGSL(fragment).toNotContain('tsl_clampWrapping')
    expectWGSL(fragment).toNotContain('ClampToEdge')
  })

  it('does not reference STBNTextureNode', () => {
    const { fragment } = compileWGSL(stbnNode)
    expect(fragment).not.toContain('STBNTextureNode')
  })
})

// getSTBN reads a TextureNode re-synced from CloudsContext.stbnTexture each
// frame, so a swap after the build reaches the shader (the r3f prop, the
// storybook knob). Read through the compiled bindings, not the graph
describe('getSTBN through a TextureNode', () => {
  it('a value swap after the build changes the bound texture', async () => {
    const { texture3D } = await import('three/tsl')
    const texA = createJitterTexture()
    const texB = createJitterTexture()
    const node = texture3D(texA)
    const { boundTextures } = compileWGSL(getSTBN(node, int(0)))
    expect(boundTextures()).toContain(texA)
    node.value = texB
    expect(boundTextures()).toContain(texB)
    expect(boundTextures()).not.toContain(texA)
  })

  it('a raw Data3DTexture is captured at build, as before', () => {
    const texA = createJitterTexture()
    const { boundTextures } = compileWGSL(getSTBN(texA, int(0)))
    expect(boundTextures()).toContain(texA)
  })
})
