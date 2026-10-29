// clouds/3D Tiles Renderer Integration on the port, the WebGPU counterpart of
// the WebGL 3DTilesRenderer-Story.tsx: Google 3D Tiles under the default
// clouds, post-lit with cloud shadow and light shafts, parameters verbatim
// Composed like upstream's 3DTilesRenderer-PostProcessLighting WebGPU story
// (node-material tiles, an overlay scene for the pivot), clouds as in Basic

import { useThree } from '@react-three/fiber'
import { useCallback, useLayoutEffect, useMemo, type FC } from 'react'
import { AgXToneMapping, Scene } from 'three'
import { CloudsContext } from 'three-clouds-webgpu'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import {
  MeshBasicNodeMaterial,
  type Renderer,
  type Node as ThreeNode
} from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { highpVelocity } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../vendor/components/createStory'
import { Description, TilesAttribution } from '../vendor/components/Description'
import { Globe } from '../vendor/components/Globe'
import { GlobeControls } from '../vendor/components/GlobeControls'
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
import {
  usePointOfView,
  type PointOfViewProps
} from '../vendor/hooks/usePointOfView'
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
import { useBakedCloudTextures } from './helpers/useBakedCloudTextures'
import { useJitterTexture } from './helpers/useJitterTexture'

const referenceContext = /*#__PURE__*/ new CloudsContext()

// shadow.farScale 0.25 is the WebGL story's `shadow-farScale={0.25}`
const Controls: FC = () => {
  const { context: cloudsContext } = useClouds()
  useCloudsControls(cloudsContext, { shadowFarScale: 0.25 })
  useCloudLayerControls(cloudsContext)
  return null
}

const Content: FC<StoryProps> = ({
  longitude,
  latitude,
  height,
  heading,
  pitch,
  distance
}) => {
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  const overlayScene = useMemo(() => new Scene(), [])

  const atmosphereContext = useResource(() => createAtmosphereContext(), [])
  atmosphereContext.camera = camera

  // The atmosphere on the renderer BEFORE anything builds (see Clouds/Basic)
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
          velocity: highpVelocity as unknown as ThreeNode
        })
      ),
    [scene, camera]
  )

  const jitterTexture = useJitterTexture()
  const textures = useBakedCloudTextures()

  // Apply the initial point of view. GlobeControls takes over from there
  usePointOfView({ longitude, latitude, height, heading, pitch, distance })

  // Local date controls (depends on the longitude of the location):
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

  // Google Maps API key (upstream's arg; the Globe falls back to Cesium Ion's
  // copy of the same tileset when it is empty):
  const apiKey = useControl(({ googleMapsApiKey }: StoryArgs) =>
    googleMapsApiKey !== '' ? googleMapsApiKey : undefined
  )

  return (
    <>
      <Globe
        apiKey={apiKey}
        materialHandler={useCallback(() => new MeshBasicNodeMaterial(), [])}
      >
        <GlobeControls enableDamping overlayScene={overlayScene} />
      </Globe>
      {textures != null && jitterTexture != null && (
        <Clouds
          sceneDepth={scenePass.getTextureNode('depth')}
          localWeatherTexture={textures.localWeatherTexture}
          shapeTexture={textures.shapeTexture}
          shapeDetailTexture={textures.shapeDetailTexture}
          turbulenceTexture={textures.turbulenceTexture}
          stbnTexture={jitterTexture}
        >
          <Controls />
          <CloudsPostProcessing
            scenePass={scenePass}
            atmosphereContext={atmosphereContext}
            // The WebGL story's <AerialPerspective albedoScale={2 / Math.PI}>
            albedoScale={2 / Math.PI}
            overlayScene={overlayScene}
          />
        </Clouds>
      )}
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
    OutputPassArgs {
  googleMapsApiKey: string
}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas>
    <Content {...props} />
    <Description>
      <TilesAttribution />
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  googleMapsApiKey: '',
  ...cloudsArgs(referenceContext, { coverage: 0.3, animate: true }),
  ...cloudLayerArgs(referenceContext),
  ...localDateArgs(),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs()
}

Story.argTypes = {
  googleMapsApiKey: { control: 'text' },
  ...cloudsArgTypes(),
  ...cloudLayerArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes()
}
