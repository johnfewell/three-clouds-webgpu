// Setup observations are not rendering qualification
import type { Texture, Vector3 } from 'three'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

import { isForeignCloudsContext, type CloudsContext } from './CloudsContext'
import type { CloudsPassNode } from './CloudsPassNode'
import { experimentalWarnings } from './experimental/options'

/** One observable setup problem, with a stable code and input path */
export interface CloudSetupDiagnostic {
  /** Stable problem category for branching without parsing prose */
  code:
    | 'backend.webgl'
    | 'backend.not-initialized'
    | 'backend.unknown'
    | 'provider.missing'
    | 'provider.threw'
    | 'provider.duplicate-clouds'
    | 'provider.clouds-mismatch'
    | 'provider.atmosphere-invalid'
    | 'provider.atmosphere-mismatch'
    | 'direction.invalid'
    | 'asset.missing'
    | 'asset.wrong-dimension'
    | 'asset.not-loaded'
    | 'layers.invalid-slots'
    | 'layers.invalid-channel'
    | 'camera.missing'
    | 'camera.atmosphere-mismatch'
    | 'depth.mode-invalid'
    | 'depth.missing'
    | `feature.${string}`
  /** Errors invalidate configuration, warnings retain their separate remedies */
  severity: 'error' | 'warning'
  /** Input path to inspect or correct */
  path: string
  /** Plain observed value, not a retained texture, renderer or context */
  observed: string | number | boolean | null | readonly number[]
  /** Human-readable explanation, not a stable machine identifier */
  message: string
  /** Suggested correction, never applied by this inspection */
  remedy: string
}

/** Existing objects to inspect, never a second configuration store */
export interface InspectCloudsSetupOptions {
  /** Inspect after renderer.init(), earlier calls report not-initialized */
  renderer: unknown
  /** The actual pass whose context must match the renderer's provider */
  pass: CloudsPassNode
  /** Optional expected identity in addition to inspecting the active provider */
  atmosphere?: AtmosphereContext
  /** Scene mode requires depth, sky-only explicitly permits missing depth */
  depthMode: 'scene' | 'sky-only'
}

/** CPU observations only, not shader compilation or GPU completion evidence */
export interface CloudsSetupInspection {
  /** Observed errors and warnings, including experimental feature warnings */
  diagnostics: CloudSetupDiagnostic[]
  /** Assets describe CPU observations, graph and frame are always unobserved */
  readiness: {
    configuration: 'valid' | 'invalid'
    assets: 'ready' | 'not-ready'
    graph: 'unobserved'
    frame: 'unobserved'
  }
}

interface RendererInspection {
  initialized?: boolean
  backend?: { isWebGLBackend?: boolean; isWebGPUBackend?: boolean }
  contextNode?: { value?: Record<string, unknown> }
}

function issue(
  code: CloudSetupDiagnostic['code'],
  path: string,
  observed: CloudSetupDiagnostic['observed'],
  message: string,
  remedy: string,
  severity: CloudSetupDiagnostic['severity'] = 'error'
): CloudSetupDiagnostic {
  return { code, severity, path, observed, message, remedy }
}

export function inspectCloudsBackend(
  renderer: unknown,
  requireInitialized = true
): CloudSetupDiagnostic | null {
  const state = renderer as RendererInspection | null | undefined
  if (state?.backend?.isWebGLBackend === true) {
    return issue(
      'backend.webgl',
      'renderer.backend',
      'webgl',
      'three-clouds-webgpu: the WebGL2 backend of WebGPURenderer is not yet verified.',
      'Use the native WebGPU backend, or see WEBGPU.md for the support matrix.'
    )
  }
  if (requireInitialized && state?.initialized !== true) {
    return issue(
      'backend.not-initialized',
      'renderer.initialized',
      state?.initialized ?? null,
      'Renderer initialization has not been observed.',
      'Call this after `await renderer.init()`; a backend object alone is not readiness.'
    )
  }
  if (state?.backend?.isWebGPUBackend !== true) {
    return issue(
      'backend.unknown',
      'renderer.backend',
      'unknown',
      'The renderer does not identify a native WebGPU backend.',
      'Use an initialized WebGPURenderer and inspect its selected backend.'
    )
  }
  return null
}

