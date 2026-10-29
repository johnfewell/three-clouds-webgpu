// clouds/Clouds/CustomMaterialShadow on the port: the cloud shadow taken by a
// material of the CONSUMER's own. The reference reaches the WebGL
// clouds through an aerial post pass, which lights the ground, and a water,
// vegetation or particle surface the post pass does not own needs the shadow
// itself. That is what pass.cloudShadowAt is for

import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, type FC } from 'react'
import { AgXToneMapping, Color, Matrix4, Quaternion, Vector3 } from 'three'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import {
  color,
  context,
  mrt,
  normalView,
  output,
  pass,
  positionWorld
} from 'three/tsl'
import {
  MeshStandardNodeMaterial,
  type Renderer,
  type Node as ThreeNode
} from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'
import { highpVelocity } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../vendor/components/createStory'
import { Description } from '../vendor/components/Description'
import { WebGPUCanvas } from '../vendor/components/WebGPUCanvas'
import {
  localDateArgs,
  localDateArgTypes
} from '../vendor/controls/localDateControls'
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
import { createAtmosphereContext } from './helpers/atmosphereContext'
import { CloudsPostProcessing } from './helpers/CloudsPostProcessing'
import { useBakedCloudTextures } from './helpers/useBakedCloudTextures'
import { useJitterTexture } from './helpers/useJitterTexture'

const date = Date.parse('2025-01-01T07:00:00Z')

// The pose the other clouds stories use (30°E, 35°N), and the ENU frame at it,
// placed the way examples/parity/src/scenes/synthetic.ts places its meshes
const ANCHOR_ECEF = /*#__PURE__*/ new Geodetic(
  radians(30),
  radians(35),
  0
).toECEF(new Vector3())
const ENU_AT_ANCHOR =
  /*#__PURE__*/ Ellipsoid.WGS84.getEastNorthUpFrame(ANCHOR_ECEF)
const EAST_AT_ANCHOR = /*#__PURE__*/ new Vector3(1, 0, 0)
  .applyMatrix4(new Matrix4().extractRotation(ENU_AT_ANCHOR))
  .normalize()
const PATCH_ROTATION = /*#__PURE__*/ new Quaternion().setFromRotationMatrix(
  new Matrix4().extractRotation(ENU_AT_ANCHOR)
)

// Two patches at the same location, one taking the shadow and one not. Side by
// side they answer the only question that matters: does the node change the
// picture, and only where a cloud is
const PATCH_SIZE = 6000
const PATCH_ALBEDO = 0.35

// A child of <Clouds>, because that is where the pass to ask lives
const Patch: FC<{ offsetEast: number; shadowed: boolean }> = ({
  offsetEast,
  shadowed
}) => {
  const { pass } = useClouds()

  const material = useMemo(() => {
    const m = new MeshStandardNodeMaterial()
    m.color = new Color(PATCH_ALBEDO, PATCH_ALBEDO, PATCH_ALBEDO)
    m.roughness = 1
    if (shadowed) {
      // One line is the whole API: a 0..1 sun transmittance to multiply by
      m.colorNode = color(m.color).mul(pass.cloudShadowAt(positionWorld))
    }
    return m
  }, [pass, shadowed])

  const position = useMemo(
    () => ANCHOR_ECEF.clone().addScaledVector(EAST_AT_ANCHOR, offsetEast),
    [offsetEast]
  )

  return (
    <mesh material={material} position={position} quaternion={PATCH_ROTATION}>
      <planeGeometry args={[PATCH_SIZE, PATCH_SIZE]} />
    </mesh>
  )
}

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)

  const atmosphereContext = useResource(() => {
    const atmosphere = createAtmosphereContext()
    getECIToECEFRotationMatrix(date, atmosphere.matrixECIToECEF.value)
    getSunDirectionECI(date, atmosphere.sunDirectionECEF.value).applyMatrix4(
      atmosphere.matrixECIToECEF.value
    )
    return atmosphere
  }, [])
  atmosphereContext.camera = camera

  // The atmosphere goes on the renderer before the aerial node builds, as in
  // every other story here
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
          velocity: highpVelocity as unknown as ThreeNode
        })
      ),
    [scene, camera]
  )

  const jitterTexture = useJitterTexture()
  const textures = useBakedCloudTextures()

  if (textures == null || jitterTexture == null) return null

  return (
    <>
      <OrbitControls target={ANCHOR_ECEF} minDistance={200} />
      <Clouds
        sceneDepth={scenePass.getTextureNode('depth')}
        localWeatherTexture={textures.localWeatherTexture}
        shapeTexture={textures.shapeTexture}
        shapeDetailTexture={textures.shapeDetailTexture}
        turbulenceTexture={textures.turbulenceTexture}
        stbnTexture={jitterTexture}
      >
        <Patch offsetEast={-PATCH_SIZE * 0.75} shadowed />
        <Patch offsetEast={PATCH_SIZE * 0.75} shadowed={false} />
        <CloudsPostProcessing
          scenePass={scenePass}
          atmosphereContext={atmosphereContext}
        />
      </Clouds>
    </>
  )
}

export const Story: StoryFC<{}, ToneMappingArgs> = () => (
  <WebGPUCanvas
    camera={{
      near: 1,
      far: 4e5,
      // MinimalSetup's camera: above the pair, looking down at it
      position: [4529893.894855564, 2615333.425024031, 3638042.815326614],
      rotation: [0.6423512931563148, -0.2928348796035058, -0.8344824769956042]
    }}
  >
    <Content />
    <Description>
      <p>
        Two ground patches at the same location. The left one multiplies its
        colour by <code>pass.cloudShadowAt(positionWorld)</code>, the right one
        does not, so the pair shows the cloud shadow reaching a material the
        aerial post pass does not own.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...localDateArgs({ dayOfYear: 0, timeOfDay: 7 }),
  ...rendererArgs()
}

Story.argTypes = {
  ...toneMappingArgTypes(),
  ...localDateArgTypes(),
  ...rendererArgTypes()
}

export default Story
