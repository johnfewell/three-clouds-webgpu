// clouds/Minimal Setup, the WebGPU counterpart of the WebGL
// MinimalSetup.stories.tsx: the smallest complete consumer. r3f has no context
// for a WebGPU/TSL post chain, so the minimum is the ADR-001 graph built by
// hand, i.e. examples/basic. Same camera, date (2025-01-01T07:00:00Z) and
// exposure (10) as the WebGL story

import { useThree } from '@react-three/fiber'
import type { Meta } from '@storybook/react-vite'
import { useLayoutEffect, type FC } from 'react'
import { AgXToneMapping } from 'three'
import { Clouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import type { Renderer, Node as ThreeNode } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { highpVelocity } from '@takram/three-geospatial/webgpu'

import { createStory, type StoryFC } from '../vendor/components/createStory'
import { WebGPUCanvas } from '../vendor/components/WebGPUCanvas'
import {
  rendererArgs,
  rendererArgTypes
} from '../vendor/controls/rendererControls'
import {
  toneMappingArgs,
  toneMappingArgTypes,
  type ToneMappingArgs
} from '../vendor/controls/toneMappingControls'
import { useResource } from '../vendor/hooks/useResource'
import { createAtmosphereContext } from './helpers/atmosphereContext'
import { CloudsPostProcessing } from './helpers/CloudsPostProcessing'
import { useBakedCloudTextures } from './helpers/useBakedCloudTextures'
import { useJitterTexture } from './helpers/useJitterTexture'

export default {
  title: 'clouds-webgpu/Minimal Setup',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

const date = Date.parse('2025-01-01T07:00:00Z')

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)

  const atmosphereContext = useResource(() => {
    const atmosphere = createAtmosphereContext()
    const { matrixECIToECEF, sunDirectionECEF } = atmosphere
    getECIToECEFRotationMatrix(date, matrixECIToECEF.value)
    getSunDirectionECI(date, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    return atmosphere
  }, [])
  atmosphereContext.camera = camera

  // The atmosphere goes on the renderer before the aerial node builds. The
  // clouds getter joins later (CloudsPostProcessing spreads this value), hence
  // a spread rather than one assignment
  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  // No sky on the scene background: the aerial node paints its own sky over
  // every far-plane pixel, so a background sky would be overwritten (0.3 ms at
  // 2880×1800 on Basic, identical frame, 2026-09-04)

  const scenePass = useResource(
    () =>
      pass(scene, camera, { samples: 0 }).setMRT(
        mrt({
          output,
          normal: normalView,
          velocity: highpVelocity as unknown as ThreeNode
        })
      ),
    [scene, camera]
  )

  const jitterTexture = useJitterTexture()

  // Awaited, not lazily loaded by <Clouds>: see useBakedCloudTextures
  const textures = useBakedCloudTextures()
  if (textures == null || jitterTexture == null) return null

  // Original march has no distant detail fade, so this story turns
  // that port default off
  return (
    <Clouds
      sceneDepth={scenePass.getTextureNode('depth')}
      localWeatherTexture={textures.localWeatherTexture}
      shapeTexture={textures.shapeTexture}
      shapeDetailTexture={textures.shapeDetailTexture}
      turbulenceTexture={textures.turbulenceTexture}
      stbnTexture={jitterTexture}
      experimental={{ distantShapeDetailFade: false }}
    >
      <CloudsPostProcessing
        scenePass={scenePass}
        atmosphereContext={atmosphereContext}
      />
    </Clouds>
  )
}

const Story: StoryFC<{}, ToneMappingArgs> = () => (
  <WebGPUCanvas
    camera={{
      near: 1,
      far: 4e5,
      // See the Clouds/Basic story for deriving ECEF coordinates and rotation
      position: [4529893.894855564, 2615333.425024031, 3638042.815326614],
      rotation: [0.6423512931563148, -0.2928348796035058, -0.8344824769956042]
    }}
  >
    <Content />
  </WebGPUCanvas>
)

// The tone mapping / renderer hooks inside read Storybook args (through
// createStory's StoryContext), so even the minimal story carries the two
// panels: exposure 10, as the WebGL story's gl={{ toneMappingExposure: 10 }}
Story.args = {
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...rendererArgs()
}

Story.argTypes = {
  ...toneMappingArgTypes(),
  ...rendererArgTypes()
}

export const MinimalSetup = createStory(Story)