const UNRESOLVED_PROVIDER = Symbol()

function inspectProvider(
  providers: Record<string, unknown>,
  name: 'getClouds' | 'getAtmosphere',
  diagnostics: CloudSetupDiagnostic[]
): unknown {
  const provider = providers[name]
  const path = `renderer.contextNode.value.${name}`
  if (typeof provider !== 'function') {
    diagnostics.push(
      issue(
        'provider.missing',
        path,
        typeof provider,
        `The ${name} provider is missing.`,
        'Register the context provider while preserving unrelated renderer context fields.'
      )
    )
    return UNRESOLVED_PROVIDER
  }
  try {
    return (provider as () => unknown)()
  } catch (error) {
    diagnostics.push(
      issue(
        'provider.threw',
        path,
        error instanceof Error ? error.message : String(error),
        `The ${name} provider threw instead of returning its context.`,
        'Make the provider return the existing context without throwing.'
      )
    )
    return UNRESOLVED_PROVIDER
  }
}

function inspectCloudsProvider(
  value: unknown,
  context: CloudsContext,
  diagnostics: CloudSetupDiagnostic[]
): void {
  if (value === UNRESOLVED_PROVIDER || value === context) return
  const duplicate = isForeignCloudsContext(value)
  diagnostics.push(
    issue(
      duplicate ? 'provider.duplicate-clouds' : 'provider.clouds-mismatch',
      'renderer.contextNode.value.getClouds',
      duplicate ? 'different constructor' : 'different context',
      'The clouds provider does not return this pass’s CloudsContext.',
      duplicate
        ? 'Deduplicate three-clouds-webgpu so the provider and pass use the same constructor.'
        : 'Return pass.cloudsContext from getClouds.'
    )
  )
}

function inspectAtmosphereProvider(
  value: unknown,
  expected: AtmosphereContext | undefined,
  diagnostics: CloudSetupDiagnostic[]
): AtmosphereContext | undefined {
  if (value === UNRESOLVED_PROVIDER) return undefined
  if (!(value instanceof AtmosphereContext)) {
    diagnostics.push(
      issue(
        'provider.atmosphere-invalid',
        'renderer.contextNode.value.getAtmosphere',
        'not this AtmosphereContext constructor',
        'The atmosphere provider returns an incompatible context.',
        'Return an AtmosphereContext from the same @takram/three-atmosphere package copy.'
      )
    )
    return undefined
  }
  if (expected != null && value !== expected) {
    diagnostics.push(
      issue(
        'provider.atmosphere-mismatch',
        'renderer.contextNode.value.getAtmosphere',
        'different context',
        'The provider returns a different atmosphere from the supplied one.',
        'Register the same atmosphere instance used by the composition.'
      )
    )
  }
  return value
}

function inspectDirection(
  value: Vector3,
  path: string,
  diagnostics: CloudSetupDiagnostic[]
): void {
  const components = value.toArray()
  if (
    components.every(Number.isFinite) &&
    Number.isFinite(value.lengthSq()) &&
    value.lengthSq() > 0
  )
    return
  diagnostics.push(
    issue(
      'direction.invalid',
      path,
      components,
      'A celestial direction must be finite and nonzero.',
      'Set a normalized ECEF direction, or use syncCelestialDirections for every participating context.'
    )
  )
}

