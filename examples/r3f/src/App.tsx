// The r3f consumer of three-clouds-webgpu, verified on WebGPU by Phase 4 e2e
// smoke test 9. <Clouds> owns state and lifecycle only, since
// r3f has no context for a WebGPU/TSL post chain, so the ADR-001 graph is
// built here as examples/basic builds it. <Clouds> and <CloudLayer> add the
// declarative layer surface and prop forwarding

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState, type FC } from 'react'
import {
  AgXToneMapping,
  Color,
  DefaultLoadingManager,
  Matrix4,
  Vector2,
  Vector3,
  type Camera
} from 'three'
import {
  aerialPerspectiveWithCloudShadow,
  createCloudShadowTransmittance,
  createJitterTexture,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL,
  loadBakedCloudTextures,
  type BakedCloudTextures,
  type CloudsContext,
  type GroundShadowExtraDeps
} from 'three-clouds-webgpu'
import { CloudLayer, Clouds, useClouds } from 'three-clouds-webgpu/r3f'
// mrt/normalView/output/pass are TSL exports, NOT three/webgpu exports
// Grouping them under three/webgpu was a module-load failure, now caught by
// `pnpm typecheck:examples`
import {
  context,
  float,
  Fn,
  mrt,
  normalView,
  output,
  pass,
  uniform,
  uv,
  vec4
} from 'three/tsl'
import {
  RenderPipeline,
  WebGPURenderer,
  type Node,
  type Renderer
} from 'three/webgpu'

