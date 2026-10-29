// The minimal three-clouds-webgpu consumer. THIS FILE IS THE WEBGPU.md
// "Usage" SNIPPET: a test keeps the two identical, so the documented wiring
// can never drift from the demonstrated one. Canonical graph per ADR-001:
// MRT scene pass → clouds march → aerial perspective
// (post-lit) → composite → tonemap

import {
  Clock,
  Color,
  Matrix4,
  NeutralToneMapping,
  PerspectiveCamera,
  Scene,
  Vector2
} from 'three'
import {
  aerialPerspectiveWithCloudShadow,
  clouds,
  createCloudShadowTransmittance,
  createJitterTexture,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL,
  loadBakedCloudTextures,
  syncCelestialDirections,
  type GroundShadowExtraDeps
} from 'three-clouds-webgpu'
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
import { RenderPipeline, WebGPURenderer, type Node } from 'three/webgpu'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import {
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

const canvas = document.querySelector('canvas')!
const renderer = new WebGPURenderer({ canvas, antialias: false })
renderer.toneMapping = NeutralToneMapping
// explicit, as the parity harness sets it
renderer.toneMappingExposure = 1
// Without setSize the canvas keeps the HTML default 300x150, and the camera
// aspect below (from innerWidth/innerHeight) would disagree with it: the frame
// would be both tiny AND stretched
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
await renderer.init()

const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 100, 1e8)
// 2.5 km up, aimed at the horizon. From 20 km looking down, a cloud deck
// (tops ~2-3 km) is seen edge-on from far above and reads as almost nothing
// A low camera looking out shows the decks in profile against the sky
camera.position.set(0, 6378137 + 2500, 0)
camera.lookAt(6378137 * 0.35, 6378137 + 4000, 0)

// 1. Register the contexts on the renderer: every node resolves them from
// the renderer's contextNode (the atmosphere's 0.18+ contract)
const atmosphere = new AtmosphereContext()
// Read the precomputed scattering LUT (the WebGL original's method) instead of
// ray-marching it. See Performance
atmosphere.raymarchScattering = false
// The atmosphere needs the SCENE camera. Unset it falls back to the pass's quad
// camera, so cameraPositionUnit stays at the origin and the sky is integrated
// from the Earth's centre along a view-space ray: a hard wedge, one side black
atmosphere.camera = camera
// wired below
const cloudsPass = clouds({ sceneDepth: null })
const cloudsContext = cloudsPass.cloudsContext
renderer.contextNode = context({
  ...(renderer.contextNode?.value ?? {}),
  getAtmosphere: () => atmosphere,
  getClouds: () => cloudsContext
})

// 2. Scene pass writes color + normal MRT. The aerial node paints the sky over
//    every far-plane pixel, so the background is a plain clear, not a second sky
const scene = new Scene()
scene.background = new Color(0x000000)
const scenePass = pass(scene, camera, { samples: 0 })
scenePass.setMRT(mrt({ output, normal: normalView }))

// 3. The march consumes the scene depth node.
cloudsPass.sceneDepth = scenePass.getTextureNode('depth')
cloudsPass.camera = camera

// 4. The reference baked assets and the port's generated blue-noise jitter.
const baked = await loadBakedCloudTextures({
  localWeather: DEFAULT_LOCAL_WEATHER_URL,
  turbulence: DEFAULT_TURBULENCE_URL,
  shape: DEFAULT_SHAPE_URL,
  shapeDetail: DEFAULT_SHAPE_DETAIL_URL
})
Object.assign(cloudsContext, baked)
cloudsContext.stbnTexture = createJitterTexture()

// 4b. THE SUN. Without it the frame is BLACK WITH NO ERROR: both sun
// directions default to the zero vector, valid arithmetic through march, sky
// and shadow. 0.40 is local solar 09:36, and one call writes all three sinks
const timeOfDay = {
  date: new Date('2026-10-04T12:00:00Z'),
  location: { longitude: 0, latitude: 0 },
  timeOfDay: 0.4
}

// 5. Cloud-shadow transmittance: the deps mirror the march's uniforms.
const worldToECEFMatrixU = uniform(
  new Matrix4().copy(cloudsContext.worldToECEFMatrix)
)
const altitudeCorrectionU = uniform(cloudsContext.altitudeCorrection.clone())
const sunDirectionU = uniform(cloudsContext.sunDirection.clone())
const shadowDeps: GroundShadowExtraDeps = {
  viewMatrix: uniform(camera.matrixWorldInverse),
  cameraNear: uniform(camera.near),
  sunDirection: sunDirectionU,
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

// 5b. One sun for the whole frame. A scene missing one of the three copies is
// unshadowed rather than broken, so they are written together. Call it again per
// frame with a new timeOfDay to move the sun. The library reads no clock
syncCelestialDirections(
  [
    {
      sunDirection: atmosphere.sunDirectionECEF,
      moonDirection: atmosphere.moonDirectionECEF
    },
    { sunDirection: cloudsContext.sunDirection },
    { sunDirection: sunDirectionU }
  ],
  timeOfDay
)

// 6. Aerial perspective, post-lit (ADR-001): the aerial node lights the whole
// frame. Unlit-albedo scenes use lighting = true, AtmosphereLight-lit scenes
// use CloudShadowedAtmosphereLightNode instead. Never both under one node.

// Two upstream @takram typing gaps, one small typed helper each: they come
// back as bare Node<T>, so the helpers are what let the graph below read as
// three's API. The values are a mat4 node and a vec3
interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

const toPositionView = (
  depth: Node<'float'>,
  viewZ: Node<'float'>
): Node<'vec3'> =>
  screenToPositionView(
    uv(),
    depth,
    viewZ,
    projectionMatrix(camera),
    inverseProjectionMatrix(camera)
  ) as unknown as Node<'vec3'>

const toWorldPosition = (posView: Node<'vec3'>): Node<'vec3'> =>
  (inverseViewMatrix(camera) as unknown as Mat4NodeLike).mul(vec4(posView, 1))
    .xyz

const sceneDepthTex = scenePass.getTextureNode('depth')
const aerialShadowNode = Fn(() => {
  const d = sceneDepthTex.r.toConst()
  const viewZ = depthToViewZ(d, camera)
  const posView = toPositionView(d, viewZ)
  const posWorld = toWorldPosition(posView)
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

// 7. Composite clouds over the aerial result, then tonemap.
const pipeline = new RenderPipeline(renderer)
pipeline.outputNode = cloudsPass.composite(aerial)

// 8. time/frame are plain numbers owned by the consumer (ADR-003), so no clock
// is baked into the library. resetHistory() invalidates temporal history
// (resize, seek, texture swap)
const clock = new Clock()
let frame = 0
// Temporal upscale and the shadow history converge over hundreds of frames,
// so wall-clock `time` never lets the march noise average out. 1/60 of real
// time stays converged and still looks alive, 0 gives a static frame
const TIME_SCALE = 1 / 60
void renderer.setAnimationLoop(() => {
  cloudsContext.time += clock.getDelta() * TIME_SCALE
  cloudsContext.frame = frame++
  // pipeline.render(), NOT renderer.render(): the pipeline owns
  // `outputNode` (clouds composited over aerial). A bare renderer.render()
  // throws every frame and draws nothing the pipeline composed
  pipeline.render()
})

// 9. Resize. This is the `resetHistory()` case the section above describes: the
// temporal accumulator is indexed in screen space, so reprojecting last frame's
// history into a differently-sized buffer smears until it re-converges
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  cloudsContext.resetHistory()
})

// On a backwards seek, invalidate the temporal history the same way:
// cloudsContext.resetHistory()
