// Explicit composition ownership, without renderer or animation-loop policy
import type {
  Camera,
  Data3DTexture,
  Matrix4,
  PerspectiveCamera,
  Vector3
} from 'three'
import { float, Fn, context as tslContext, uv, vec4 } from 'three/tsl'
import type { Node, PassNode, TextureNode, WebGPURenderer } from 'three/webgpu'

import {
  AerialPerspectiveNode,
  AtmosphereContext,
  SkyNode
} from '@takram/three-atmosphere/webgpu'
import {
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

import type { CloudsContext } from './CloudsContext'
import {
  assertWebGPUSupported,
  clouds,
  type CloudsPassNode
} from './CloudsPassNode'
import { inspectCloudsSetup, type CloudsSetupInspection } from './diagnostics'
import type { CloudsCompositeNode } from './pass/compositeNodes'
import { assertAerialShadowInputs } from './shadow/aerialShadowAdapter'

/** Borrowed resources, including procedural generators, never disposed here */
export type CloudsIntegrationTextures = Pick<
  CloudsContext,
  | 'localWeatherTexture'
  | 'shapeTexture'
  | 'shapeDetailTexture'
  | 'turbulenceTexture'
> & { stbnTexture?: Data3DTexture | null }

/** Explicit composition inputs, with no renderer or scene policy defaults */
export interface CloudsIntegrationOptions {
  renderer: WebGPURenderer
  /** Perspective camera only, mutate in place or rebuild to replace it */
  camera: PerspectiveCamera
  atmosphere: AtmosphereContext
  /** Fixed depth-node identity, with output and view-normal MRT for post mode */
  scenePass: PassNode
  lighting: 'post' | 'lights'
  textures: CloudsIntegrationTextures
  cloudsPass?: CloudsPassNode
  /** Required for a new pass, otherwise defaults to the borrowed context */
  sunDirection?: Vector3
  /** Copied into the context, identity means world positions are ECEF metres */
  worldToECEFMatrix?: Matrix4
}

/** Caller-owned seconds and sample index, with optional authoritative inputs */
export interface CloudsIntegrationUpdate {
  time: number
  frame: number
  sunDirection?: Vector3
  moonDirection?: Vector3
  worldToECEFMatrix?: Matrix4
}

/** A composition lease, not a renderer, clock or asset owner */
export interface CloudsIntegration {
  readonly pass: CloudsPassNode
  readonly context: CloudsContext
  readonly aerial: AerialPerspectiveNode
  /** Assign to the caller's pipeline, stop rendering it before disposal */
  readonly output: CloudsCompositeNode
  /** Inspect current CPU inputs, never infer graph compilation or frame completion */
  diagnostics(): CloudsSetupInspection
  /** Call before rendering, sync context-owned sun/world/moon to the atmosphere */
  update(inputs: CloudsIntegrationUpdate): void
  /** Explicit temporal reset for seeks, camera jumps and other discontinuities */
  resetHistory(): void
  /** Release owned composition/pass resources, never borrowed inputs */
  dispose(): void
}

const activeRenderers = new WeakSet<WebGPURenderer>()
const activePasses = new WeakSet<CloudsPassNode>()
const textureKeys = [
  'localWeatherTexture',
  'shapeTexture',
  'shapeDetailTexture',
  'turbulenceTexture'
] as const

function fail(message: string): never {
  throw new Error(`createCloudsIntegration: ${message}`)
}

function validateDirection(direction: Vector3, name: string): void {
  if (
    !direction.toArray().every(Number.isFinite) ||
    !Number.isFinite(direction.lengthSq()) ||
    direction.lengthSq() === 0
  ) {
    fail(`${name} must be a finite nonzero ECEF direction.`)
  }
}

function validateWorldMatrix(matrix: Matrix4 | undefined): void {
  if (matrix == null) return
  const determinant = matrix.determinant()
  if (
    !matrix.elements.every(Number.isFinite) ||
    !Number.isFinite(determinant) ||
    determinant === 0
  ) {
    fail('worldToECEFMatrix must be finite and invertible.')
  }
}

function validateOwnership(options: CloudsIntegrationOptions): void {
  const { renderer, cloudsPass } = options
  if (activeRenderers.has(renderer))
    fail('This renderer already has an active integration.')
  if (cloudsPass != null && activePasses.has(cloudsPass))
    fail('This cloud pass already has an active integration.')
  if (cloudsPass?.hasComposite === true)
    fail(
      'The supplied cloud pass already has a cached composite. Use a fresh pass.'
    )
}

function validateLighting(options: CloudsIntegrationOptions): void {
  const { lighting, scenePass } = options
  if (lighting !== 'post' && lighting !== 'lights')
    fail('Choose lighting: post or lights.')
  if (lighting === 'post') {
    const targets = scenePass.getMRT()
    if (targets?.has('output') !== true || !targets.has('normal')) {
      fail(
        'Post lighting requires scenePass MRT output and normalView as normal.'
      )
    }
  }
}

function validateOptions(options: CloudsIntegrationOptions): TextureNode {
  const { renderer, camera, atmosphere, scenePass, cloudsPass } = options
  assertWebGPUSupported(renderer)
  if (!(atmosphere instanceof AtmosphereContext)) {
    fail('Supply an AtmosphereContext from the same atmosphere package copy.')
  }
  validateOwnership(options)
  validateLighting(options)
  validateCameraIdentity(camera, atmosphere, scenePass, cloudsPass)
  const sun = options.sunDirection ?? cloudsPass?.cloudsContext.sunDirection
  if (sun == null) fail('Supply sunDirection when creating a new cloud pass.')
  validateDirection(sun, 'sunDirection')
  validateWorldMatrix(
    options.worldToECEFMatrix ?? cloudsPass?.cloudsContext.worldToECEFMatrix
  )
  const depth = scenePass.getTextureNode('depth')
  if (cloudsPass?.sceneDepth != null && cloudsPass.sceneDepth !== depth) {
    fail(
      'The supplied cloud pass uses a different depth node. Rebuild its composition explicitly.'
    )
  }
  return depth
}

function validateCameraIdentity(
  camera: Camera,
  atmosphere: AtmosphereContext,
  scenePass: PassNode,
  pass?: CloudsPassNode
): void {
  if (!('isPerspectiveCamera' in camera) || camera.isPerspectiveCamera !== true)
    fail('Supply a PerspectiveCamera. Orthographic cameras are not supported.')
  if (
    scenePass.camera !== camera ||
    (atmosphere.camera != null && atmosphere.camera !== camera) ||
    (pass?.camera != null && pass.camera !== camera)
  ) {
    fail(
      'Scene, cloud and atmosphere cameras must share the supplied camera identity.'
    )
  }
}

function copyTextures(
  context: CloudsContext,
  textures: CloudsIntegrationTextures
): void {
  context.localWeatherTexture = textures.localWeatherTexture
  context.shapeTexture = textures.shapeTexture
  context.shapeDetailTexture = textures.shapeDetailTexture
  context.turbulenceTexture = textures.turbulenceTexture
  if (textures.stbnTexture !== undefined)
    context.stbnTexture = textures.stbnTexture
}

function syncAtmosphere(
  context: CloudsContext,
  atmosphere: AtmosphereContext
): void {
  atmosphere.matrixWorldToECEF.value.copy(context.worldToECEFMatrix)
  atmosphere.sunDirectionECEF.value.copy(context.sunDirection)
  atmosphere.moonDirectionECEF.value.copy(context.moonDirection)
}

function inputRollback(
  options: CloudsIntegrationOptions,
  pass: CloudsPassNode
): () => void {
  const context = pass.cloudsContext
  const { atmosphere } = options
  const previous = {
    camera: pass.camera,
    depth: pass.sceneDepth,
    textures: {
      localWeatherTexture: context.localWeatherTexture,
      shapeTexture: context.shapeTexture,
      shapeDetailTexture: context.shapeDetailTexture,
      turbulenceTexture: context.turbulenceTexture,
      stbnTexture: context.resolvedStbnTexture
    },
    sun: context.sunDirection.clone(),
    world: context.worldToECEFMatrix.clone(),
    atmosphereCamera: atmosphere.camera,
    atmosphereSun: atmosphere.sunDirectionECEF.value.clone(),
    atmosphereMoon: atmosphere.moonDirectionECEF.value.clone(),
    atmosphereWorld: atmosphere.matrixWorldToECEF.value.clone()
  }
  return () => {
    pass.camera = previous.camera
    pass.sceneDepth = previous.depth
    copyTextures(context, previous.textures)
    context.sunDirection.copy(previous.sun)
    context.worldToECEFMatrix.copy(previous.world)
    atmosphere.camera = previous.atmosphereCamera
    atmosphere.sunDirectionECEF.value.copy(previous.atmosphereSun)
    atmosphere.moonDirectionECEF.value.copy(previous.atmosphereMoon)
    atmosphere.matrixWorldToECEF.value.copy(previous.atmosphereWorld)
  }
}

function configureInputs(
  options: CloudsIntegrationOptions,
  pass: CloudsPassNode,
  depth: TextureNode
): void {
  const context = pass.cloudsContext
  pass.camera = options.camera
  pass.sceneDepth = depth
  options.atmosphere.camera = options.camera
  copyTextures(context, options.textures)
  if (options.sunDirection != null)
    context.sunDirection.copy(options.sunDirection)
  if (options.worldToECEFMatrix != null)
    context.worldToECEFMatrix.copy(options.worldToECEFMatrix)
  syncAtmosphere(context, options.atmosphere)
  const providers = {
    getClouds: () => context,
    getAtmosphere: () => options.atmosphere
  }
  const inspection = inspectCloudsSetup({
    renderer: {
      initialized: options.renderer.initialized,
      backend: options.renderer.backend,
      contextNode: { value: providers }
    },
    pass,
    atmosphere: options.atmosphere,
    depthMode: 'scene'
  })
  if (
    inspection.readiness.configuration === 'invalid' ||
    inspection.readiness.assets !== 'ready'
  ) {
    fail(
      inspection.diagnostics
        .map(item => `${item.code} (${item.path}): ${item.remedy}`)
        .join(' ')
    )
  }
}

function sameValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  const keys = Reflect.ownKeys(left)
  return (
    keys.length === Reflect.ownKeys(right).length &&
    keys.every(
      key =>
        Object.hasOwn(right, key) &&
        Reflect.get(left, key) === Reflect.get(right, key)
    )
  )
}

