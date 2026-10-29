import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, type FC } from 'react'
import { AgXToneMapping } from 'three'
import {
  applyScenePreset,
  CloudsContext,
  scenePresets,
  type ScenePresetName
} from 'three-clouds-webgpu'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import type { Renderer, Node as ThreeNode } from 'three/webgpu'

import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { highpVelocity } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../vendor/components/createStory'
import { Description } from '../vendor/components/Description'
import { WebGPUCanvas } from '../vendor/components/WebGPUCanvas'
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
import { useControl } from '../vendor/hooks/useControl'
import { type PointOfViewProps } from '../vendor/hooks/usePointOfView'
import { useResource } from '../vendor/hooks/useResource'
import {
  cloudsArgs,
  cloudsArgTypes,
  useCloudsControls,
  type CloudsArgs
} from './controls/cloudsControls'
import {
  SCENE_PRESET_DATE,
  scenePresetsArgs,
  scenePresetsArgTypes,
  useScenePresetsControls,
  type ScenePresetsArgs
} from './controls/scenePresetsControls'
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

// Ground observer over the ocean: target at 55 m with distance 100 m and pitch
// 11-13 deg places the camera about 32-36 m above sea level, looking up into
// the cloud deck with the sky filling the upper two thirds of the frame
const groundBase = {
  longitude: 30,
  latitude: 35,
  height: 55,
  distance: 100
}

export const SCENE_PRESET_POSES: Record<ScenePresetName, PointOfViewProps> = {
  partlyCloudy: { ...groundBase, heading: -141, pitch: 13 },
  fluffy: { ...groundBase, heading: -136, pitch: 13 },
  pixar: { ...groundBase, heading: -115, pitch: 13 },
  stunningSunset: { ...groundBase, heading: -170, pitch: 12 },
  moonlitNight: { ...groundBase, heading: 176, pitch: 13 },
  hazy: { ...groundBase, heading: -65, pitch: 12 },
  thunderstorm: { ...groundBase, heading: -45, pitch: 13 },
  stormyEvening: { ...groundBase, heading: -80, pitch: 13 }
}

const referenceContext = /*#__PURE__*/ (() => {
  const ctx = new CloudsContext()
  applyScenePreset(ctx, 'stunningSunset', {
    date: SCENE_PRESET_DATE,
    location: { longitude: 30, latitude: 35 },
    sinks: [
      {
        sunDirection: ctx.sunDirection,
        moonDirection: ctx.moonDirection
      }
    ]
  })
  return ctx
})()

const SceneControls: FC<{
  atmosphereContext: AtmosphereContext
  longitude: number
  latitude: number
}> = ({ atmosphereContext, longitude, latitude }) => {
  const { context: cloudsContext } = useClouds()
  useCloudsControls(cloudsContext, { shadowMaxFar: 1e5 })
  useScenePresetsControls(cloudsContext, atmosphereContext, {
    longitude,
    latitude
  })
  return null
}

const Content: FC<StoryProps> = storyPov => {
  const scenePreset = useControl(
    ({ scenePreset }: ScenePresetsArgs) => scenePreset
  )
  const presetPose = SCENE_PRESET_POSES[scenePreset] ?? storyPov
  // Follow the active preset's pose when switched in the interactive selector
  const ground = useGround({
    ...storyPov,
    heading: presetPose.heading,
    pitch: presetPose.pitch,
    height: presetPose.height,
    distance: presetPose.distance
  })
  const { longitude, latitude } = ground.pov
  const moonIntensity = scenePresets[scenePreset]?.moonGain ?? 1
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

  if (textures == null || jitterTexture == null) return null

  return (
    <>
      <GroundTiles ground={ground} />
      <OrbitControls
        key={`orbit-${ground.value}`}
        makeDefault
        target={target}
        minDistance={50}
      />
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
        <SceneControls
          atmosphereContext={atmosphereContext}
          longitude={longitude}
          latitude={latitude}
        />
        {ground.ocean && <GroundOcean />}
        <CloudsPostProcessing
          albedoScale={ground.albedoScale}
          lightingMask={ground.ocean}
          scenePass={scenePass}
          atmosphereContext={atmosphereContext}
          nightSky={scenePreset === 'moonlitNight'}
          moonIntensity={moonIntensity}
        />
      </Clouds>
    </>
  )
}

interface StoryProps extends PointOfViewProps {}

interface StoryArgs
  extends CloudsArgs, ToneMappingArgs, OutputPassArgs, ScenePresetsArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ fov: 58, near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      <p>
        <strong>Whole-scene presets</strong> (<em>applyScenePreset</em>) and
        time-of-day celestial sync (<em>syncCelestialDirections</em>).
      </p>
      <p>
        Configures cloud type, coverage, haze, and experimental options in a
        single call. Resolves local solar time into ECEF sun and moon vectors,
        writing them to atmosphere and cloud sinks synchronously.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: Number(
      (10 * scenePresets.stunningSunset.exposure).toFixed(2)
    )
  }),
  ...outputPassArgs(),
  ...rendererArgs(),
  ...scenePresetsArgs('stunningSunset')
}

Story.argTypes = {
  ...cloudsArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes(),
  ...scenePresetsArgTypes()
}
