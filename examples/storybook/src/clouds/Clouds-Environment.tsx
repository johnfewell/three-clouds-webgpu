// Clouds in the environment map, on the port: clouds/Clouds/Basic's scene with
// two reflective spheres reading whatever the environment node holds. The frame
// cost is measured here because the claim is a spike on one frame in four,
// which an averaged benchmark cannot see

import { OrbitControls } from '@react-three/drei'
import {
  extend,
  useFrame,
  useThree,
  type ThreeElement
} from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef, type FC } from 'react'
import { AgXToneMapping, Vector3 } from 'three'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import {
  MeshPhysicalNodeMaterial,
  type Renderer,
  type Node as ThreeNode
} from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { AtmosphereLight, sky } from '@takram/three-atmosphere/webgpu'
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
import {
  usePointOfView,
  type PointOfViewProps
} from '../vendor/hooks/usePointOfView'
import { useResource } from '../vendor/hooks/useResource'
import { useTransientControl } from '../vendor/hooks/useTransientControl'
import {
  experimentalArgs,
  experimentalArgTypes,
  selectedExperiments,
  type ExperimentalArgs
} from './controls/experimentalControls'
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

// ADR-007's light-node consumer. An AtmosphereLight is what leaves a mirror's
// specular alone: the post-lit aerial node recomputes every pixel from albedo
// and normal. Registered on the renderer in onInit below
const shadowConsumer: { current: CloudShadowConsumer | null } = {
  current: null
}
const CloudShadowedLightNode =
  /*#__PURE__*/ createCloudShadowedLightNodeClass(shadowConsumer)

/**
 * The experiment panel, and nothing else: this story is the Basic scene, so the
 * cloud and layer panels would be a second control surface for the same knobs.
 * A transient control, because assigning experimental rebuilds the graph and
 * resets the temporal history, which is what every other experiment story does
 */
const Controls: FC = () => {
  const { context } = useClouds()
  useTransientControl(
    (a: StoryArgs) => selectedExperiments(a),
    experiments => {
      context.experimental = experiments
    }
  )
  return null
}

/**
 * Two reflective surfaces and a measurement of what the map costs.
 *
 * A metal sphere at zero roughness is the mirror case: its whole colour is the
 * environment, so a cloud missing from the map is a hole in it. The second at
 * 0.2 is the IBL case, the blurred PMREM read a PBR scene's ambient wants
 */
const Reflectors: FC<{
  latitude: number
  longitude: number
}> = ({ latitude, longitude }) => {
  const { pass, context } = useClouds()
  const scene = useThree(({ scene }) => scene)

  // Returned as a tuple: useResource disposes an array elementwise and disposes a
  // bare object through its own dispose, which a pair of materials does not have
  const [mirror, glossy] = useResource(() => {
    const reflective = new MeshPhysicalNodeMaterial()
    reflective.color.set('#ffffff')
    reflective.metalness = 1
    reflective.roughness = 0
    const blurred = new MeshPhysicalNodeMaterial()
    blurred.color.set('#20242c')
    blurred.metalness = 0.6
    blurred.roughness = 0.2
    return [reflective, blurred]
  }, [])

  // Assigned before any material builds. The node reads null until the option
  // is on and the graph exists, and a null node in environmentNode is a TSL
  // error rather than a quiet fallback, so it is only assigned when on
  const enabled = context.experimental.cloudEnvironment
  useLayoutEffect(() => {
    const target = scene as unknown as { environmentNode?: unknown }
    target.environmentNode = enabled ? pass.environment : null
    return () => {
      target.environmentNode = null
    }
  }, [scene, pass, enabled])

  const origin = useMemo(
    () =>
      new Geodetic(radians(longitude), radians(latitude), 300).toECEF(
        new Vector3()
      ),
    [longitude, latitude]
  )

  return (
    <group position={origin}>
      <mesh position={[600, 400, -900]} material={mirror}>
        <sphereGeometry args={[320, 64, 32]} />
      </mesh>
      // A second ball rather than a plate: at this camera's four degrees of //
      pitch a horizontal mirror reflects the sky it sits under, which is the //
      sky behind it in the frame, so it reads as nothing at all
      <mesh position={[-750, 450, -700]} material={glossy}>
        <sphereGeometry args={[420, 48, 24]} />
      </mesh>
    </group>
  )
}

/**
 * Frame intervals split by whether the map was refreshed on that frame.
 *
 * This probe runs before the render, so the interval it measures ENDS on the
 * frame that rendered the previous one, and the bakeCount it reads is the count
 * after that render, so a moved count attributes the interval to the frame that
 * did the bake. The display refresh cap has to be lifted for any of it to mean
 * anything, or every arm reads the cap
 */
interface ProbeState {
  previous: number
  warmup: number
  seen: number
  all: number[]
  onBake: number[]
  between: number[]
  reported: boolean
}

