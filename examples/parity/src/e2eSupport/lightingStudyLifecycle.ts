import { Vector2, type Data3DTexture } from 'three'
import { clouds, type CloudsContext } from 'three-clouds-webgpu'
import { vec4 } from 'three/tsl'
import { RenderPipeline } from 'three/webgpu'

import type { ParityProbe } from '../../e2e/parityProbe'

type Study = NonNullable<CloudsContext['lightingStudy']>

function cloneStudy(study: Study) {
  const owned: Data3DTexture[] = []
  const clone = (source: Data3DTexture) => {
    const texture = source.clone()
    texture.needsUpdate = true
    owned.push(texture)
    return texture
  }
  const density = clone(study.density)
  const skyCache = study.skyCache!.map(clone)
  const phaseWeights = [
    clone(study.phaseWeights![0]),
    clone(study.phaseWeights![1])
  ] as const
  return { study: { ...study, density, skyCache, phaseWeights }, owned }
}

function configure(ctx: CloudsContext, source: CloudsContext, study: Study) {
  ctx.qualityPreset = 'low'
  ctx.cloudLayers.copy(source.cloudLayers)
  ctx.worldToECEFMatrix.copy(source.worldToECEFMatrix)
  ctx.sunDirection.copy(source.sunDirection)
  ctx.scatteringCoefficient = source.scatteringCoefficient
  ctx.absorptionCoefficient = source.absorptionCoefficient
  ctx.scatterAnisotropy1 = source.scatterAnisotropy1
  ctx.scatterAnisotropy2 = source.scatterAnisotropy2
  ctx.scatterAnisotropyMix = source.scatterAnisotropyMix
  ctx.powderScale = 0
  ctx.skyLightScale = 1
  ctx.lightShafts = false
  ctx.haze = false
  ctx.groundBounceScale = 0
  ctx.clouds.maxIterationCountToGround = 0
  ctx.temporalUpscale = false
  ctx.experimental = Object.fromEntries(
    Object.keys(ctx.experimental).map(key => [key, false])
  )
  ctx.lightingStudy = study
}

export async function measureLightingStudyLifecycle(
  probe: ParityProbe,
  study: Study
) {
  const side = probe.sideBHandle
  if (side == null) throw new Error('Study lifecycle requires side B')
  const { renderer, camera, cloudsContext: source } = side
  const providers = renderer.contextNode.value as Record<string, unknown>
  const originalProvider = providers.getClouds
  const originalSize = renderer.getSize(new Vector2())
  const memory = () => ({
    textures: renderer.info.memory.textures,
    bytes: renderer.info.memory.texturesSize
  })
  const baseline = memory()
  const cycles = []
  const nextFrame = () =>
    new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  try {
    for (let cycle = 0; cycle < 5; cycle++) {
      const copy = cloneStudy(study)
      const disposals = copy.owned.map(() => 0)
      copy.owned.forEach((texture, index) =>
        texture.addEventListener('dispose', () => {
          disposals[index] = disposals[index]! + 1
        })
      )
      const pass = clouds({ sceneDepth: null })
      pass.camera = camera
      const ctx = pass.cloudsContext
      configure(ctx, source, copy.study)
      providers.getClouds = () => ctx
      const graph = new RenderPipeline(renderer, pass.composite(vec4(0)))
      let active
      try {
        for (const size of [32, 48, 32]) {
          renderer.setSize(size, size, false)
          ctx.enabled = true
          pass.resetHistory()
          await nextFrame()
          graph.render()
        }
        active = memory()
        ctx.enabled = false
        await nextFrame()
        graph.render()
      } finally {
        graph.dispose()
        pass.dispose()
        ctx.dispose()
        for (const texture of copy.owned) texture.dispose()
        providers.getClouds = originalProvider
      }
      cycles.push({
        active,
        after: memory(),
        owned: copy.owned.length,
        disposals
      })
    }
    return { baseline, cycles, errors: [...probe.errors] }
  } finally {
    providers.getClouds = originalProvider
    renderer.setSize(originalSize.x, originalSize.y, false)
  }
}
