// clouds/Clouds/CustomLayers on the port, the WebGPU counterpart of
// storybook/src/clouds/Clouds-CustomLayers.tsx (WebGL): the default layers
// replaced by four <CloudLayer> children (verbatim), coverage 0.3,
// shadow.maxFar 1e5, at 30°E 35°N 500 m, day 0 13:00 local, exposure 10. The
// rest is Clouds/Basic

import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, type FC } from 'react'
import { AgXToneMapping } from 'three'
import { CloudsContext } from 'three-clouds-webgpu'
import { CloudLayer, Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import type { Renderer, Node as ThreeNode } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { highpVelocity } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../vendor/components/createStory'
import { Description } from '../vendor/components/Description'
import { WebGPUCanvas } from '../vendor/components/WebGPUCanvas'
import {
  localDateArgs,
  localDateArgTypes,
  useLocalDateControls,
  type LocalDateArgs
} from '../vendor/controls/localDateControls'
import {
  outputPassArgs,
  outputPassArgTypes,
  type OutputPassArgs
} from '../vendor/controls/outputPassControls'
import {
  rendererArgs,
  rendererArgTypes
} from '../vendor/controls/rendererControls'
import {
  toneMappingArgs,
  toneMappingArgTypes,
  type ToneMappingArgs
} from '../vendor/controls/toneMappingControls'
import { type PointOfViewProps } from '../vendor/hooks/usePointOfView'
import { useResource } from '../vendor/hooks/useResource'
import {
  cloudLayerArgs,
  cloudLayerArgTypes,
  useCloudLayerControls,
  type CloudLayerArgs
} from './controls/cloudLayerControls'
import {
  cloudsArgs,
  cloudsArgTypes,
  useCloudsControls,
  type CloudsArgs
} from './controls/cloudsControls'
import { createAtmosphereContext } from './helpers/atmosphereContext'
import { CloudsPostProcessing } from './helpers/CloudsPostProcessing'
import { FlyControls } from './helpers/FlyControls'
import {
  groundMRT,
  GroundTiles,
  useGround,
  useGroundCamera
} from './helpers/ground'
import { GroundOcean } from './helpers/oceanGround'
import { useBakedCloudTextures } from './helpers/useBakedCloudTextures'
import { useJitterTexture } from './helpers/useJitterTexture'

// The WebGL story's four layers, verbatim
const customLayers = [
  {
    channel: 'r',
    altitude: 1000,
    height: 1000,
    shapeAmount: 0.8,
    weatherExponent: 0.6,
    shadow: true
  },
  {
    channel: 'g',
    altitude: 2000,
    height: 800,
    shapeAmount: 0.8,
    shapeAlteringBias: 0.5,
    densityScale: 0.1
  },
  {
    channel: 'b',
    altitude: 2000,
    height: 2000,
    densityScale: 2e-3,
    shapeAmount: 0.3
  },
  {
    channel: 'a',
    height: 300,
    densityScale: 0.05,
    shapeAmount: 0.2,
    shapeDetailAmount: 0,
    shapeAlteringBias: 0.5,
    coverageFilterWidth: 1,
    densityProfile: {
      expTerm: 1,
      exponent: 1e-3,
      constantTerm: 0,
      linearTerm: 0
    }
  }
] as const

// The layer panel's initial values come from a context carrying THESE layers,
// not the defaults, so the panel shows what the story renders
const referenceContext = /*#__PURE__*/ (() => {
  const reference = new CloudsContext()
  reference.cloudLayers.set(customLayers)
  return reference
})()

const Controls: FC = () => {
  const { context: cloudsContext } = useClouds()
  useCloudsControls(cloudsContext, { shadowMaxFar: 1e5 })
  useCloudLayerControls(cloudsContext)
  return null
}

const Content: FC<StoryProps> = storyPov => {
  // The ground global swaps the story's pose for a tiled location's
  const ground = useGround(storyPov)
  const { longitude } = ground.pov
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)

  const atmosphereContext = useResource(() => createAtmosphereContext(), [])
  atmosphereContext.camera = camera

  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  // No sky on the scene background: see Clouds-Basic

  const scenePass = useResource(
    () =>
      pass(scene, camera, { samples: 0 }).setMRT(
        mrt({
          output,
          normal: normalView,
          velocity: highpVelocity as unknown as ThreeNode,
          ...groundMRT(ground.ocean)
        })
      ),
    [scene, camera, ground.ocean]
  )

  const jitterTexture = useJitterTexture()
  const textures = useBakedCloudTextures()

  // Pose and world frame: ECEF, or rebased to the location for the ocean
  const target = useGroundCamera(
    ground,
    atmosphereContext.matrixWorldToECEF.value
  )

  useLocalDateControls(longitude, date => {
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } =
      atmosphereContext
    getECIToECEFRotationMatrix(date, matrixECIToECEF.value)
    getSunDirectionECI(date, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(date, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  })

  if (textures == null || jitterTexture == null) return null

  return (
    <>
      <GroundTiles ground={ground} />
      <OrbitControls makeDefault target={target} minDistance={100} />
      <FlyControls
        key={ground.value}
        worldToECEF={atmosphereContext.matrixWorldToECEF.value}
      />
      <Clouds
        sceneDepth={scenePass.getTextureNode('depth')}
        localWeatherTexture={textures.localWeatherTexture}
        shapeTexture={textures.shapeTexture}
        shapeDetailTexture={textures.shapeDetailTexture}
        turbulenceTexture={textures.turbulenceTexture}
        stbnTexture={jitterTexture}
        disableDefaultLayers
      >
        {customLayers.map((layer, index) => (
          <CloudLayer key={index} {...layer} />
        ))}
        <Controls />
        {ground.ocean && <GroundOcean />}
        <CloudsPostProcessing
          albedoScale={ground.albedoScale}
          lightingMask={ground.ocean}
          scenePass={scenePass}
          atmosphereContext={atmosphereContext}
        />
      </Clouds>
    </>
  )
}

interface StoryProps extends PointOfViewProps {}

interface StoryArgs
  extends
    CloudsArgs,
    CloudLayerArgs,
    LocalDateArgs,
    ToneMappingArgs,
    OutputPassArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      <p>
        Four custom <em>CloudLayer</em>s: two cumulus decks on the r and g
        weather channels, a thin high layer on b, and a ground fog on a.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext, { coverage: 0.3 }),
  ...cloudLayerArgs(referenceContext),
  ...localDateArgs({
    dayOfYear: 0,
    timeOfDay: 13
  }),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs()
}

Story.argTypes = {
  ...cloudsArgTypes(),
  ...cloudLayerArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes()
}