// The node's public surface, spelled out: the class is not exported, because a
// consumer reaches it as CloudsPassNode['environment']
type EnvironmentProbe = {
  size: number
  updateInterval: number
  bakeCount: number
}

/** One console line per arm, the numbers docs/EXPERIMENTAL.md quotes */
const report = (s: ProbeState, environment: EnvironmentProbe): void => {
  s.reported = true
  const sorted = [...s.all].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.floor(sorted.length * q)]
  const median = (values: number[]) => {
    const copy = [...values].sort((a, b) => a - b)
    return copy.length === 0 ? 0 : copy[Math.floor(copy.length / 2)]
  }
  console.log(
    '[env-measure]',
    JSON.stringify({
      faceSize: environment.size,
      updateInterval: environment.updateInterval,
      optionOn: environment.bakeCount > 0,
      frames: sorted.length,
      meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      medianMs: at(0.5),
      p90Ms: at(0.9),
      maxMs: sorted[sorted.length - 1],
      bakeFrameMedianMs: median(s.onBake),
      otherFrameMedianMs: median(s.between),
      bakeFrames: s.onBake.length,
      otherFrames: s.between.length
    })
  )
}

const CostProbe: FC = () => {
  const { pass } = useClouds()
  const state = useRef<ProbeState>({
    previous: 0,
    warmup: 0,
    seen: -1,
    all: [],
    onBake: [],
    between: [],
    reported: false
  })

  useFrame(() => {
    const s = state.current
    const now = performance.now()
    const interval = now - s.previous
    s.previous = now
    if (s.warmup < 30) {
      s.warmup += 1
      return
    }
    if (interval <= 0 || interval > 2000) return
    const bakes = pass.environment.bakeCount
    // Every arm records, including the option-off one, which is the half of the
    // comparison that turns a spike into a cost
    s.all.push(interval)
    if (!s.reported && s.all.length >= 240) report(s, pass.environment)
    if (bakes === 0) return
    if (bakes < s.seen) {
      // A graph rebuild resets the counter, so the arms start again
      s.seen = -1
      s.onBake.length = 0
      s.between.length = 0
    }
    if (bakes === s.seen) {
      s.between.push(interval)
      return
    }
    s.seen = bakes
    s.onBake.push(interval)
  })
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

  const atmosphereContext = useResource(() => createAtmosphereContext(), [])
  atmosphereContext.camera = camera

  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  // The atmosphere's own sky on the background. Under 'post' lighting the aerial
  // node paints every far-plane pixel instead, as every other story does, and
  // also recomputes every lit pixel, which is what a mirror cannot survive
  useLayoutEffect(() => {
    const target = scene as unknown as { backgroundNode?: unknown }
    target.backgroundNode = sky()
    return () => {
      target.backgroundNode = null
    }
  }, [scene])

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

  usePointOfView({ longitude, latitude, height, heading, pitch, distance })
  // Hoisted out of the JSX: a hook below the early return below changes its
  // order between renders, and React throws on that
  const target = useMemo(
    () =>
      new Geodetic(radians(longitude), radians(latitude), height).toECEF(
        new Vector3()
      ),
    [longitude, latitude, height]
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
      <OrbitControls minDistance={100} target={target} />
      <Clouds
        sceneDepth={scenePass.getTextureNode('depth')}
        localWeatherTexture={textures.localWeatherTexture}
        shapeTexture={textures.shapeTexture}
        shapeDetailTexture={textures.shapeDetailTexture}
        turbulenceTexture={textures.turbulenceTexture}
        stbnTexture={jitterTexture}
      >
        <Controls />
        <Reflectors latitude={latitude} longitude={longitude} />
        <CostProbe />
        <CloudsPostProcessing
          scenePass={scenePass}
          atmosphereContext={atmosphereContext}
          lighting='lights'
          shadowConsumer={shadowConsumer}
        />
        <atmosphereLight />
      </Clouds>
    </>
  )
}

interface StoryProps extends PointOfViewProps {}

interface StoryArgs
  extends ExperimentalArgs, LocalDateArgs, ToneMappingArgs, OutputPassArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas
    camera={{ near: 1, far: 4e5 }}
    renderer={{
      onInit: renderer => {
        renderer.library.addLight(CloudShadowedLightNode, AtmosphereLight)
      }
    }}
  >
    <Content {...props} />
    <Description>
      <p>
        A mirror sphere and a glossy one beside it, both reflecting the cloud
        environment map (<code>cloudsPass.environment</code> on{' '}
        <code>scene.environmentNode</code>). Drag to orbit.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...experimentalArgs(),
  'experimental-cloudEnvironment': true,
  ...localDateArgs({ dayOfYear: 0, timeOfDay: 9 }),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs()
}

Story.argTypes = {
  ...experimentalArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes()
}