import {
  DEFAULT_STARS_DATA_URL,
  getSunDirectionECEF
} from '@takram/three-atmosphere'
import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import {
  DEFAULT_STBN_URL,
  Ellipsoid,
  EllipsoidGeometry,
  Geodetic,
  PointOfView
} from '@takram/three-geospatial'
import {
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

import { Globe } from './Globe'
import { smokeProbe } from './smokeProbe'

// Wall-clock rate, matching the upstream story (`animate: true`). A 1/60
// slowdown was tried for the visible noise, but the WebGL story animates at
// full rate and is not noisy, so it only made the scene look wrong

// Two upstream @takram typing gaps, one small typed helper each: they come
// back as bare Node<T>, so the helpers are what let the graph in Composite
// below read as three's API. The values are a mat4 node and a vec3
interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

const toPositionView = (
  cam: Camera,
  depth: Node<'float'>,
  viewZ: Node<'float'>
): Node<'vec3'> =>
  screenToPositionView(
    uv(),
    depth,
    viewZ,
    projectionMatrix(cam),
    inverseProjectionMatrix(cam)
  ) as unknown as Node<'vec3'>

const toWorldPosition = (cam: Camera, posView: Node<'vec3'>): Node<'vec3'> =>
  (inverseViewMatrix(cam) as unknown as Mat4NodeLike).mul(vec4(posView, 1)).xyz

const TIME_SCALE = 1
const DEG = Math.PI / 180
const tilesEnabled = new URLSearchParams(location.search).get('tiles') === '1'

// The atmosphere internally requests upstream STBN. Use the same local MIT
// blue-noise volume as the clouds instead of adding a NVIDIA dataset dependency
DefaultLoadingManager.setURLModifier(url => {
  if (url === DEFAULT_STBN_URL) return 'assets/atmosphere-jitter.bin'
  if (url === DEFAULT_STARS_DATA_URL) return 'assets/stars.bin'
  return url
})

// The upstream "3D Tiles Renderer Integration / London" story's parameters,
// verbatim. The city geometry needs a Google API key and is NOT reproduced
// here: this is that story's sky, sun, camera and clouds over the ellipsoid
const LONDON = {
  longitude: -0.1293,
  latitude: 51.4836,
  heading: -94,
  pitch: -7,
  distance: 3231,
  coverage: 0.35,
  exposure: 15,
  // dayOfYear 0, timeOfDay 9.4 -> 1 January, 09:24. London sits within a few
  // minutes of UTC, and the story derives local time from longitude
  date: new Date(Date.UTC(2024, 0, 1, 9, 24))
} as const

// Both contexts register in the `gl` factory before any graph builds, so they
// live at module scope (the clouds one is a HOLDER filled on mount). Scattering
// LUT, not raymarch: ADR-013 Amendment 6 (6.62 vs 8.75 ms)
const atmosphere = new AtmosphereContext()
atmosphere.raymarchScattering = false
const cloudsHolder: { current: CloudsContext | null } = { current: null }

// Everything downstream of the clouds pass: aerial perspective, the composite,
// and the render loop. It reads the pass out of <Clouds> rather than creating
// one, which is the division of labour the ruling set
const Composite: FC<{ scenePass: ReturnType<typeof pass> }> = ({
  scenePass
}) => {
  const { pass: cloudsPass, context: cloudsContext } = useClouds()
  const camera = useThree(state => state.camera)
  const renderer = useThree(state => state.gl) as unknown as Renderer

  const pipeline = useMemo(() => {
    const worldToECEFMatrixU = uniform(
      new Matrix4().copy(cloudsContext.worldToECEFMatrix)
    )
    const altitudeCorrectionU = uniform(
      cloudsContext.altitudeCorrection.clone()
    )
    const shadowDeps: GroundShadowExtraDeps = {
      viewMatrix: uniform(camera.matrixWorldInverse),
      cameraNear: uniform(camera.near),
      sunDirection: uniform(cloudsContext.sunDirection.clone()),
      bottomRadius: float(cloudsContext.bottomRadius),
      ecefToWorldMatrix: uniform(
        new Matrix4().copy(cloudsContext.ecefToWorldMatrix)
      ),
      altitudeCorrection: altitudeCorrectionU,
      worldToUnit: uniform(1 / cloudsContext.bottomRadius),
      temporalJitter: uniform(new Vector2()),
      resolution: uniform(new Vector2().copy(cloudsContext.shadow.mapSize))
    }
    const transmittance = createCloudShadowTransmittance(
      cloudsPass.cloudShadow,
      shadowDeps,
      { enabled: true }
    )

    const sceneDepthTex = scenePass.getTextureNode('depth')
    const aerialShadowNode = Fn(() => {
      const d = sceneDepthTex.r.toConst()
      const viewZ = depthToViewZ(d, camera)
      const posView = toPositionView(camera, d, viewZ)
      const posWorld = toWorldPosition(camera, posView)
      const posECEF = worldToECEFMatrixU.mul(vec4(posWorld, 1)).xyz
      return transmittance(posECEF.add(altitudeCorrectionU), float(0), float(0))
    })()

    const aerial = aerialPerspectiveWithCloudShadow(
      scenePass.getTextureNode('output'),
      sceneDepthTex,
      cloudsPass.cloudShadowLength,
      aerialShadowNode,
      scenePass.getTextureNode('normal')
    )
    aerial.lighting = true

    const p = new RenderPipeline(renderer)
    p.outputNode = cloudsPass.composite(aerial)
    return p
  }, [cloudsPass, cloudsContext, camera, renderer, scenePass])

  useEffect(() => () => pipeline.dispose(), [pipeline])

  // Priority 1 takes over the frame loop: this renders the pipeline instead of
  // r3f's default scene render, which would bypass the composite entirely
  useFrame(() => {
    if (smokeProbe != null) cloudsContext.enabled = smokeProbe.cloudsEnabled
    void pipeline.render()
    if (smokeProbe != null) smokeProbe.frames++
  }, 1)

  return null
}

// The aerial node paints the sky over every far-plane pixel, so the background
// is a plain clear rather than a second sky that is always overwritten
const Sky: FC = () => {
  const scene = useThree(state => state.scene)
  useEffect(() => {
    scene.background = new Color(0x000000)
  }, [scene])
  return null
}

const Ground: FC = () => {
  const geometry = useMemo(
    () => new EllipsoidGeometry(Ellipsoid.WGS84.radii, 128, 64),
    []
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial color='#667c74' />
    </mesh>
  )
}

const CloudsScene: FC = () => {
  const scene = useThree(state => state.scene)
  const camera = useThree(state => state.camera)
  // Fullscreen passes otherwise supply their quad camera to atmosphere uniforms
  atmosphere.camera = camera
  const stbnTexture = useMemo(() => createJitterTexture(), [])
  useEffect(() => () => stbnTexture.dispose(), [stbnTexture])

  // Baked assets, loaded once, and rendering waits for them. Typed as the
  // exported interface: Awaited<ReturnType<...>> degrades to `any` wherever
  // the built types are missing, so lint depended on whether anyone had built
  const [textures, setTextures] = useState<BakedCloudTextures | null>(null)
  useEffect(() => {
    let live = true
    void loadBakedCloudTextures({
      localWeather: DEFAULT_LOCAL_WEATHER_URL,
      turbulence: DEFAULT_TURBULENCE_URL,
      shape: DEFAULT_SHAPE_URL,
      shapeDetail: DEFAULT_SHAPE_DETAIL_URL
    }).then(loaded => {
      if (live) setTextures(loaded)
    })
    return () => {
      live = false
    }
  }, [])

  const scenePass = useMemo(() => {
    const p = pass(scene, camera, { samples: 0 })
    p.setMRT(mrt({ output, normal: normalView }))
    return p
  }, [scene, camera])

  // THE SUN, from the real date at the real place, as the upstream story does
  // (`updateByDate`). Without it the scene renders BLACK WITH NO ERROR: both
  // sun directions start as the zero vector, which is valid arithmetic
  const sunDirection = useMemo(
    () => getSunDirectionECEF(LONDON.date, new Vector3()),
    []
  )

  useEffect(() => {
    atmosphere.sunDirectionECEF.value.copy(sunDirection)
  }, [sunDirection])

  // Camera placed the way the story places it: a PointOfView at a distance,
  // heading and pitch around the geodetic anchor, not a hand-picked xyz
  useEffect(() => {
    const target = new Geodetic(
      LONDON.longitude * DEG,
      LONDON.latitude * DEG,
      0
    ).toECEF()
    new PointOfView(
      LONDON.distance,
      LONDON.heading * DEG,
      LONDON.pitch * DEG
    ).decompose(target, camera.position, camera.quaternion, camera.up)
    camera.updateMatrixWorld()
  }, [camera])

  // time/frame are plain numbers owned by this app (ADR-003), so any pair
  // reproduces the same pixels. `frame` must advance every frame: the pass
  // warns after 16 stalled renders. TIME_SCALE 0 gives a converged still
  const [tick, setTick] = useState({ time: 0, frame: 0 })
  useFrame((_, delta) => {
    setTick(prev => ({
      time: prev.time + (smokeProbe == null ? delta * TIME_SCALE : 0),
      frame: prev.frame + 1
    }))
  })

  if (textures == null) return null

  return (
    <Clouds
      sceneDepth={scenePass.getTextureNode('depth')}
      time={tick.time}
      frame={tick.frame}
      localWeatherTexture={textures.localWeatherTexture}
      shapeTexture={textures.shapeTexture}
      shapeDetailTexture={textures.shapeDetailTexture}
      turbulenceTexture={textures.turbulenceTexture}
      stbnTexture={stbnTexture}
      sunDirection={sunDirection}
      // Coverage decides how much sky is cloud (port default 0.3, London 0.35)
      // A prop, not an effect: the context does not exist until <Clouds>
      // mounts, so an effect here would run first and read null
      coverage={LONDON.coverage}
    >
      <RegisterContexts />
      {
        // The upstream README's three-layer set: two low decks on the r and g
        // channels plus a thin high cirrus on b. A single thin deck is correct
        // but a poor demonstration
      }
      <CloudLayer channel='r' altitude={750} height={650} />
      <CloudLayer channel='g' altitude={1000} height={1200} />
      <CloudLayer
        channel='b'
        altitude={7500}
        height={500}
        densityScale={0.003}
        shapeAmount={0.4}
        shapeDetailAmount={0}
        coverageFilterWidth={0.5}
      />
      <Composite scenePass={scenePass} />
    </Clouds>
  )
}

// Publishes the clouds context into the holder the contextNode reads. It
// cannot REGISTER it: effects run in mount order, and a late registration lost
// the race to <Sky>'s graph. Registration happens in the `gl` factory below
const RegisterContexts: FC = () => {
  const { context: cloudsContext } = useClouds()
  useEffect(() => {
    cloudsHolder.current = cloudsContext
    return () => {
      cloudsHolder.current = null
    }
  }, [cloudsContext])
  return null
}

export const App: FC = () => (
  <Canvas
    // near/far from the upstream story (1, 4e5). The earlier 100 / 1e8 was six
    // orders of magnitude deeper than the scene, costing depth precision in
    // the march and the reprojection. The pose comes from PointOfView
    camera={{ fov: 50, near: 1, far: 4e5 }}
    gl={async props => {
      const renderer = new WebGPURenderer(props as never)
      // AgX at exposure 10, matching the upstream "Basic" story. Neutral at
      // exposure 1 (what this had) is about 1.5 stops darker with a different
      // shoulder, which is most of why the scene read dim and washed out
      renderer.toneMapping = AgXToneMapping
      renderer.toneMappingExposure = LONDON.exposure
      // Registered HERE, before any node graph can be built. Both getters are
      // lazy, so `getClouds` can resolve a context that <Clouds> creates later
      // A missing clouds context throws by name rather than returning null
      renderer.contextNode = context({
        getAtmosphere: () => atmosphere,
        getClouds: () => {
          if (cloudsHolder.current == null) {
            throw new Error(
              'r3f example: clouds context requested before <Clouds> mounted'
            )
          }
          return cloudsHolder.current
        }
      })
      await renderer.init()
      return renderer
    }}
  >
    <Sky />
    {tilesEnabled ? <Globe /> : <Ground />}
    <CloudsScene />
  </Canvas>
)
