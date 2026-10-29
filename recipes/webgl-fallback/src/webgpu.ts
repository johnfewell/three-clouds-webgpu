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
import {
  ANIMATION_SPEED,
  EARTH_RADIUS_METRES,
  type BranchOptions,
  type CloudsHandle
} from './handle'
import { applySettings, type PartialSettings } from './settings'

// The WebGPU branch: the vanilla recipe's wiring, returned as a handle
export async function startWebGPU(
  options: BranchOptions
): Promise<CloudsHandle> {
  const { canvas, signal, clock, report } = options
  const renderer = new WebGPURenderer({ canvas, antialias: false })
  const cleanup: Array<() => void> = [() => renderer.dispose()]
  const dispose = (): void => {
    for (const release of cleanup.splice(0).reverse()) release()
  }
  try {
    await renderer.init()
    signal.throwIfAborted()
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
    const baked = await loadBakedCloudTextures(assetUrls(), { signal })
    cleanup.push(() =>
      Object.values(baked).forEach(texture => texture.dispose())
    )
    signal.throwIfAborted()
    const jitter = createJitterTexture()
    cleanup.push(() => jitter.dispose())
    const integration = createCloudsIntegration({
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

    let previousTime: number | undefined
    cleanup.push(() => {
      void renderer.setAnimationLoop(null)
    })
    await renderer.setAnimationLoop(milliseconds => {
      const deltaSeconds =
        previousTime == null ? 0 : (milliseconds - previousTime) / 1000
      previousTime = milliseconds
      if (!clock.paused) clock.timeSeconds += deltaSeconds * ANIMATION_SPEED
      integration.update({ time: clock.timeSeconds, frame: clock.frame++ })
      pipeline.render()
    })
    signal.throwIfAborted()
    return {
      backend: 'webgpu',
      update: (settings: PartialSettings) => {
        applySettings(integration.context, settings, 'webgpu')
        integration.resetHistory()
      },
      setEnabled: enabled => {
        integration.context.enabled = enabled
        integration.resetHistory()
      },
      seek: seconds => {
        clock.timeSeconds = seconds
        clock.frame = 0
        integration.resetHistory()
      },
      setPaused: paused => {
        clock.paused = paused
      },
      resize: () => {
        camera.aspect = innerWidth / innerHeight
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
        renderer.setSize(innerWidth, innerHeight)
        integration.resetHistory()
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}