function installProviders(
  options: CloudsIntegrationOptions,
  pass: CloudsPassNode
): () => void {
  const { renderer, atmosphere } = options
  const previousNode = renderer.contextNode
  const previous = { ...(previousNode.value as Record<string, unknown>) }
  const providers = {
    getClouds: () => pass.cloudsContext,
    getAtmosphere: () => atmosphere
  }
  const installed = tslContext({ ...previous, ...providers })
  renderer.contextNode = installed
  return () => {
    const current = renderer.contextNode?.value as Record<string, unknown>
    if (current == null || typeof current !== 'object') return
    for (const name of ['getClouds', 'getAtmosphere'] as const) {
      if (current[name] !== providers[name]) continue
      if (Object.hasOwn(previous, name)) current[name] = previous[name]
      else Reflect.deleteProperty(current, name)
    }
    if (renderer.contextNode === installed && sameValues(current, previous)) {
      renderer.contextNode = previousNode
    }
  }
}

function makeAerial(
  options: CloudsIntegrationOptions,
  pass: CloudsPassNode,
  depth: TextureNode
): AerialPerspectiveNode {
  const { camera, scenePass, lighting } = options
  const shadow =
    lighting === 'post'
      ? Fn(() => {
          const sample = depth.r.toConst()
          const viewZ = depthToViewZ(sample, camera)
          const positionView = screenToPositionView(
            uv(),
            sample,
            viewZ,
            projectionMatrix(camera),
            inverseProjectionMatrix(camera)
          ) as unknown as Node<'vec3'>
          const positionWorld = (
            inverseViewMatrix(camera) as unknown as Node<'mat4'>
          ).mul(vec4(positionView, 1)).xyz
          return pass.cloudShadowAt(positionWorld, {
            radius: float(0),
            jitter: float(0)
          })
        })()
      : null
  const aerial = new AerialPerspectiveNode(
    scenePass.getTextureNode('output'),
    depth,
    lighting === 'post' ? scenePass.getTextureNode('normal') : undefined,
    pass.cloudShadowLength
  )
  if (shadow != null) {
    assertAerialShadowInputs(aerial)
    aerial.shadowNode = shadow
  }
  aerial.lighting = lighting === 'post'
  return aerial
}

