// 3D Tiles example with Google Photorealistic 3D Tiles and clouds
// Uses post-lit aerial perspective with cloud shadows over WGS84 ECEF
// When no credential is provided, falls back to a plain ellipsoid globe

import {
  CesiumIonAuthPlugin,
  GoogleCloudAuthPlugin
} from '3d-tiles-renderer/core/plugins'
import { GlobeControls, TilesRenderer } from '3d-tiles-renderer/three'
import {
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  TilesFadePlugin
} from '3d-tiles-renderer/three/plugins'
import {
  AgXToneMapping,
  Color,
  Matrix4,
  Mesh,
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
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { TileCreasedNormalsPlugin } from 'three/addons/misc/TileCreasedNormalsPlugin.js'
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
  MeshBasicNodeMaterial,
  RenderPipeline,
  WebGPURenderer,
  type Node
} from 'three/webgpu'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import {
  Ellipsoid,
  EllipsoidGeometry,
  Geodetic,
  PointOfView,
  radians
} from '@takram/three-geospatial'
import {
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

import { TileMaterialReplacementPlugin } from './TileMaterialReplacementPlugin'

const canvas = document.querySelector('canvas')!
const renderer = new WebGPURenderer({ canvas, antialias: false })
renderer.toneMapping = AgXToneMapping
renderer.toneMappingExposure = 10
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
await renderer.init()

const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 10, 1e8)

// Tokyo coordinates from Storybook: longitude 139.8146, latitude 35.7455
const TOKYO_LONGITUDE = 139.8146
const TOKYO_LATITUDE = 35.7455
const TOKYO_HEIGHT = 0
const TOKYO_HEADING = -110
const TOKYO_PITCH = -9
const TOKYO_DISTANCE = 1000

new PointOfView(
  TOKYO_DISTANCE,
  radians(TOKYO_HEADING),
  radians(TOKYO_PITCH)
).decompose(
  new Geodetic(
    radians(TOKYO_LONGITUDE),
    radians(TOKYO_LATITUDE),
    TOKYO_HEIGHT
  ).toECEF(),
  camera.position,
  camera.quaternion,
  camera.up
)

// Atmosphere context registered on the renderer
const atmosphere = new AtmosphereContext()
atmosphere.raymarchScattering = false
atmosphere.camera = camera

const cloudsPass = clouds({ sceneDepth: null })
const cloudsContext = cloudsPass.cloudsContext
renderer.contextNode = context({
  ...(renderer.contextNode?.value ?? {}),
  getAtmosphere: () => atmosphere,
  getClouds: () => cloudsContext
})

// Scene pass writes output and normal MRT for post-lit aerial perspective
const scene = new Scene()
scene.background = new Color(0x000000)
const scenePass = pass(scene, camera, { samples: 0 })
scenePass.setMRT(mrt({ output, normal: normalView }))

cloudsPass.sceneDepth = scenePass.getTextureNode('depth')
cloudsPass.camera = camera

// Load baked cloud volumes and generate jitter texture
const baked = await loadBakedCloudTextures({
  localWeather: DEFAULT_LOCAL_WEATHER_URL,
  turbulence: DEFAULT_TURBULENCE_URL,
  shape: DEFAULT_SHAPE_URL,
  shapeDetail: DEFAULT_SHAPE_DETAIL_URL
})
Object.assign(cloudsContext, baked)
cloudsContext.stbnTexture = createJitterTexture()
cloudsContext.coverage = 0.35

// Solar positioning for Tokyo morning: 7:30 AM local solar time on day 170
// Low morning sun in the east casting dramatic shadows across the city
const timeOfDay = {
  date: new Date('2026-06-19T00:00:00Z'),
  location: { longitude: TOKYO_LONGITUDE, latitude: TOKYO_LATITUDE },
  timeOfDay: 7.5 / 24
}

// Cloud-shadow transmittance setup
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

const pipeline = new RenderPipeline(renderer)
pipeline.outputNode = cloudsPass.composite(aerial)

