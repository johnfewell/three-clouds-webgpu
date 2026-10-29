// clouds-webgpu/CloudTypes: the opt-in cloud-type presets, one story per named
// sky and a selector arg. A preset is data applied to the clouds context, so
// this story uses the default <Clouds> layer set and writes coverage plus the
// four lanes, which is all a preset may touch
// Otherwise the Clouds/Basic graph: the ellipsoid at 30 E 35 N 300 m, exposure

import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, type FC } from 'react'
import { AgXToneMapping } from 'three'
import {
  applyCloudTypePreset,
  CloudsContext,
  cloudTypePresetNames,
  isCloudTypePresetName,
  type CloudTypePresetName
} from 'three-clouds-webgpu'
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
import { useTransientControl } from '../vendor/hooks/useTransientControl'
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

// 'off' is the state the presets are off in: the context's own defaults, one
// click away so a still of "off" sits beside a still of "on" (the same reason
// the experiments panel carries its baseline radio)
const OFF = 'off'
export type CloudTypeArg = typeof OFF | CloudTypePresetName

const presetLabels: Record<CloudTypeArg, string> = {
  [OFF]: 'Off (default layers)',
  fairWeatherCumulus: 'Fair-weather cumulus',
  stratocumulusDeck: 'Stratocumulus deck',
  overcastSheet: 'Overcast sheet (altostratus)',
  highCirrus: 'High cirrus',
  groundFog: 'Ground fog',
  mixedSky: 'Mixed sky'
}

export interface CloudTypeArgs {
  cloudType: CloudTypeArg
}

// The panel's initial values come from a context carrying the fair-weather
// preset, so the panel shows what the story opens on
const referenceContext = /*#__PURE__*/ (() => {
  const reference = new CloudsContext()
  applyCloudTypePreset(reference, 'fairWeatherCumulus')
  return reference
})()

// What 'off' restores: this context's own defaults, read rather than restated,
// so the off state cannot drift from what an untouched scene renders
const defaultContext = /*#__PURE__*/ new CloudsContext()

// The clouds panel needs the context <Clouds> creates, so it hangs off a child
// The preset is applied last so it wins over the panel for the fields it sets,
// and the panel stays editable afterwards for tuning by hand
const Controls: FC = () => {
  const { context } = useClouds()
  useCloudsControls(context, { shadowMaxFar: 1e5 })
  useCloudLayerControls(context)
  useTransientControl(
    (args: CloudTypeArgs) => args.cloudType,
    cloudType => {
      if (cloudType === OFF) {
        context.cloudLayers.copy(defaultContext.cloudLayers)
        context.coverage = defaultContext.coverage
        return
      }
      if (!isCloudTypePresetName(cloudType)) return
      applyCloudTypePreset(context, cloudType)
    }
  )
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

  // ADR-009: the port's deterministic hash jitter volume
  const jitterTexture = useJitterTexture()

  // Awaited, not lazily loaded by <Clouds>: see useBakedCloudTextures
  const textures = useBakedCloudTextures()

  // Camera about the location, orbitable around it
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
      >
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
    CloudTypeArgs,
    LocalDateArgs,
    ToneMappingArgs,
    OutputPassArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      <p>
        A named cloud type applied as data: one <em>coverage</em> value and four{' '}
        <em>CloudLayer</em> lanes, no renderer change. Pick another from the{' '}
        <em>cloud type</em> control. The panel stays live, so any preset is a
        starting point rather than a fixed sky.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...cloudLayerArgs(referenceContext),
  cloudType: 'fairWeatherCumulus',
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
  cloudType: {
    name: 'cloud type',
    control: { type: 'select', labels: presetLabels },
    options: [OFF, ...cloudTypePresetNames],
    table: { category: 'clouds' }
  },
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes()
}
