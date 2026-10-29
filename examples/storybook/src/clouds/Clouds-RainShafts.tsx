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
  cloudsArgs,
  cloudsArgTypes,
  useCloudsControls,
  type CloudsArgs
} from './controls/cloudsControls'
import {
  convectiveProfileArgs,
  convectiveProfileArgTypes,
  useConvectiveProfileControls,
  type ConvectiveProfileArgs
} from './controls/convectiveProfileControls'
import {
  rainShaftsArgs,
  rainShaftsArgTypes,
  useRainShaftsControls,
  type RainShaftsArgs
} from './controls/rainShaftsControls'
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

// Convective layers: tall tower on lane a, thin cumulus decks on r and g
const convectiveLayers = [
  {
    channel: 'r' as const,
    altitude: 750,
    height: 650,
    densityScale: 0.2,
    shadow: true
  },
  {
    channel: 'g' as const,
    altitude: 1000,
    height: 1200,
    densityScale: 0.2,
    shadow: true
  },
  {
    channel: 'b' as const,
    altitude: 7500,
    height: 500,
    densityScale: 0.003,
    shapeAmount: 0.4,
    shapeDetailAmount: 0
  },
  {
    channel: 'a' as const,
    altitude: 1200,
    height: 10800,
    densityScale: 0.35,
    shapeAmount: 1,
    shadow: true
  }
]

const referenceContext = /*#__PURE__*/ (() => {
  const ctx = new CloudsContext()
  ctx.lightShafts = true
  ctx.experimental = { rainShafts: true, convectiveProfile: true }
  return ctx
})()

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

  // Low sun raking across the scene under the convective cell
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

  const RainShaftsControls: FC = () => {
    const { context: cloudsContext } = useClouds()
    useCloudsControls(cloudsContext, { shadowMaxFar: 1e5 })
    useConvectiveProfileControls(cloudsContext)
    useRainShaftsControls(cloudsContext)
    return null
  }

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
      >
        {convectiveLayers.map(layer => (
          <CloudLayer key={layer.channel} {...layer} />
        ))}
        <RainShaftsControls />
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
    LocalDateArgs,
    ToneMappingArgs,
    OutputPassArgs,
    ConvectiveProfileArgs,
    RainShaftsArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      <p>
        <strong>Rain shafts</strong> hanging under storm cells (
        <em>experimental.rainShafts</em>).
      </p>
      <p>
        A thin, low-albedo participating medium is placed directly by the cell
        mask generated by <em>convectiveProfile</em>, extending from the cloud
        base down to the ground. Shafts are illuminated by ambient irradiance
        and darkened by the cloud's marched shadow length under dense towers.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...localDateArgs({
    dayOfYear: 0,
    timeOfDay: 15.5
  }),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs(),
  ...convectiveProfileArgs(),
  ...rainShaftsArgs()
}

Story.argTypes = {
  ...cloudsArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes(),
  ...convectiveProfileArgTypes(),
  ...rainShaftsArgTypes()
}
