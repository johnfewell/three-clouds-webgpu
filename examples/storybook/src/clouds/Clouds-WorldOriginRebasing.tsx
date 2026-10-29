// clouds/Clouds/WorldOriginRebasing on the port: a LOCAL scene (a white sphere
// at the origin) whose world frame is north-up-east at a location, so the
// atmosphere and clouds are placed through `worldToECEFMatrix`. The sphere is
// lit by an AtmosphereLight (ADR-007's light-node consumer, 3.2b). Location,
// date, exposure and camera match the WebGL story

import { OrbitControls } from '@react-three/drei'
import { extend, useThree, type ThreeElement } from '@react-three/fiber'
import { useLayoutEffect, useRef, type FC } from 'react'
import { AgXToneMapping } from 'three'
import { CloudsContext } from 'three-clouds-webgpu'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import {
  MeshStandardNodeMaterial,
  type Renderer,
  type Node as ThreeNode
} from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { AtmosphereLight } from '@takram/three-atmosphere/webgpu'
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
  locationArgs,
  locationArgTypes,
  useLocationControls,
  type LocationArgs
} from '../vendor/controls/locationControls'
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
import { createCloudShadowedLightNodeClass } from './helpers/cloudShadowedLight'
import {
  CloudsPostProcessing,
  type CloudShadowConsumer
} from './helpers/CloudsPostProcessing'
import { useBakedCloudTextures } from './helpers/useBakedCloudTextures'
import { useJitterTexture } from './helpers/useJitterTexture'

declare module '@react-three/fiber' {
  interface ThreeElements {
    atmosphereLight: ThreeElement<typeof AtmosphereLight>
  }
}

extend({ AtmosphereLight })

const referenceContext = /*#__PURE__*/ new CloudsContext()

// The cloud-shadowed light node reads its shadow functions from here. The
// class is registered on the renderer before anything builds (onInit below),
// and CloudsPostProcessing fills the holder when it builds
const shadowConsumer: { current: CloudShadowConsumer | null } = {
  current: null
}
const CloudShadowedLightNode =
  /*#__PURE__*/ createCloudShadowedLightNodeClass(shadowConsumer)

// shadow.maxFar 1e5 is the WebGL story's `shadow-maxFar={1e5}`
const Controls: FC = () => {
  const { context: cloudsContext } = useClouds()
  useCloudsControls(cloudsContext, { shadowMaxFar: 1e5 })
  useCloudLayerControls(cloudsContext)
  return null
}

const Content: FC<StoryProps> = () => {
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
          velocity: highpVelocity as unknown as ThreeNode
        })
      ),
    [scene, camera]
  )

  const jitterTexture = useJitterTexture()
  const textures = useBakedCloudTextures()

  // The world frame: the north-up-east frame at the location, written into
  // the atmosphere context's matrixWorldToECEF (CloudsPostProcessing copies it
  // to the clouds context every frame). This is the rebasing.
  useLocationControls(atmosphereContext.matrixWorldToECEF.value)

  // Local date controls (the longitude comes from the location args):
  useLocalDateControls(date => {
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

  const material = useResource(() => {
    const material = new MeshStandardNodeMaterial()
    material.color.set('white')
    return material
  }, [])
  const sphereRef = useRef(null)

  if (textures == null || jitterTexture == null) return null

  return (
    <>
      <OrbitControls target={[0, 0.5, 0]} minDistance={1} />
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
          lighting='lights'
          shadowConsumer={shadowConsumer}
        />
        {
          // Lit objects mount with the clouds, so the light node built for the
          // sphere's material sees the shadow functions (cloudShadowedLight.ts)
        }
        <atmosphereLight />
        <mesh ref={sphereRef} position={[0, 0.5, 0]} material={material}>
          <sphereGeometry args={[0.5, 128, 128]} />
        </mesh>
      </Clouds>
    </>
  )
}

interface StoryProps {}

interface StoryArgs
  extends
    CloudsArgs,
    CloudLayerArgs,
    LocationArgs,
    LocalDateArgs,
    ToneMappingArgs,
    OutputPassArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas
    camera={{ position: [2, 1, 2], near: 0.1, far: 1e5 }}
    renderer={{
      onInit: renderer => {
        renderer.library.addLight(CloudShadowedLightNode, AtmosphereLight)
      }
    }}
  >
    <Content {...props} />
    <Description>
      <p>
        A local scene rebased to a location through <em>worldToECEFMatrix</em>:
        the sphere is lit by an AtmosphereLight carrying the clouds&apos;
        shadow. Move the location to move the world.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...cloudLayerArgs(referenceContext),
  ...locationArgs({
    longitude: 30,
    latitude: 35,
    height: 300
  }),
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
  ...locationArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes()
}
