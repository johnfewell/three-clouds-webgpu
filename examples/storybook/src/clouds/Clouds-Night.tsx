// clouds/Clouds/Night on the port, with no WebGL counterpart: the reference has
// one light and it is the sun's, so its clouds go black after sunset. The stars
// and the moon disc are takram's, on the sky the aerial node paints, and
// experimental.moonlight lights the clouds. The clouds composite over that sky,
// so a cloud covers a star for free. docs/night-sky.md

import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, type FC } from 'react'
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
import { useControl } from '../vendor/hooks/useControl'
import { type PointOfViewProps } from '../vendor/hooks/usePointOfView'
import { useResource } from '../vendor/hooks/useResource'
import { useTransientControl } from '../vendor/hooks/useTransientControl'
import {
  cloudsArgs,
  cloudsArgTypes,
  useCloudsControls,
  type CloudsArgs
} from './controls/cloudsControls'
import {
  experimentalArgs,
  experimentalArgTypes,
  selectedExperiments,
  type ExperimentalArgs
} from './controls/experimentalControls'
import {
  moonlightArgs,
  moonlightArgTypes,
  useMoonlightControls,
  type MoonlightArgs
} from './controls/moonlightControls'
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

// The panel's initial values, read off a context that already carries the
// option this story is about
const referenceContext = /*#__PURE__*/ (() => {
  const reference = new CloudsContext()
  reference.experimental = { moonlight: true }
  return reference
})()

const Controls: FC = () => {
  const { context: cloudsContext } = useClouds()
  useCloudsControls(cloudsContext)
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
  // The moon disc rides the same gain as the clouds. At 1 the disc is the
  // physical 2.5e-6 of the sun's radiance, so clouds lit at 4e5 would be lit by
  // a moon the frame cannot show
  const moonIntensity = useControl<MoonlightArgs, number>(a => a.moonGain)

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

  // No sky on the scene background, as in every other story: the aerial node
  // paints its own sky over the far plane, and this is that sky
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

  // One date drives the sun, the moon and the stars together, so the phase of
  // the disc and the direction the clouds are lit from cannot disagree
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

  const Moonlight: FC = () => {
    const { context: cloudsContext } = useClouds()
    useMoonlightControls(
      cloudsContext,
      atmosphereContext.moonDirectionECEF.value
    )
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
        <Controls />
        <Moonlight />
        {ground.ocean && <GroundOcean />}
        <CloudsPostProcessing
          albedoScale={ground.albedoScale}
          lightingMask={ground.ocean}
          scenePass={scenePass}
          atmosphereContext={atmosphereContext}
          nightSky
          moonIntensity={moonIntensity}
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
    MoonlightArgs,
    ExperimentalArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      <p>
        Night over the same four default layers. The stars and the moon disc are
        takram's, on the sky the aerial node paints; the clouds composite over
        it, so a cloud that covers a star hides it.
      </p>
      <p>
        With <em>experimental.moonlight</em> on, the march's one light is
        retargeted onto the moon once the sun is 6 degrees down, at the phase
        the sun-moon elongation implies. <strong>Moon gain</strong> is the
        artistic multiplier over the physical ratio of 2.5e-6, which a fixed
        exposure cannot show.
      </p>
      <p>
        <strong>No WebGL counterpart.</strong> The reference has one light and
        it is the sun's.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...localDateArgs({
    // Found by scanning the year for a nearly full moon 14 degrees up, dead
    // ahead at the default heading, with the sun 21 degrees below the horizon
    dayOfYear: 151,
    timeOfDay: 21.25
  }),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs(),
  ...moonlightArgs(),
  ...experimentalArgs(),
  'experimental-moonlight': true
}

Story.argTypes = {
  ...cloudsArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes(),
  ...moonlightArgTypes(),
  ...experimentalArgTypes()
}
