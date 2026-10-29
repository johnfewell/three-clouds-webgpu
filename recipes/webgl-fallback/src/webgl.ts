import {
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode
} from 'postprocessing'
import {
  Color,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer
} from 'three'
import {
  createJitterTexture,
  loadBakedCloudTextures
} from 'three-clouds-webgpu'

import {
  AerialPerspectiveEffect,
  PrecomputedTexturesGenerator,
  SkyMaterial
} from '@takram/three-atmosphere'
import { CloudsEffect } from '@takram/three-clouds'

import { assetUrls } from './assets'
import {
  ANIMATION_SPEED,
  EARTH_RADIUS_METRES,
  type BranchOptions,
  type CloudsHandle
} from './handle'
import { applySettings, type PartialSettings } from './settings'

// The WebGL branch: the original @takram/three-clouds 0.7.6 chain on a
// WebGLRenderer with postprocessing, wired the way the port's parity harness
// drives it. The port's loaders serve both branches (plain three textures)
export async function startWebGL(
  options: BranchOptions
): Promise<CloudsHandle> {
  const { canvas, signal, clock, report } = options
  const renderer = new WebGLRenderer({ canvas, antialias: false })
  const cleanup: Array<() => void> = [() => renderer.dispose()]
  const dispose = (): void => {
    for (const release of cleanup.splice(0).reverse()) release()
  }
  try {
    // The composer's ToneMappingEffect tone maps. the renderer must not
    renderer.toneMapping = NoToneMapping
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

    // The sky, on a camera-following plane the aerial effect composites over
    const skyMaterial = new SkyMaterial()
    const skyGeometry = new PlaneGeometry(2, 2)
    const skyMesh = new Mesh(skyGeometry, skyMaterial)
    skyMesh.frustumCulled = false
    scene.add(skyMesh)
    cleanup.push(
      () => skyGeometry.dispose(),
      () => skyMaterial.dispose()
    )

    report('loading', 'Precomputing the atmosphere…')
    const generator = new PrecomputedTexturesGenerator(renderer)
    cleanup.push(() => generator.dispose())
    await generator.update()
    signal.throwIfAborted()
    const textures = generator.textures
    Object.assign(skyMaterial, textures)

    report('loading', 'Loading four cloud assets…')
    const baked = await loadBakedCloudTextures(assetUrls(), { signal })
    cleanup.push(() =>
      Object.values(baked).forEach(texture => texture.dispose())
    )
    signal.throwIfAborted()
    const jitter = createJitterTexture()
    cleanup.push(() => jitter.dispose())

    const clouds = new CloudsEffect(camera)
    cleanup.push(() => clouds.dispose())
    // The aerial effect composites the clouds as its overlay, so the effect
    // itself does not draw (the harness's side A does the same)
    clouds.skipRendering = true
    clouds.irradianceTexture = textures.irradianceTexture ?? null
    clouds.scatteringTexture = textures.scatteringTexture ?? null
    clouds.transmittanceTexture = textures.transmittanceTexture ?? null
    if (textures.singleMieScatteringTexture != null) {
      clouds.singleMieScatteringTexture = textures.singleMieScatteringTexture
    }
    if (textures.higherOrderScatteringTexture != null) {
      clouds.higherOrderScatteringTexture =
        textures.higherOrderScatteringTexture
    }
    clouds.localWeatherTexture = baked.localWeatherTexture
    clouds.turbulenceTexture = baked.turbulenceTexture
    clouds.shapeTexture = baked.shapeTexture
    clouds.shapeDetailTexture = baked.shapeDetailTexture
    clouds.stbnTexture = jitter

    const aerial = new AerialPerspectiveEffect(camera, {
      sunLight: true,
      skyLight: true,
      ...textures
    })
    cleanup.push(() => aerial.dispose())
    aerial.stbnTexture = jitter
    const normalPass = new NormalPass(scene, camera)
    aerial.normalBuffer = normalPass.texture

    clouds.events.addEventListener('change', event => {
      if (event.property === 'atmosphereOverlay') {
        aerial.overlay = clouds.atmosphereOverlay
      } else if (event.property === 'atmosphereShadow') {
        aerial.shadow = clouds.atmosphereShadow
      } else if (event.property === 'atmosphereShadowLength') {
        aerial.shadowLength = clouds.atmosphereShadowLength
      }
    })

    const sun = new Vector3(1, 1, 0.3).normalize()
    clouds.sunDirection.copy(sun)
    aerial.sunDirection.copy(sun)
    skyMaterial.sunDirection.copy(sun)

    const composer = new EffectComposer(renderer, {
      frameBufferType: HalfFloatType
    })
    cleanup.push(() => composer.dispose())
    composer.addPass(new RenderPass(scene, camera))
    composer.addPass(normalPass)
    composer.addPass(new EffectPass(camera, clouds, aerial))
    composer.addPass(
      new EffectPass(
        camera,
        new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL })
      )
    )
    composer.setSize(innerWidth, innerHeight)

    let enabled = true
    let previousTime: number | undefined
    cleanup.push(() => {
      renderer.setAnimationLoop(null)
    })
    renderer.setAnimationLoop(milliseconds => {
      const deltaSeconds =
        previousTime == null ? 0 : (milliseconds - previousTime) / 1000
      previousTime = milliseconds
      if (!clock.paused) clock.timeSeconds += deltaSeconds * ANIMATION_SPEED
      clock.frame++
      skyMesh.position.copy(camera.position)
      composer.render(deltaSeconds)
    })
    signal.throwIfAborted()
    return {
      backend: 'webgl',
      update: (settings: PartialSettings) => {
        applySettings(clouds, settings, 'webgl')
      },
      // The original has no enabled flag: disabling drops the overlay the
      // aerial effect composites, the end state the port's enabled gives
      setEnabled: value => {
        enabled = value
        aerial.overlay = enabled ? clouds.atmosphereOverlay : null
      },
      seek: seconds => {
        clock.timeSeconds = seconds
        clock.frame = 0
      },
      setPaused: paused => {
        clock.paused = paused
      },
      resize: () => {
        camera.aspect = innerWidth / innerHeight
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
        renderer.setSize(innerWidth, innerHeight)
        composer.setSize(innerWidth, innerHeight)
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}
