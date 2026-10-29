// clouds/Clouds/CustomLayers on the port, with no WebGL counterpart. The
// reference renders every layer as a slab whose density falls to zero at its
// own top, which no choice of its four profile terms can change (design doc
// section 1), so this builds the slab it cannot: a 1.2 to 12 km tower

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
import { useTransientControl } from '../vendor/hooks/useTransientControl'
import { cloudLayerArgTypes } from './controls/cloudLayerControls'
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
  experimentalArgs,
  experimentalArgTypes,
  selectedExperiments,
  type ExperimentalArgs
} from './controls/experimentalControls'
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

// Two thin cumulus decks from the default set, the cirrus stand-in on b, and
// lane 3 made into the tower. The shoulder only reaches layers over 4 km
const convectiveLayers = [
  { channel: 'r', altitude: 750, height: 650, densityScale: 0.2, shadow: true },
  {
    channel: 'g',
    altitude: 1000,
    height: 1200,
    densityScale: 0.2,
    shadow: true
  },
  {
    channel: 'b',
    altitude: 7500,
    height: 500,
    densityScale: 0.003,
    shapeAmount: 0.4,
    shapeDetailAmount: 0
  },
  {
    channel: 'a',
    altitude: 1200,
    height: 10800,
    densityScale: 0.35,
    shapeAmount: 1,
    shapeDetailAmount: 1,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.6,
    shadow: true
  }
] as const

// The layer panel and the cloud panel read their initial values from a
// context carrying THESE layers, so the panel shows what the story renders
const referenceContext = /*#__PURE__*/ (() => {
  const reference = new CloudsContext()
  reference.cloudLayers.set(convectiveLayers)
  reference.experimental = { convectiveProfile: true }
  return reference
})()

// 150 km of shadow range. A 12 km top at low sun casts about 45 km and the
// default 50 km barely covers it (design doc section 3.8)
const SHADOW_MAX_FAR = 1.5e5

const Controls: FC = () => {
  const { context: cloudsContext } = useClouds()
  useCloudsControls(cloudsContext, { shadowMaxFar: SHADOW_MAX_FAR })
  useConvectiveProfileControls(cloudsContext)
  useTransientControl(
    (a: StoryArgs) => selectedExperiments(a),
    experiments => {
      cloudsContext.experimental = experiments
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
      <OrbitControls makeDefault target={target} minDistance={1000} />
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
        {convectiveLayers.map((layer, index) => (
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
    LocalDateArgs,
    ToneMappingArgs,
    OutputPassArgs,
    ConvectiveProfileArgs,
    ExperimentalArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ near: 1, far: 8e5 }}>
    <Content {...props} />
    <Description>
      <p>
        Lane 3 is a 1.2 to 12 km tower instead of a slab. With{' '}
        <em>experimental.convectiveProfile</em> on, its vertical shape law gains
        a concave shoulder near the top, and coverage concentrates into isolated
        columns. The two thin decks keep the shipped profile: the shoulder only
        reaches layers over 4 km.
      </p>
      <p>
        <strong>No WebGL counterpart.</strong> The reference's four-term profile
        is convex on [0,1] and cannot rise then flatten, so it has no anvil and
        no way to get one from its existing knobs.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext, { coverage: 0.3 }),
  ...localDateArgs({ dayOfYear: 0, timeOfDay: 13 }),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs(),
  ...convectiveProfileArgs(),
  ...experimentalArgs(),
  'experimental-convectiveProfile': true
}

Story.argTypes = {
  ...cloudsArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes(),
  ...convectiveProfileArgTypes(),
  ...experimentalArgTypes(),
  ...cloudLayerArgTypes()
}
