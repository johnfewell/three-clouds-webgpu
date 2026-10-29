// clouds/Clouds/Vanilla on the port, the WebGPU counterpart of the WebGL
// Clouds-Vanilla.tsx with its parameters: no r3f, a torus knot at 0°E 67°N,
// OrbitControls, sun at 2000-06-01T10:00Z, coverage 0.4, AgX, NVIDIA's STBN
// The wiring is examples/basic's (the WEBGPU.md Usage snippet) plus the torus
// knot, the controls and a dispose path, on ADR-001's graph

import type { StoryFn } from '@storybook/react-vite'
import { useEffect, useRef, type FC } from 'react'
import {
  AgXToneMapping,
  Clock,
  Group,
  Matrix4,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  TorusKnotGeometry,
  Vector2,
  Vector3
} from 'three'
import {
  aerialPerspectiveWithCloudShadow,
  clouds,
  createCloudShadowTransmittance,
  createGetShadowRadius,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHADOW_RADIUS,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL,
  getSTBN,
  loadBakedCloudTextures,
  type GroundShadowExtraDeps
} from 'three-clouds-webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  context,
  float,
  Fn,
  mrt,
  normalView,
  output,
  pass,
  toneMapping,
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

import { getSunDirectionECEF } from '@takram/three-atmosphere'
import {
  DEFAULT_STBN_URL,
  Ellipsoid,
  Geodetic,
  radians,
  STBNLoader
} from '@takram/three-geospatial'
import {
  depthToViewZ,
  dithering,
  inverseProjectionMatrix,
  inverseViewMatrix,
  lensFlare,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

import { meterDevice } from '../devtools/gpuMeter/GpuMeterTarget'
import { gpuMeter } from '../devtools/gpuMeter/meter'
import { createAtmosphereContext } from './helpers/atmosphereContext'

// The @takram type surfaces are built against @types/three 0.182 and this
// repository types against 0.185: the same casts CloudsPostProcessing makes
interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

const date = new Date('2000-06-01T10:00:00Z')
const geodetic = new Geodetic(0, radians(67), 500)

async function init(container: HTMLDivElement): Promise<() => void> {
  const position = geodetic.toECEF()
  const up = Ellipsoid.WGS84.getSurfaceNormal(position)

  const canvas = document.createElement('canvas')
  // Inline canvases sit on the text baseline and overflow a 100 %-height
  // container by a few pixels, which puts scrollbars on the story
  canvas.style.display = 'block'
  container.appendChild(canvas)
  const renderer = new WebGPURenderer({ canvas, antialias: false })
  // tone mapping is a node below
  renderer.toneMapping = NoToneMapping
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  await renderer.init()
  renderer.highPrecision = true
  // Storybook's dev GPU meter (toolbar), not part of the example
  const device = meterDevice(renderer)
  const detachMeter = device != null ? gpuMeter.attach(device) : undefined

  const aspect = container.clientWidth / container.clientHeight
  const camera = new PerspectiveCamera(75, aspect, 10, 1e6)
  camera.position.copy(position)
  camera.up.copy(up)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.minDistance = 1e3
  controls.target.copy(position)

  const scene = new Scene()

  const group = new Group()
  Ellipsoid.WGS84.getEastNorthUpFrame(position).decompose(
    group.position,
    group.quaternion,
    group.scale
  )
  scene.add(group)

  const torusKnotGeometry = new TorusKnotGeometry(200, 60, 256, 64)
  torusKnotGeometry.computeVertexNormals()
  const torusKnotMaterial = new MeshBasicNodeMaterial()
  torusKnotMaterial.color.set('white')
  group.add(new Mesh(torusKnotGeometry, torusKnotMaterial))

  // 1. Register the contexts on the renderer.
  const atmosphere = createAtmosphereContext()
  atmosphere.camera = camera
  const cloudsPass = clouds({ sceneDepth: null })
  const cloudsContext = cloudsPass.cloudsContext
  renderer.contextNode = context({
    ...(renderer.contextNode.value as Record<string, unknown>),
    getAtmosphere: () => atmosphere,
    getClouds: () => cloudsContext
  })

  // 2. Scene pass writes color + normal MRT. No sky on the scene background:
  //    the aerial node (step 6) paints every far-plane pixel itself (0.3 ms
  //    saved at 2880×1800, see Clouds-Basic)
  const scenePass = pass(scene, camera, { samples: 0 })
  scenePass.setMRT(mrt({ output, normal: normalView }))

  // 3. The clouds march reads the scene depth.
  cloudsPass.sceneDepth = scenePass.getTextureNode('depth')
  cloudsPass.camera = camera

  // 4. Baked textures (awaited) and the jitter volume; the WebGL story's
  // coverage and weather velocity
  Object.assign(
    cloudsContext,
    await loadBakedCloudTextures({
      localWeather: DEFAULT_LOCAL_WEATHER_URL,
      turbulence: DEFAULT_TURBULENCE_URL,
      shape: DEFAULT_SHAPE_URL,
      shapeDetail: DEFAULT_SHAPE_DETAIL_URL
    })
  )
  // NVIDIA's STBN from the upstream URL, as the WebGL Vanilla story samples it
  // (ADR-009 Amendment 1); awaited so no frame renders through a placeholder
  cloudsContext.stbnTexture = await new STBNLoader().loadAsync(DEFAULT_STBN_URL)
  cloudsContext.coverage = 0.4
  cloudsContext.localWeatherVelocity.set(0.001, 0)

  // The sun, for every consumer
  const sunDirection = getSunDirectionECEF(date, new Vector3())
  atmosphere.sunDirectionECEF.value.copy(sunDirection)
  cloudsContext.sunDirection.copy(sunDirection)

  // 5. Cloud-shadow transmittance: the deps mirror the march's uniforms, with
  // the adaptive PCF radius and STBN jitter of the reference's consumer
  const u = {
    viewMatrix: uniform(new Matrix4()),
    cameraNear: uniform(camera.near),
    sunDirection: uniform(new Vector3()),
    ecefToWorldMatrix: uniform(new Matrix4()),
    worldToECEFMatrix: uniform(new Matrix4()),
    altitudeCorrection: uniform(new Vector3()),
    worldToUnit: uniform(1 / cloudsContext.bottomRadius),
    temporalJitter: uniform(new Vector2()),
    resolution: uniform(new Vector2().copy(cloudsContext.shadow.mapSize)),
    screenResolution: uniform(new Vector2()),
    shadowFrame: uniform(0)
  }
  const shadowDeps: GroundShadowExtraDeps = {
    viewMatrix: u.viewMatrix,
    cameraNear: u.cameraNear,
    sunDirection: u.sunDirection,
    bottomRadius: float(cloudsContext.bottomRadius),
    ecefToWorldMatrix: u.ecefToWorldMatrix,
    altitudeCorrection: u.altitudeCorrection,
    worldToUnit: u.worldToUnit,
    temporalJitter: u.temporalJitter,
    resolution: u.resolution
  }
  const transmittance = createCloudShadowTransmittance(
    cloudsPass.cloudShadow,
    shadowDeps,
    { enabled: true }
  )
  const shadowRadius = createGetShadowRadius({
    shadowMatrices: cloudsPass.cloudShadow.matrices,
    inverseShadowMatrices: cloudsPass.cloudShadow.inverseMatrices,
    shadowMapSize: u.resolution,
    projectionMatrix: projectionMatrix(camera) as unknown as Node<'mat4'>,
    viewMatrix: u.viewMatrix,
    resolution: u.screenResolution,
    shadowRadius: float(DEFAULT_SHADOW_RADIUS)
  })
  const stbn = getSTBN(cloudsContext.stbnTexture, u.shadowFrame)

  // 6. Aerial perspective, post-lit.
  const sceneDepthTex = scenePass.getTextureNode('depth')
  const aerialShadowNode = Fn(() => {
    const d = sceneDepthTex.r.toConst()
    const viewZ = depthToViewZ(d, camera) as unknown as Node<'float'>
    const posView = screenToPositionView(
      uv(),
      d,
      viewZ,
      projectionMatrix(camera),
      inverseProjectionMatrix(camera)
    ) as unknown as Node<'vec3'>
    const posWorld = (inverseViewMatrix(camera) as unknown as Mat4NodeLike).mul(
      vec4(posView, 1)
    ).xyz
    const posECEF = u.worldToECEFMatrix.mul(vec4(posWorld, 1)).xyz
    return transmittance(
      posECEF.add(u.altitudeCorrection),
      shadowRadius(posWorld),
      stbn
    )
  })()
  const aerial = aerialPerspectiveWithCloudShadow(
    scenePass.getTextureNode('output'),
    sceneDepthTex,
    cloudsPass.cloudShadowLength,
    aerialShadowNode,
    scenePass.getTextureNode('normal')
  )
  aerial.lighting = true

  // 7. Composite clouds over the aerial result, then lens flare, AgX, dither.
  const composite = cloudsPass.composite(aerial)
  const flare = lensFlare(composite)
  const toneMapped = toneMapping(
    AgXToneMapping,
    uniform(10),
    flare as unknown as Node<'vec4'>
  )
  const pipeline = new RenderPipeline(
    renderer,
    (toneMapped as unknown as Node<'vec4'>).add(
      dithering as unknown as Node<'vec3'>
    )
  )

  // 8. time/frame are plain numbers owned by the app (ADR-003).
  const clock = new Clock()
  let frame = 0
  // setAnimationLoop returns a promise in the WebGPU renderer
  void renderer.setAnimationLoop(time => {
    gpuMeter.beginFrame(time)
    controls.update()
    cloudsContext.time += clock.getDelta()
    cloudsContext.frame = frame++
    cloudsContext.updateCamera(camera)
    u.viewMatrix.value.copy(camera.matrixWorldInverse)
    u.cameraNear.value = camera.near
    renderer.getSize(u.screenResolution.value)
    u.shadowFrame.value = cloudsContext.frame
    u.sunDirection.value.copy(cloudsContext.sunDirection)
    u.ecefToWorldMatrix.value.copy(cloudsContext.ecefToWorldMatrix)
    u.worldToECEFMatrix.value.copy(cloudsContext.worldToECEFMatrix)
    u.altitudeCorrection.value.copy(cloudsContext.altitudeCorrection)
    u.resolution.value.copy(cloudsContext.shadow.mapSize)
    pipeline.render()
    gpuMeter.endFrame()
  })

  // 9. Resize: the temporal history is indexed in screen space.
  const onResize = (): void => {
    camera.aspect = container.clientWidth / container.clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight)
    cloudsContext.resetHistory()
  }
  window.addEventListener('resize', onResize)

  return () => {
    window.removeEventListener('resize', onResize)
    void renderer.setAnimationLoop(null)
    detachMeter?.()
    controls.dispose()
    pipeline.dispose()
    cloudsPass.dispose()
    torusKnotGeometry.dispose()
    torusKnotMaterial.dispose()
    void renderer.dispose()
    container.removeChild(canvas)
  }
}

const Vanilla: FC = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = ref.current
    if (container == null) return
    let dispose: (() => void) | undefined
    let live = true
    init(container)
      .then(result => {
        if (live) {
          dispose = result
        } else {
          result()
        }
      })
      .catch((error: unknown) => {
        console.error(error)
      })
    return () => {
      live = false
      dispose?.()
    }
  }, [])
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />
}

export const Story: StoryFn = () => <Vanilla />
