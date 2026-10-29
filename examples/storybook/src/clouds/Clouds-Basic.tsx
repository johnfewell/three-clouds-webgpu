// clouds/Clouds/Basic on the port, the WebGPU counterpart of the WebGL
// Clouds-Basic.tsx: the default four-layer set over the bare ellipsoid, at the
// same location (30°E, 35°N, 300 m), date (day 0, 09:00) and exposure (10)
// Shaped like upstream's WebGPU stories, with the camera placed by PointOfView
// so the WebGL twin can reproduce the pose exactly

import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useAtomValue } from 'jotai'
import { useLayoutEffect, type FC, type ReactNode } from 'react'
import { AgXToneMapping } from 'three'
import { CloudsContext } from 'three-clouds-webgpu'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
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
import { useEvolvingWeather } from './controls/evolvingWeatherControls'
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
import { weatherTextureAtom, WeatherVariety } from './WeatherVariety'

// The panel's initial values are read off a pristine context (CloudLayers
// DEFAULT, the 'high' preset): one instance, module scope, never rendered
const referenceContext = /*#__PURE__*/ new CloudsContext()

// The clouds panel needs the context <Clouds> creates, so it hangs off a child
// shadow.maxFar 1e5 is the WebGL story's `shadow-maxFar={1e5}`
const Controls: FC = () => {
  const { context } = useClouds()
  useCloudsControls(context, { shadowMaxFar: 1e5 })
  useCloudLayerControls(context)
  useEvolvingWeather(context)
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

  // The atmosphere goes on the renderer before anything that reads it builds
  // The clouds getter joins later (CloudsPostProcessing spreads this value),
  // hence a spread rather than one assignment
  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  // No sky on the scene background: the aerial node paints its own sky over
  // every far-plane pixel, so a background sky would be overwritten (0.3 ms at
  // 2880×1800 on Basic, identical frame, 2026-09-04)

  // MRT scene pass: color + normal (the aerial node's lighting) + velocity
  // (TAA). The clouds march reads its depth.
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

  // ADR-009: the volume the `jitter` arg selects, blue noise by default
  const jitterTexture = useJitterTexture()

  // Awaited, not lazily loaded by <Clouds>: see useBakedCloudTextures
  const textures = useBakedCloudTextures()

  // null in every story but the procedural-weather one, so the baked
  // PNG stays the default here
  const proceduralWeather = useAtomValue(weatherTextureAtom)

  // Camera about the location, orbitable around it. The WebGL story's initial
  // pose (Canvas default offset at minDistance) is not reproducible, this is
  // Pose and world frame: ECEF, or rebased to the location for the ocean
  const target = useGroundCamera(
    ground,
    atmosphereContext.matrixWorldToECEF.value
  )

  // Local date controls (depends on the longitude of the location), exactly
  // as upstream's WebGPU stories drive the sun and the moon
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
        localWeatherTexture={proceduralWeather ?? textures.localWeatherTexture}
        shapeTexture={textures.shapeTexture}
        shapeDetailTexture={textures.shapeDetailTexture}
        turbulenceTexture={textures.turbulenceTexture}
        stbnTexture={jitterTexture}
      >
        <Controls />
        <WeatherVariety />
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

interface StoryProps extends PointOfViewProps {
  // The caption, for the stories that reuse this scene to show one feature
  description?: ReactNode
}

interface StoryArgs
  extends
    CloudsArgs,
    CloudLayerArgs,
    LocalDateArgs,
    ToneMappingArgs,
    OutputPassArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = ({
  description,
  ...props
}) => (
  <WebGPUCanvas camera={{ near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      {description ?? (
        <p>
          The default four-layer clouds of <em>three-clouds-webgpu</em> over the
          bare ellipsoid. Drag to orbit the location.
        </p>
      )}
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...cloudLayerArgs(referenceContext),
  ...localDateArgs({
    dayOfYear: 0,
    timeOfDay: 9
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