// Check for credentials from import.meta.env
const ionToken = import.meta.env.VITE_ION_TOKEN
const googleApiKey = import.meta.env.VITE_GOOGLE_MAP_API_KEY
const hasGoogle = typeof googleApiKey === 'string' && googleApiKey.trim() !== ''
const hasIon = typeof ionToken === 'string' && ionToken.trim() !== ''

const overlay = document.querySelector<HTMLDivElement>('#status-overlay')

let tiles: TilesRenderer | null = null

if (hasGoogle || hasIon) {
  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')

  tiles = new TilesRenderer()
  if (hasGoogle) {
    tiles.registerPlugin(
      new GoogleCloudAuthPlugin({
        apiToken: googleApiKey.trim(),
        autoRefreshToken: true,
        useRecommendedSettings: true
      })
    )
  } else {
    tiles.registerPlugin(
      new CesiumIonAuthPlugin({
        apiToken: ionToken!.trim(),
        assetId: '2275207',
        autoRefreshToken: true,
        useRecommendedSettings: true
      })
    )
  }
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }))
  tiles.registerPlugin(new TileCompressionPlugin())
  tiles.registerPlugin(
    new TileCreasedNormalsPlugin({ creaseAngle: Math.PI / 6 })
  )
  tiles.registerPlugin(new TileMaterialReplacementPlugin())
  tiles.registerPlugin(new TilesFadePlugin())

  tiles.setCamera(camera)
  tiles.setResolution(camera, innerWidth, innerHeight)
  scene.add(tiles.group)

  if (overlay != null) {
    const provider = hasGoogle
      ? 'Google Maps Platform API key'
      : 'Cesium ion token (asset 2275207)'
    const title = document.createElement('strong')
    title.textContent = 'Google Photorealistic 3D Tiles'
    overlay.replaceChildren(
      title,
      document.createElement('br'),
      document.createTextNode(`Authenticated via ${provider}`)
    )
  }
} else {
  // Ellipsoid fallback when no 3D Tiles credential is provided
  const geometry = new EllipsoidGeometry(Ellipsoid.WGS84.radii, 128, 64)
  const material = new MeshBasicNodeMaterial({ color: 0x1a334d })
  const ellipsoidMesh = new Mesh(geometry, material)
  scene.add(ellipsoidMesh)

  if (overlay != null) {
    const title = document.createElement('strong')
    title.textContent = 'No 3D Tiles key detected'
    const code1 = document.createElement('code')
    code1.textContent = 'VITE_ION_TOKEN'
    const code2 = document.createElement('code')
    code2.textContent = 'VITE_GOOGLE_MAP_API_KEY'
    const code3 = document.createElement('code')
    code3.textContent = 'examples/tiles/.env.local'
    overlay.replaceChildren(
      title,
      document.createElement('br'),
      document.createTextNode(
        'Showing plain ellipsoid globe. To view Google Photorealistic 3D Tiles, provide '
      ),
      code1,
      document.createTextNode(' or '),
      code2,
      document.createTextNode(' in '),
      code3
    )
  }
}

const controls = new GlobeControls(scene, camera, canvas)
controls.enableDamping = true
// Disable adjustHeight until user first drags to prevent GlobeControls
// from jumping the camera into orbit during initial tile loading
controls.adjustHeight = false
controls.addEventListener('start', () => {
  controls.adjustHeight = true
})
if (tiles != null) {
  controls.setScene(tiles.group)
  controls.setEllipsoid(tiles.ellipsoid, tiles.group)
}

let lastTime = performance.now()
let frame = 0
const TIME_SCALE = 1 / 60
void renderer.setAnimationLoop(() => {
  const now = performance.now()
  const delta = (now - lastTime) * 1e-3
  lastTime = now
  cloudsContext.time += delta * TIME_SCALE
  cloudsContext.frame = frame++
  controls.update()
  if (tiles != null) {
    tiles.update()
  }
  pipeline.render()
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  cloudsContext.resetHistory()
  if (tiles != null) {
    tiles.setResolution(camera, innerWidth, innerHeight)
  }
})
