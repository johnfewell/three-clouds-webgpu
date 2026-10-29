import { DataUtils, HalfFloatType, Matrix4, RenderTarget, Vector3 } from 'three'
import {
  applyQualityPreset,
  clouds,
  createCloudsIntegration,
  type CloudsContext,
  type CloudsIntegrationTextures
} from 'three-clouds-webgpu'
import { mrt, normalView, output, pass } from 'three/tsl'
import {
  RenderPipeline,
  type PassNode,
  type WebGPURenderer
} from 'three/webgpu'

import {
  AerialPerspectiveNode,
  AtmosphereContext,
  SkyNode
} from '@takram/three-atmosphere/webgpu'

import { createManualAerialShadow } from '../../../../recipes/vanilla/src/manualAerial'
import type { ParityProbe } from '../../e2e/parityProbe'
import type { ParityCamera } from '../parityCamera'
import { unpadRows } from '../readback'

function daytime(aerial: AerialPerspectiveNode): () => void {
  const sky = aerial.skyNode
  if (!(sky instanceof SkyNode))
    throw new Error('Expected the supported SkyNode')
  sky.showStars = false
  sky.showMoon = false
  return () => {
    aerial.skyNode = null
    aerial.dispose()
    sky.starsNode.dispose()
    sky.sunNode.dispose()
    sky.moonNode.dispose()
    sky.dispose()
  }
}

function configure(context: CloudsContext): void {
  applyQualityPreset(context, 'low')
  context.temporalUpscale = false
  context.shadow.temporalPass = false
  context.shadow.mapSize.set(128, 128)
  context.coverage = 0.75
  context.warnings = false
  for (const layer of context.cloudLayers) layer.shadow = true
}

async function renderPixels(
  renderer: WebGPURenderer,
  pipeline: RenderPipeline,
  target: RenderTarget,
  update: (frame: number) => void
): Promise<Float32Array> {
  for (let frame = 0; frame < 4; frame++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    update(frame)
    const previousTarget = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(target)
      pipeline.render()
    } finally {
      renderer.setRenderTarget(previousTarget)
    }
  }
  const raw = (await renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    target.width,
    target.height
  )) as Uint16Array
  return Float32Array.from(unpadRows(raw, target.width, target.height), value =>
    DataUtils.fromHalfFloat(value)
  )
}

function measurePair(
  manual: Float32Array,
  helper: Float32Array,
  previous: Float32Array | undefined
) {
  if (manual.length === 0 || manual.length !== helper.length)
    throw new Error('Missing or unequal integration readbacks')
  let maximumDifference = 0
  let changeFromPrevious = 0
  let minimum = Infinity
  let maximum = -Infinity
  let sum = 0
  let samples = 0
  for (let index = 0; index < helper.length; index++) {
    if (index % 4 === 3) continue
    const current = helper[index]!
    const reference = manual[index]!
    if (!Number.isFinite(current) || !Number.isFinite(reference))
      throw new Error('Non-finite integration pixel')
    maximumDifference = Math.max(
      maximumDifference,
      Math.abs(current - reference)
    )
    changeFromPrevious = Math.max(
      changeFromPrevious,
      Math.abs(current - (previous?.[index] ?? current))
    )
    minimum = Math.min(minimum, current)
    maximum = Math.max(maximum, current)
    sum += current
    samples++
  }
  if (samples === 0) throw new Error('No RGB samples in integration readback')
  return {
    maximumDifference,
    changeFromPrevious,
    minimum,
    maximum,
    mean: sum / samples,
    samples
  }
}

