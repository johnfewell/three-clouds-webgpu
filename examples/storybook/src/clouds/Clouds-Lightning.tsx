import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, type FC } from 'react'
import { AgXToneMapping, Vector3 } from 'three'
import { CloudsContext } from 'three-clouds-webgpu'
import { CloudLayer, Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import type { Renderer, Node as ThreeNode } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { Geodetic, radians } from '@takram/three-geospatial'
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
  lightningArgs,
  lightningArgTypes,
  useLightningControls,
  type LightningArgs
} from './controls/lightningControls'
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

const stormLayers = [
  {
    channel: 'r' as const,
    altitude: 1000,
    height: 1200,
    densityScale: 0.35,
    shapeAmount: 0.9,
    shadow: true
  },
  {
    channel: 'g' as const,
    altitude: 1800,
    height: 2500,
    densityScale: 0.45,
    shapeAmount: 0.95,
    shadow: true
  },
  {
    channel: 'b' as const,
    altitude: 4000,
    height: 4000,
    densityScale: 0.25,
    shapeAmount: 0.8
  },
  {
    channel: 'a' as const,
    altitude: 1200,
    height: 7000,
    densityScale: 0.5,
    shapeAmount: 1
  }
]

const referenceContext = /*#__PURE__*/ (() => {
  const ctx = new CloudsContext()
  ctx.coverage = 0.65
  ctx.experimental = { lightning: true }
  return ctx
})()

const Content: FC<StoryProps> = storyPov => {
  // The ground global swaps the story's pose for a tiled location's
  const ground = useGround(storyPov)
  const { longitude, latitude } = ground.pov
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

  // Low sun for a dark storm sky where the internal flash shines through
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

  const getFlashPosition = useMemo(() => {
    return (flashDist: number, flashAlt: number): Vector3 => {
      // Place flash ahead (north) and slightly east, embedded inside the cloud layer
      const flashGeo = new Geodetic(
        radians(longitude + 0.03),
        radians(latitude + flashDist / 111000),
        flashAlt
      )
      return flashGeo.toECEF(new Vector3())
    }
  }, [longitude, latitude])

  const LightningControls: FC = () => {
    const { context: cloudsContext } = useClouds()
    useCloudsControls(cloudsContext, { shadowMaxFar: 1e5 })
    useLightningControls(cloudsContext, getFlashPosition)
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
        {stormLayers.map(layer => (
          <CloudLayer key={layer.channel} {...layer} />
        ))}
        <LightningControls />
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
    LightningArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      <p>
        <strong>Storm lightning flashes</strong> inside the cloud volume (
        <em>experimental.lightning</em>).
      </p>
      <p>
        A transient point light source is embedded within the cloud medium. Each
        shaded sample evaluates in-scattering toward the flash using the cloud's
        own secondary extinction march, so deep discharge points are occluded by
        denser cloud structures in front of them.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...localDateArgs({
    dayOfYear: 0,
    timeOfDay: 18.2
  }),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs(),
  ...lightningArgs()
}

Story.argTypes = {
  ...cloudsArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes(),
  ...lightningArgTypes()
}
