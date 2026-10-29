// clouds/Clouds/Governor, Lab only: the Vanilla scene with the auto-quality
// governor armed. A "load" control queues a GPU burn compute per frame beside
// the frame, so the governor's step down and its step back up can be watched
// The feed is the requestAnimationFrame interval, as the integration guide
// recommends, and window.__governorStory is the hardware proof's probe

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
  createQualityGovernor,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHADOW_RADIUS,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL,
  getSTBN,
  loadBakedCloudTextures,
  type GroundShadowExtraDeps,
  type QualityGovernor,
  type QualityGovernorStepEvent
} from 'three-clouds-webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  context,
  float,
  Fn,
  instancedArray,
  instanceIndex,
  Loop,
  mrt,
  normalView,
  output,
  pass,
  sin,
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

import { createAtmosphereContext } from './helpers/atmosphereContext'

interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

export interface GovernorStoryProbe {
  governor: QualityGovernor
  setLoad: (units: number) => void
  state: () => {
    level: number
    load: number
    /** Smoothed requestAnimationFrame interval, the governor's feed */
    frameMs: number
    frames: number
    events: readonly QualityGovernorStepEvent[]
  }
}

const date = new Date('2000-06-01T10:00:00Z')
const geodetic = new Geodetic(0, radians(67), 500)

// The injected load: one unit is 131072 invocations of 8192 dependent sines,
// written back so nothing is eliminated, about 2 ms on an Apple M5 Pro,
// queued per frame `load` times
const BURN_COUNT = 131072
const BURN_ITERATIONS = 8192

async function init(container: HTMLDivElement): Promise<() => void> {
  const position = geodetic.toECEF()
  const up = Ellipsoid.WGS84.getSurfaceNormal(position)

  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  container.appendChild(canvas)
  const renderer = new WebGPURenderer({ canvas, antialias: false })
  renderer.toneMapping = NoToneMapping
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  await renderer.init()
  renderer.highPrecision = true

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

  const atmosphere = createAtmosphereContext()
  atmosphere.camera = camera
  const cloudsPass = clouds({ sceneDepth: null })
  const cloudsContext = cloudsPass.cloudsContext
  renderer.contextNode = context({
    ...(renderer.contextNode.value as Record<string, unknown>),
    getAtmosphere: () => atmosphere,
    getClouds: () => cloudsContext
  })

  const scenePass = pass(scene, camera, { samples: 0 })
  scenePass.setMRT(mrt({ output, normal: normalView }))
  cloudsPass.sceneDepth = scenePass.getTextureNode('depth')
  cloudsPass.camera = camera

  Object.assign(
    cloudsContext,
    await loadBakedCloudTextures({
      localWeather: DEFAULT_LOCAL_WEATHER_URL,
      turbulence: DEFAULT_TURBULENCE_URL,
      shape: DEFAULT_SHAPE_URL,
      shapeDetail: DEFAULT_SHAPE_DETAIL_URL
    })
  )
  cloudsContext.stbnTexture = await new STBNLoader().loadAsync(DEFAULT_STBN_URL)
  cloudsContext.coverage = 0.4
  cloudsContext.localWeatherVelocity.set(0.001, 0)

  const sunDirection = getSunDirectionECEF(date, new Vector3())
  atmosphere.sunDirectionECEF.value.copy(sunDirection)
  cloudsContext.sunDirection.copy(sunDirection)

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

  // The burn, queued `load` times per frame beside the frame
  const burnBuffer = instancedArray(BURN_COUNT, 'float')
  const burn = Fn(() => {
    const acc = burnBuffer.element(instanceIndex).toVar()
    Loop(BURN_ITERATIONS, () => {
      acc.assign(sin(acc.add(0.37)))
    })
    burnBuffer.element(instanceIndex).assign(acc)
  })().compute(BURN_COUNT)
  let load = 0

  // The governor: armed on the context's defaults, fed the rAF delta
  const events: QualityGovernorStepEvent[] = []
  const governor = createQualityGovernor(cloudsContext, {
    onStep: event => {
      events.push(event)
      console.log(`[governor] ${JSON.stringify(event)}`)
    }
  })
  governor.arm()

  // The overlay: level, smoothed frame time, load, and the load buttons
  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:absolute;top:8px;left:8px;padding:6px 8px;background:rgba(0,0,0,.6);color:#fff;font:12px/1.5 monospace;border-radius:4px'
  const readout = document.createElement('div')
  const less = document.createElement('button')
  less.textContent = 'load -'
  const more = document.createElement('button')
  more.textContent = 'load +'
  less.onclick = () => setLoad(load - 1)
  more.onclick = () => setLoad(load + 1)
  overlay.append(readout, less, more)
  container.appendChild(overlay)
  function setLoad(units: number): void {
    load = Math.max(0, Math.min(32, Math.round(units)))
  }

  let smoothedMs = 0
  let last: number | null = null
  const clock = new Clock()
  let frame = 0
  void renderer.setAnimationLoop(time => {
    const frameMs = last == null ? 0 : time - last
    last = time
    smoothedMs += (frameMs - smoothedMs) * 0.1
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
    for (let i = 0; i < load; i++) void renderer.compute(burn)
    pipeline.render()
    // The interval that just ended decides, the frame just queued does not
    if (frameMs > 0) governor.update(frameMs)
    readout.textContent = `level ${governor.level}  frame ${smoothedMs.toFixed(1)} ms  load ${load}  steps ${events.length}`
  })

  const probe: GovernorStoryProbe = {
    governor,
    setLoad,
    state: () => ({
      level: governor.level,
      load,
      frameMs: smoothedMs,
      frames: governor.frames,
      events
    })
  }
  ;(
    window as unknown as { __governorStory?: GovernorStoryProbe }
  ).__governorStory = probe

  const onResize = (): void => {
    camera.aspect = container.clientWidth / container.clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight)
    cloudsContext.resetHistory()
  }
  window.addEventListener('resize', onResize)

  return () => {
    window.removeEventListener('resize', onResize)
    delete (window as unknown as { __governorStory?: GovernorStoryProbe })
      .__governorStory
    governor.disarm()
    void renderer.setAnimationLoop(null)
    controls.dispose()
    pipeline.dispose()
    cloudsPass.dispose()
    torusKnotGeometry.dispose()
    torusKnotMaterial.dispose()
    void renderer.dispose()
    container.removeChild(overlay)
    container.removeChild(canvas)
  }
}

const Governor: FC = () => {
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
  return (
    <div
      ref={ref}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    />
  )
}

export const Story: StoryFn = () => <Governor />