function inspectTexture(
  texture: Texture | null,
  path: string,
  dimensions: 2 | 3,
  diagnostics: CloudSetupDiagnostic[]
): boolean {
  if (texture == null) {
    diagnostics.push(
      issue(
        'asset.missing',
        path,
        null,
        'A required texture has not been supplied.',
        'Await loading and assign the texture, or supply a procedural generator.',
        'warning'
      )
    )
    return false
  }
  const volume = texture as Texture & {
    isData3DTexture?: boolean
    isStorage3DTexture?: boolean
    isDataArrayTexture?: boolean
  }
  const isVolume =
    volume.isData3DTexture === true || volume.isStorage3DTexture === true
  if (isVolume !== (dimensions === 3) || volume.isDataArrayTexture === true) {
    diagnostics.push(
      issue(
        'asset.wrong-dimension',
        path,
        isVolume ? '3D' : 'not 3D',
        `This slot requires a ${dimensions}D texture.`,
        'Assign the matching 2D image or 3D volume, not an array texture.'
      )
    )
    return false
  }
  return inspectTextureDimensions(texture, path, dimensions, diagnostics)
}

function inspectTextureDimensions(
  texture: Texture,
  path: string,
  dimensions: 2 | 3,
  diagnostics: CloudSetupDiagnostic[]
): boolean {
  const image = texture.image as
    | { width?: number; height?: number; depth?: number; complete?: boolean }
    | null
    | undefined
  const size = [image?.width ?? 0, image?.height ?? 0]
  if (dimensions === 3) size.push(image?.depth ?? 0)
  if (
    image?.complete !== false &&
    size.every(value => Number.isInteger(value) && value > 0)
  )
    return true
  diagnostics.push(
    issue(
      'asset.not-loaded',
      path,
      size,
      'The image is still loading or its dimensions are not positive integers.',
      'Wait for CPU image decoding or supply valid texture dimensions before rendering.',
      'warning'
    )
  )
  return false
}

function inspectAssets(
  context: CloudsContext,
  diagnostics: CloudSetupDiagnostic[]
): boolean {
  if (!context.enabled) return true
  const slots: [Texture | null, string, 2 | 3][] = [
    [context.resolvedLocalWeatherTexture, 'localWeatherTexture', 2],
    [context.resolvedShapeTexture, 'shapeTexture', 3]
  ]
  if (context.shapeDetail)
    slots.push([context.resolvedShapeDetailTexture, 'shapeDetailTexture', 3])
  if (context.turbulence)
    slots.push([context.resolvedTurbulenceTexture, 'turbulenceTexture', 2])
  if (context.resolvedStbnTexture != null)
    slots.push([context.resolvedStbnTexture, 'stbnTexture', 3])
  return slots
    .map(([texture, name, dimension]) =>
      inspectTexture(
        texture,
        `pass.cloudsContext.${name}`,
        dimension,
        diagnostics
      )
    )
    .every(Boolean)
}

function inspectLayers(
  context: CloudsContext,
  diagnostics: CloudSetupDiagnostic[]
): void {
  const layers = context.cloudLayers
  if (
    layers.length !== 4 ||
    [0, 1, 2, 3].some(index => layers[index] == null)
  ) {
    diagnostics.push(
      issue(
        'layers.invalid-slots',
        'pass.cloudsContext.cloudLayers',
        layers.length,
        'The cloud layer array must contain exactly four populated slots.',
        'Use cloudLayers.set() to configure the four slots; do not push or remove array entries.'
      )
    )
    return
  }
  for (const [index, layer] of layers.entries()) {
    if (!['r', 'g', 'b', 'a'].includes(layer.channel)) {
      diagnostics.push(
        issue(
          'layers.invalid-channel',
          `pass.cloudsContext.cloudLayers[${index}].channel`,
          String(layer.channel),
          'A weather channel must be r, g, b or a.',
          'Choose a channel present in the local weather texture.'
        )
      )
    }
  }
  for (const warning of experimentalWarnings({
    experimental: context.experimental,
    debug: context.debug,
    castsShadow: layers.castsShadow,
    localWeatherVelocity: context.localWeatherVelocity,
    lightShafts: context.lightShafts
  })) {
    diagnostics.push(
      issue(
        `feature.${warning.id}`,
        `pass.cloudsContext.experimental.${warning.id.split('/')[0]}`,
        true,
        warning.message,
        warning.message,
        'warning'
      )
    )
  }
}

