import {
  clouds,
  inspectCloudsSetup,
  type CloudsIntegration,
  type CloudsIntegrationOptions
} from 'three-clouds-webgpu'
import { context as tslContext } from 'three/tsl'

import { AerialPerspectiveNode, SkyNode } from '@takram/three-atmosphere/webgpu'

import { createManualAerialShadow } from './manualAerial'

export function createManualIntegration(
  options: CloudsIntegrationOptions
): CloudsIntegration {
  const { renderer, camera, atmosphere, scenePass, textures, sunDirection } =
    options
  if (
    options.lighting !== 'post' ||
    options.cloudsPass != null ||
    sunDirection == null
  ) {
    throw new Error(
      'This manual recipe creates its own post-lit pass and requires a sun direction'
    )
  }
  const depth = scenePass.getTextureNode('depth')
  const pass = clouds({ sceneDepth: depth })
  pass.camera = camera
  const context = pass.cloudsContext
  const cleanup: Array<() => void> = [
    () => {
      pass.dispose()
      context.localWeatherTexture = null
      context.shapeTexture = null
      context.shapeDetailTexture = null
      context.turbulenceTexture = null
      context.stbnTexture = null
      context.dispose()
    }
  ]
  const dispose = (): void => {
    for (const release of cleanup.splice(0).reverse()) release()
  }
  try {
    Object.assign(context, textures)
    context.sunDirection.copy(sunDirection)
    if (options.worldToECEFMatrix != null)
      context.worldToECEFMatrix.copy(options.worldToECEFMatrix)
    atmosphere.camera = camera
    atmosphere.sunDirectionECEF.value.copy(context.sunDirection)
    atmosphere.matrixWorldToECEF.value.copy(context.worldToECEFMatrix)
    const previousProviders = renderer.contextNode
    const providers = tslContext({
      ...(previousProviders.value as Record<string, unknown>),
      getClouds: () => context,
      getAtmosphere: () => atmosphere
    })
    renderer.contextNode = providers
    cleanup.push(() => {
      if (renderer.contextNode === providers)
        renderer.contextNode = previousProviders
    })
    const aerial = new AerialPerspectiveNode(
      scenePass.getTextureNode('output'),
      depth,
      scenePass.getTextureNode('normal'),
      pass.cloudShadowLength
    )
    aerial.shadowNode = createManualAerialShadow(
      camera,
      depth,
      pass.cloudShadowAt.bind(pass)
    )
    aerial.lighting = true
    const sky = aerial.skyNode
    cleanup.push(() => {
      aerial.skyNode = null
      aerial.dispose()
      if (sky instanceof SkyNode) {
        sky.sunNode.dispose()
        sky.moonNode.dispose()
        sky.starsNode.dispose()
      }
      sky?.dispose()
    })
    const output = pass.composite(aerial)
    cleanup.push(() => output.dispose())
    return {
      pass,
      context,
      aerial,
      output,
      diagnostics: () =>
        inspectCloudsSetup({ renderer, pass, atmosphere, depthMode: 'scene' }),
      update({ time, frame, sunDirection, moonDirection, worldToECEFMatrix }) {
        context.time = time
        context.frame = frame
        if (sunDirection != null) context.sunDirection.copy(sunDirection)
        if (moonDirection != null) context.moonDirection.copy(moonDirection)
        if (worldToECEFMatrix != null)
          context.worldToECEFMatrix.copy(worldToECEFMatrix)
        atmosphere.sunDirectionECEF.value.copy(context.sunDirection)
        atmosphere.moonDirectionECEF.value.copy(context.moonDirection)
        atmosphere.matrixWorldToECEF.value.copy(context.worldToECEFMatrix)
      },
      resetHistory: () => pass.resetHistory(),
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}
