// Vendored from three-geospatial storybook/src/clouds/MinimalSetup.stories.tsx
// @ b012ad06 (MIT, Copyright (c) 2024 Shota Matsuda), the WebGL reference
// storybook. Edited: the title carries the clouds-webgl prefix, and atmosphere
// LUTs and cloud textures are served locally

import { Canvas } from '@react-three/fiber'
import { EffectComposer, ToneMapping } from '@react-three/postprocessing'
import type { Meta, StoryFn } from '@storybook/react-vite'
import { ToneMappingMode } from 'postprocessing'

import { AerialPerspective, Atmosphere } from '@takram/three-atmosphere/r3f'
import { Clouds } from '@takram/three-clouds/r3f'
import { LensFlare } from '@takram/three-geospatial-effects/r3f'

import { cloudTextureUrls } from './helpers/cloudTextureUrls'

export default {
  title: 'clouds-webgl/Minimal Setup',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

export const MinimalSetup: StoryFn = () => (
  <Canvas
    gl={{
      depth: false,
      toneMappingExposure: 10
    }}
    camera={{
      near: 1,
      far: 4e5,
      // See the Clouds/Basic story for deriving ECEF coordinates and rotation
      position: [4529893.894855564, 2615333.425024031, 3638042.815326614],
      rotation: [0.6423512931563148, -0.2928348796035058, -0.8344824769956042]
    }}
  >
    <Atmosphere date={Date.parse('2025-01-01T07:00:00Z')} textures='atmosphere'>
      <EffectComposer multisampling={0} enableNormalPass>
        <Clouds {...cloudTextureUrls} />
        <AerialPerspective sky sunLight skyLight />
        <LensFlare />
        <ToneMapping mode={ToneMappingMode.AGX} />
      </EffectComposer>
    </Atmosphere>
  </Canvas>
)