function aerialCleanup(aerial: AerialPerspectiveNode): () => void {
  const sky = aerial.skyNode
  const children =
    sky instanceof SkyNode ? [sky.sunNode, sky.moonNode, sky.starsNode] : []
  return () => {
    aerial.skyNode = null
    aerial.dispose()
    for (const child of new Set(children)) child.dispose()
    sky?.dispose()
  }
}

function disposeOwnedPass(pass: CloudsPassNode): void {
  for (const key of textureKeys) pass.cloudsContext[key] = null
  pass.cloudsContext.stbnTexture = null
  pass.dispose()
  pass.cloudsContext.dispose()
}

function validateUpdate(
  inputs: CloudsIntegrationUpdate,
  context: CloudsContext
): void {
  if (
    !Number.isFinite(inputs.time) ||
    !Number.isSafeInteger(inputs.frame) ||
    inputs.frame < 0
  ) {
    fail(
      'update requires finite time in seconds and a nonnegative integer frame.'
    )
  }
  validateDirection(inputs.sunDirection ?? context.sunDirection, 'sunDirection')
  if (inputs.moonDirection != null)
    validateDirection(inputs.moonDirection, 'moonDirection')
  validateWorldMatrix(inputs.worldToECEFMatrix ?? context.worldToECEFMatrix)
}