function createManualComposition(
  camera: ParityCamera,
  scenePass: PassNode,
  textures: CloudsIntegrationTextures,
  renderer: WebGPURenderer
) {
  const manual = clouds({ sceneDepth: scenePass.getTextureNode('depth') })
  manual.camera = camera
  Object.assign(manual.cloudsContext, textures)
  configure(manual.cloudsContext)
  const depth = scenePass.getTextureNode('depth')
  const aerial = new AerialPerspectiveNode(
    scenePass.getTextureNode('output'),
    depth,
    scenePass.getTextureNode('normal'),
    manual.cloudShadowLength
  )
  aerial.shadowNode = createManualAerialShadow(
    camera,
    depth,
    manual.cloudShadowAt.bind(manual)
  )
  aerial.lighting = true
  const disposeManualAerial = daytime(aerial)
  const manualOutput = manual.composite(aerial)
  const manualPipeline = new RenderPipeline(renderer, manualOutput)
  manualPipeline.outputColorTransform = false
  return { manual, manualOutput, manualPipeline, disposeManualAerial }
}

function createComparison(probe: ParityProbe) {
  const side = probe.sideBHandle
  if (side == null) throw new Error('Integration comparison requires side B')
  const { renderer, camera } = side
  if (!('isPerspectiveCamera' in camera) || camera.isPerspectiveCamera !== true)
    throw new Error(
      'Integration comparison requires a PerspectiveCamera. Orthographic cameras are not supported.'
    )
  const saved = {
    contextNode: renderer.contextNode,
    target: renderer.getRenderTarget(),
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    scale: camera.scale.clone()
  }
  const atmosphere = new AtmosphereContext()
  atmosphere.raymarchScattering = false
  const scenePass = pass(side.sceneResult.scene, camera, { samples: 0 })
  scenePass.setMRT(mrt({ output, normal: normalView }))
  const source = side.cloudsContext
  const textures: CloudsIntegrationTextures = {
    localWeatherTexture: source.localWeatherTexture,
    shapeTexture: source.shapeTexture,
    shapeDetailTexture: source.shapeDetailTexture,
    turbulenceTexture: source.turbulenceTexture,
    stbnTexture: source.resolvedStbnTexture
  }
  const integration = createCloudsIntegration({
    renderer,
    camera,
    atmosphere,
    scenePass,
    lighting: 'post',
    textures,
    sunDirection: source.sunDirection,
    worldToECEFMatrix: source.worldToECEFMatrix
  })
  configure(integration.context)
  daytime(integration.aerial)
  const manual = createManualComposition(camera, scenePass, textures, renderer)
  const helperPipeline = new RenderPipeline(renderer, integration.output)
  helperPipeline.outputColorTransform = false
  const target = new RenderTarget(320, 180, { type: HalfFloatType })
  const providers = renderer.contextNode.value as Record<string, unknown>
  const helperProvider = providers.getClouds
  const world = source.worldToECEFMatrix.clone()
  const sun = source.sunDirection.clone()
  return {
    ...manual,
    renderer,
    camera,
    saved,
    atmosphere,
    scenePass,
    integration,
    helperPipeline,
    target,
    providers,
    helperProvider,
    world,
    sun
  }
}

function changeComparison(
  label: string,
  state: ReturnType<typeof createComparison>
): void {
  const { camera, world, sun, manual, integration } = state
  if (label === 'camera') camera.position.add(new Vector3(350, 0, 0))
  if (label === 'world')
    world.premultiply(new Matrix4().makeTranslation(2000, 0, 0))
  if (label === 'sun') sun.applyAxisAngle(new Vector3(0, 0, 1), 0.5).normalize()
  if (label === 'shadow') {
    for (const context of [manual.cloudsContext, integration.context]) {
      for (const layer of context.cloudLayers) layer.shadow = false
      context.shadow.mapSize.set(64, 64)
    }
  }
  if (label === 'clouds-disabled') {
    manual.cloudsContext.enabled = false
    integration.context.enabled = false
  }
  camera.updateMatrixWorld()
  manual.cloudsContext.worldToECEFMatrix.copy(world)
  manual.cloudsContext.sunDirection.copy(sun)
  integration.update({
    time: 10,
    frame: 0,
    worldToECEFMatrix: world,
    sunDirection: sun
  })
  manual.resetHistory()
  integration.resetHistory()
}

