import {
  Color,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3
} from 'three'
import {
  assertWebGPUSupported,
  createCloudsIntegration,
  createJitterTexture,
  loadBakedCloudTextures
} from 'three-clouds-webgpu'
import { mrt, normalView, output, pass } from 'three/tsl'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'

import { AtmosphereContext, SkyNode } from '@takram/three-atmosphere/webgpu'

import { assetUrls } from './assets'
import { createManualIntegration } from './manual'

const canvas = document.querySelector('canvas')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
const controller = new AbortController()
const EARTH_RADIUS_METRES = 6378137
const ANIMATION_SPEED = 1
let stopped = false
let disposeApp = (): void => {}

function report(state: string, message: string): void {
  status.dataset.state = state
  status.textContent = message
}

function stop(): void {
  if (stopped) return
  stopped = true
  controller.abort()
  disposeApp()
  if (status.dataset.state !== 'error') report('stopped', 'Disposed')
}

async function start(): Promise<() => void> {
  const renderer = new WebGPURenderer({ canvas, antialias: false })
  const cleanup: Array<() => void> = [() => renderer.dispose()]
  const dispose = (): void => {
    for (const release of cleanup.splice(0).reverse()) release()
  }
  try {
    await renderer.init()
    controller.signal.throwIfAborted()
    assertWebGPUSupported(renderer)
    renderer.toneMapping = NeutralToneMapping
    renderer.toneMappingExposure = 1
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setSize(innerWidth, innerHeight)

    const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 100, 1e8)
    camera.position.set(0, EARTH_RADIUS_METRES + 2500, 0)
    camera.lookAt(EARTH_RADIUS_METRES * 0.35, EARTH_RADIUS_METRES + 4000, 0)
    camera.updateMatrixWorld()
    const scene = new Scene()
    scene.background = new Color(0)
    const groundGeometry = new SphereGeometry(EARTH_RADIUS_METRES, 64, 32)
    const groundMaterial = new MeshBasicMaterial({ color: '#667c74' })
    scene.add(new Mesh(groundGeometry, groundMaterial))
    cleanup.push(
      () => groundGeometry.dispose(),
      () => groundMaterial.dispose()
    )

    const atmosphere = new AtmosphereContext()
    atmosphere.camera = camera
    atmosphere.raymarchScattering = false
    cleanup.push(() => atmosphere.dispose())
    const scenePass = pass(scene, camera, { samples: 0 })
    scenePass.setMRT(mrt({ output, normal: normalView }))
    cleanup.push(() => scenePass.dispose())

    report('loading', 'Loading four cloud assets…')
    const baked = await loadBakedCloudTextures(assetUrls(), {
      signal: controller.signal
    })
    cleanup.push(() =>
      Object.values(baked).forEach(texture => texture.dispose())
    )
    controller.signal.throwIfAborted()
    const jitter = createJitterTexture()
    cleanup.push(() => jitter.dispose())
    const factory = new URLSearchParams(location.search).has('manual')
      ? createManualIntegration
      : createCloudsIntegration
    const integration = factory({
      renderer,
      camera,
      atmosphere,
      scenePass,
      lighting: 'post',
      textures: { ...baked, stbnTexture: jitter },
      sunDirection: new Vector3(1, 1, 0.3).normalize()
    })
    cleanup.push(() => integration.dispose())
    const sky = integration.aerial.skyNode
    if (!(sky instanceof SkyNode)) throw new Error('Expected a daytime SkyNode')
    sky.showStars = false
    sky.showMoon = false
    const inspection = integration.diagnostics()
    console.table(inspection.diagnostics)
    if (
      inspection.readiness.configuration === 'invalid' ||
      inspection.readiness.assets !== 'ready'
    ) {
      throw new Error('Cloud setup is not ready; inspect the diagnostic table')
    }
    const pipeline = new RenderPipeline(renderer)
    pipeline.outputNode = integration.output
    cleanup.push(() => pipeline.dispose())

    let timeSeconds = 0
    let frame = 0
    let previousTime: number | undefined
    let paused = false
    const cloudsToggle =
      document.querySelector<HTMLButtonElement>('#clouds-toggle')!
    cloudsToggle.addEventListener(
      'click',
      () => {
        integration.context.enabled = !integration.context.enabled
        cloudsToggle.setAttribute(
          'aria-pressed',
          String(integration.context.enabled)
        )
        cloudsToggle.textContent = integration.context.enabled
          ? 'Clouds: on'
          : 'Clouds: off'
        integration.resetHistory()
      },
      { signal: controller.signal }
    )
    cloudsToggle.disabled = false
    const pause = document.querySelector<HTMLButtonElement>('#pause')!
    pause.addEventListener(
      'click',
      () => {
        paused = !paused
        pause.textContent = paused ? 'Resume' : 'Pause'
      },
      { signal: controller.signal }
    )
    document.querySelector('#seek')!.addEventListener(
      'click',
      () => {
        timeSeconds = 0
        frame = 0
        integration.resetHistory()
      },
      { signal: controller.signal }
    )
    window.addEventListener(
      'resize',
      () => {
        camera.aspect = innerWidth / innerHeight
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
        renderer.setSize(innerWidth, innerHeight)
        integration.resetHistory()
      },
      { signal: controller.signal }
    )

    cleanup.push(() => {
      void renderer.setAnimationLoop(null)
    })
    await renderer.setAnimationLoop(milliseconds => {
      try {
        const deltaSeconds =
          previousTime == null ? 0 : (milliseconds - previousTime) / 1000
        previousTime = milliseconds
        if (!paused) timeSeconds += deltaSeconds * ANIMATION_SPEED
        integration.update({ time: timeSeconds, frame: frame++ })
        pipeline.render()
        status.dataset.frames = String(frame)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
        stop()
      }
    })
    controller.signal.throwIfAborted()
    report(
      'rendering',
      'Rendering clouds. Time is in seconds; pause keeps temporal samples advancing.'
    )
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}

document.querySelector('#stop')!.addEventListener('click', stop, {
  signal: controller.signal
})
window.addEventListener('pagehide', stop, { signal: controller.signal })
import.meta.hot?.dispose(stop)
void start().then(
  dispose => {
    disposeApp = dispose
    if (stopped) dispose()
  },
  (error: unknown) => {
    if (!stopped) {
      report('error', error instanceof Error ? error.message : String(error))
      stop()
    }
  }
)