function inspectCamera(
  pass: CloudsPassNode,
  atmosphere: AtmosphereContext | undefined,
  diagnostics: CloudSetupDiagnostic[]
): void {
  if (pass.camera == null) {
    diagnostics.push(
      issue(
        'camera.missing',
        'pass.camera',
        null,
        'No scene camera is assigned to the cloud pass.',
        'Assign the same camera used by the scene pass and atmosphere.'
      )
    )
  }
  if (atmosphere != null && atmosphere.camera !== pass.camera) {
    diagnostics.push(
      issue(
        'camera.atmosphere-mismatch',
        'atmosphere.camera',
        atmosphere.camera == null ? null : 'different camera',
        'The atmosphere and clouds do not use the same explicit scene camera.',
        'Assign pass.camera to atmosphere.camera before building the graph.'
      )
    )
  }
}

function inspectDepth(
  pass: CloudsPassNode,
  depthMode: InspectCloudsSetupOptions['depthMode'],
  diagnostics: CloudSetupDiagnostic[]
): void {
  if (depthMode !== 'scene' && depthMode !== 'sky-only') {
    diagnostics.push(
      issue(
        'depth.mode-invalid',
        'depthMode',
        String(depthMode),
        'The depth policy must be explicitly declared.',
        'Choose depthMode: "scene" or depthMode: "sky-only".'
      )
    )
  }
  if (depthMode === 'scene' && pass.sceneDepth == null) {
    diagnostics.push(
      issue(
        'depth.missing',
        'pass.sceneDepth',
        null,
        'Scene occlusion was requested without a scene depth texture node.',
        'Assign scenePass.getTextureNode("depth"), or explicitly select depthMode: "sky-only".'
      )
    )
  }
}

/**
 * Inspect setup without loading textures, creating GPU resources or rendering
 *
 * @remarks
 * Requires: the actual pass and renderer, with an explicit depth policy
 * Mutation: none by the inspector, registered context providers are called
 * Readiness: graph and frame stay unobserved even when assets are ready
 * Ownership: all inputs are borrowed, no lazy jitter texture is allocated
 */
export function inspectCloudsSetup({
  renderer,
  pass,
  atmosphere: expectedAtmosphere,
  depthMode
}: InspectCloudsSetupOptions): CloudsSetupInspection {
  const diagnostics: CloudSetupDiagnostic[] = []
  const backend = inspectCloudsBackend(renderer)
  if (backend != null) diagnostics.push(backend)
  const providers =
    (renderer as RendererInspection | null | undefined)?.contextNode?.value ??
    {}
  inspectCloudsProvider(
    inspectProvider(providers, 'getClouds', diagnostics),
    pass.cloudsContext,
    diagnostics
  )
  const atmosphere = inspectAtmosphereProvider(
    inspectProvider(providers, 'getAtmosphere', diagnostics),
    expectedAtmosphere,
    diagnostics
  )
  inspectCamera(pass, atmosphere, diagnostics)
  inspectDepth(pass, depthMode, diagnostics)
  if (pass.cloudsContext.enabled)
    inspectDirection(
      pass.cloudsContext.sunDirection,
      'pass.cloudsContext.sunDirection',
      diagnostics
    )
  if (pass.cloudsContext.experimental.moonlight)
    inspectDirection(
      pass.cloudsContext.moonDirection,
      'pass.cloudsContext.moonDirection',
      diagnostics
    )
  if (atmosphere != null)
    inspectDirection(
      atmosphere.sunDirectionECEF.value,
      'atmosphere.sunDirectionECEF.value',
      diagnostics
    )
  const assetsReady = inspectAssets(pass.cloudsContext, diagnostics)
  inspectLayers(pass.cloudsContext, diagnostics)
  return {
    diagnostics,
    readiness: {
      configuration: diagnostics.some(item => item.severity === 'error')
        ? 'invalid'
        : 'valid',
      assets: assetsReady ? 'ready' : 'not-ready',
      graph: 'unobserved',
      frame: 'unobserved'
    }
  }
}