function disposeComparison(state: ReturnType<typeof createComparison>): void {
  const {
    providers,
    helperProvider,
    helperPipeline,
    manualPipeline,
    integration,
    manualOutput,
    disposeManualAerial,
    manual,
    atmosphere,
    scenePass,
    target,
    renderer,
    camera,
    saved
  } = state
  providers.getClouds = helperProvider
  helperPipeline.dispose()
  manualPipeline.dispose()
  integration.dispose()
  manualOutput.dispose()
  disposeManualAerial()
  manual.dispose()
  manual.cloudsContext.localWeatherTexture = null
  manual.cloudsContext.shapeTexture = null
  manual.cloudsContext.shapeDetailTexture = null
  manual.cloudsContext.turbulenceTexture = null
  manual.cloudsContext.stbnTexture = null
  manual.cloudsContext.dispose()
  atmosphere.dispose()
  scenePass.dispose()
  target.dispose()
  renderer.contextNode = saved.contextNode
  renderer.setRenderTarget(saved.target)
  camera.position.copy(saved.position)
  camera.quaternion.copy(saved.quaternion)
  camera.scale.copy(saved.scale)
  camera.updateMatrixWorld()
}

async function warmAtmosphere(
  state: ReturnType<typeof createComparison>
): Promise<void> {
  const { atmosphere, providers, manual, renderer, manualPipeline, target } =
    state
  const lut = atmosphere.lutNode
  const previous = Object.getOwnPropertyDescriptor(lut, 'updateTextures')
  const updateTextures = lut.updateTextures.bind(lut)
  let pending: Promise<void> | undefined
  lut.updateTextures = activeRenderer => {
    pending = updateTextures(activeRenderer)
    return pending
  }
  try {
    changeComparison('static', state)
    providers.getClouds = () => manual.cloudsContext
    await renderPixels(renderer, manualPipeline, target, frame => {
      manual.cloudsContext.time = 10
      manual.cloudsContext.frame = frame
    })
    if (pending == null)
      throw new Error('Atmosphere LUT update was not observed')
    await pending
    providers.getClouds = state.helperProvider
    await renderPixels(renderer, state.helperPipeline, target, frame => {
      state.integration.update({ time: 10, frame })
    })
  } finally {
    if (previous == null) Reflect.deleteProperty(lut, 'updateTextures')
    else Object.defineProperty(lut, 'updateTextures', previous)
  }
}

export async function compareCloudsIntegration(probe: ParityProbe) {
  const state = createComparison(probe)
  const {
    manual,
    integration,
    providers,
    renderer,
    manualPipeline,
    helperPipeline,
    target,
    atmosphere,
    helperProvider
  } = state
  const results = []
  let previous: Float32Array | undefined
  try {
    await warmAtmosphere(state)
    for (const label of [
      'static',
      'camera',
      'world',
      'sun',
      'shadow',
      'clouds-disabled'
    ]) {
      changeComparison(label, state)
      providers.getClouds = () => manual.cloudsContext
      const manualPixels = await renderPixels(
        renderer,
        manualPipeline,
        target,
        frame => {
          manual.cloudsContext.time = 10
          manual.cloudsContext.frame = frame
          atmosphere.matrixWorldToECEF.value.copy(
            manual.cloudsContext.worldToECEFMatrix
          )
          atmosphere.sunDirectionECEF.value.copy(
            manual.cloudsContext.sunDirection
          )
        }
      )
      providers.getClouds = helperProvider
      const helperPixels = await renderPixels(
        renderer,
        helperPipeline,
        target,
        frame => integration.update({ time: 10, frame })
      )
      results.push({
        label,
        ...measurePair(manualPixels, helperPixels, previous)
      })
      previous = helperPixels
    }
    return {
      results,
      atmosphereLutCompleted: true,
      diagnostics: integration.diagnostics(),
      errors: [...probe.errors]
    }
  } finally {
    disposeComparison(state)
  }
}