function createHandle(
  options: CloudsIntegrationOptions,
  pass: CloudsPassNode,
  depth: TextureNode,
  aerial: AerialPerspectiveNode,
  output: CloudsCompositeNode,
  releaseProviders: () => void
): CloudsIntegration {
  const context = pass.cloudsContext
  const disposeAerial = aerialCleanup(aerial)
  let disposed = false
  const assertActive = (): void => {
    if (disposed)
      fail(
        'This integration is disposed. Create a new integration before using it.'
      )
  }
  return {
    pass,
    context,
    aerial,
    output,
    diagnostics() {
      assertActive()
      return inspectCloudsSetup({
        renderer: options.renderer,
        pass,
        atmosphere: options.atmosphere,
        depthMode: 'scene'
      })
    },
    update(inputs) {
      assertActive()
      if (
        options.scenePass.camera !== options.camera ||
        pass.camera !== options.camera ||
        options.atmosphere.camera !== options.camera ||
        pass.sceneDepth !== depth ||
        options.scenePass.getTextureNode('depth') !== depth
      ) {
        fail(
          'Camera or scene-depth identity changed. Dispose and rebuild this integration.'
        )
      }
      validateUpdate(inputs, context)
      if (inputs.sunDirection != null)
        context.sunDirection.copy(inputs.sunDirection)
      if (inputs.moonDirection != null)
        context.moonDirection.copy(inputs.moonDirection)
      if (inputs.worldToECEFMatrix != null)
        context.worldToECEFMatrix.copy(inputs.worldToECEFMatrix)
      context.time = inputs.time
      context.frame = inputs.frame
      syncAtmosphere(context, options.atmosphere)
    },
    resetHistory() {
      assertActive()
      pass.resetHistory()
    },
    dispose() {
      if (disposed) return
      disposed = true
      releaseProviders()
      activeRenderers.delete(options.renderer)
      activePasses.delete(pass)
      output.dispose()
      disposeAerial()
      if (options.cloudsPass == null) disposeOwnedPass(pass)
    }
  }
}

/**
 * Compose an initialized renderer's scene, atmosphere and clouds
 * Borrows renderer, camera, atmosphere, scene pass and supplied textures
 * Owns its composition and optional new pass, never disposes a supplied pass
 * Camera/depth identities stay fixed, their transforms and context values stay live
 * Call update with your own time/frame before rendering, then dispose on teardown
 */
export function createCloudsIntegration(
  options: CloudsIntegrationOptions
): CloudsIntegration {
  options = { ...options, textures: { ...options.textures } }
  const depth = validateOptions(options)
  const pass = options.cloudsPass ?? clouds({ sceneDepth: depth })
  activeRenderers.add(options.renderer)
  activePasses.add(pass)
  let aerial: AerialPerspectiveNode | undefined
  let output: CloudsCompositeNode | undefined
  let releaseProviders: (() => void) | undefined
  let rollback: (() => void) | undefined
  try {
    rollback = inputRollback(options, pass)
    configureInputs(options, pass, depth)
    aerial = makeAerial(options, pass, depth)
    output = pass.composite(aerial)
    releaseProviders = installProviders(options, pass)
    return createHandle(options, pass, depth, aerial, output, releaseProviders)
  } catch (error) {
    releaseProviders?.()
    output?.dispose()
    if (aerial != null) aerialCleanup(aerial)()
    rollback?.()
    if (options.cloudsPass == null) disposeOwnedPass(pass)
    activeRenderers.delete(options.renderer)
    activePasses.delete(pass)
    throw error
  }
}
