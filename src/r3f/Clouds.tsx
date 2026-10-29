// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: r3f/Clouds.tsx:42-252

import { useThree } from '@react-three/fiber'
import {
  createContext,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
  type Ref
} from 'react'
import {
  NearestFilter,
  type Data3DTexture,
  type Matrix4,
  type Texture,
  type Vector3
} from 'three'
import type { Storage3DTexture, TextureNode } from 'three/webgpu'

import {
  STBN_TEXTURE_DEPTH,
  STBN_TEXTURE_HEIGHT,
  STBN_TEXTURE_WIDTH
} from '@takram/three-geospatial'

import type { CloudsContext, DebugView } from '../CloudsContext'
import {
  clouds as createCloudsPass,
  type CloudsPassNode
} from '../CloudsPassNode'
import {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL
} from '../constants'
import type { ExperimentalCloudOptions } from '../experimental/options'
import type { QualityPreset } from '../qualityPresets'
import {
  loadCloudTexture,
  loadCloudVolume
} from '../textures/loadBakedCloudTextures'
import type { ProceduralTextureLike } from '../textures/ProceduralTexture'
import { CloudLayers } from './CloudLayers'

// The original's <Clouds> is a CloudsEffect primitive that takes its camera
// from EffectComposerContext. Neither exists for a WebGPU/TSL post chain, and
// @takram/three-atmosphere has no `webgpu/r3f` pattern to copy

// So <Clouds> owns state and lifecycle only: it builds the pass, syncs props,
// hosts <CloudLayer> children and publishes the pass. The app composes it with
// `pass.composite(dst)`, as the reference leaves composing to EffectComposer
/** Mounted resources borrowed from the enclosing Clouds component */
export interface CloudsPassContextValue {
  /** Compose this pass, but do not dispose it independently of the component */
  pass: CloudsPassNode
  /** Configuration state, with caller-driven time and frame values */
  context: CloudsContext
  /** Asset lifecycle only, not shader compilation or visible-frame evidence */
  assets: CloudsAssetState
}

/**
 * URL assets load before ready, objects and lazy default jitter are ready inputs
 * An error disables the pass until inputs change and all assets become ready
 * This does not validate borrowed textures or prove a GPU frame rendered
 */
export type CloudsAssetState =
  | { status: 'loading' | 'ready'; error: null }
  | { status: 'error'; error: Error }

/** Advanced provider access, prefer useClouds inside the component tree */
export const CloudsPassContext =
  /*#__PURE__*/ createContext<CloudsPassContextValue | null>(null)

/**
 * Read the enclosing Clouds pass, context and loading/ready/error asset state
 * Requires: call inside a mounted Clouds descendant, otherwise it throws
 * Ownership: returned resources are borrowed and become invalid on unmount
 * The app still wires providers, atmosphere and its render pipeline
 */
export function useClouds(): CloudsPassContextValue {
  const value = useContext(CloudsPassContext)
  if (value == null) {
    throw new Error('useClouds can only be used within the Clouds component!')
  }
  return value
}

interface AssetResult<T> {
  value: T | null
  state: CloudsAssetState
}

interface LoadedAsset<T> {
  input: unknown
  lease: { live: boolean }
  value: T | null
  error: Error | null
}

function useAsset<Loaded extends Texture, Borrowed>(
  input: string | Borrowed | undefined,
  load: (url: string, signal: AbortSignal) => Promise<Loaded>
): AssetResult<Loaded | Borrowed> {
  const [loaded, setLoaded] = useState<LoadedAsset<Loaded> | null>(null)
  useEffect(() => {
    if (typeof input !== 'string') return
    const controller = new AbortController()
    const lease = { live: true }
    let owned: Loaded | null = null
    setLoaded({ input, lease, value: null, error: null })
    const publish = (value: Loaded): void => {
      if (!lease.live) {
        value.dispose()
        return
      }
      owned = value
      setLoaded({ input, lease, value, error: null })
    }
    const fail = (cause: unknown): void => {
      if (!lease.live) return
      const error = cause instanceof Error ? cause : new Error(String(cause))
      setLoaded({ input, lease, value: null, error })
    }
    void load(input, controller.signal).then(publish, fail)
    return () => {
      lease.live = false
      controller.abort()
      owned?.dispose()
    }
  }, [input, load])

  if (typeof input !== 'string') {
    return { value: input ?? null, state: { status: 'ready', error: null } }
  }
  if (loaded?.input !== input || loaded?.lease.live !== true) {
    return { value: null, state: { status: 'loading', error: null } }
  }
  if (loaded?.error != null) {
    return { value: null, state: { status: 'error', error: loaded.error } }
  }
  const value = loaded?.value ?? null
  return {
    value,
    state: { status: value == null ? 'loading' : 'ready', error: null }
  }
}

const loadWeather = (url: string, signal: AbortSignal) =>
  loadCloudTexture('localWeather', url, { signal })
const loadTurbulence = (url: string, signal: AbortSignal) =>
  loadCloudTexture('turbulence', url, { signal })
const loadShape = (url: string, signal: AbortSignal) =>
  loadCloudVolume(
    'shape',
    url,
    [
      CLOUD_SHAPE_TEXTURE_SIZE,
      CLOUD_SHAPE_TEXTURE_SIZE,
      CLOUD_SHAPE_TEXTURE_SIZE
    ],
    undefined,
    { signal }
  )
const loadDetail = (url: string, signal: AbortSignal) =>
  loadCloudVolume(
    'shapeDetail',
    url,
    [
      CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
      CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
      CLOUD_SHAPE_DETAIL_TEXTURE_SIZE
    ],
    undefined,
    { signal }
  )
const loadSTBN = (url: string, signal: AbortSignal) =>
  loadCloudVolume(
    'stbn',
    url,
    [STBN_TEXTURE_WIDTH, STBN_TEXTURE_HEIGHT, STBN_TEXTURE_DEPTH],
    NearestFilter,
    { signal }
  )

function assetState(
  results: readonly AssetResult<unknown>[]
): CloudsAssetState {
  const failure = results.find(result => result.state.status === 'error')
  if (failure != null) return failure.state
  return {
    status: results.every(result => result.state.status === 'ready')
      ? 'ready'
      : 'loading',
    error: null
  }
}

function syncStbnTexture(
  context: CloudsContext,
  input: CloudsProps['stbnTexture'],
  value: Data3DTexture | null,
  previous: { current: CloudsProps['stbnTexture'] }
): void {
  if (input !== undefined || previous.current !== undefined) {
    context.stbnTexture = value
  }
  previous.current = input
}

// The scalar context properties this component forwards, listed explicitly:
// the context also carries derived and readonly state, and a blanket assign
// would let a typo land silently
const SCALAR_KEYS = [
  'coverage',
  'scatteringCoefficient',
  'absorptionCoefficient',
  'turbulenceDisplacement',
  'skyLightScale',
  'groundBounceScale',
  'powderScale',
  'powderExponent',
  'scatterAnisotropyMix',
  'resolutionScale',
  'sunAngularRadius',
  'bottomRadius',
  'correctAltitude',
  'cameraHeight',
  'time',
  'frame',
  'enabled',
  'warnings'
] as const satisfies ReadonlyArray<keyof CloudsContext>

type ScalarProps = Partial<Pick<CloudsContext, (typeof SCALAR_KEYS)[number]>>

/**
 * Declarative context inputs, with the same units and graph effects as the context
 * A preset applies before explicit scalar overrides on each React render
 * Omitted scalar props preserve current values, time and frame never auto-advance
 */
export interface CloudsProps extends ScalarProps {
  /** The mounted pass, cleared on unmount, never independently disposed */
  ref?: Ref<CloudsPassNode>

  /**
   * Required depth policy: a scene depth node, or explicit null for sky-only
   * Keep node identity stable between intentional replacements
   * Replacing node identity keeps the pass but rebuilds its graph and history
   */
  sceneDepth: TextureNode | null

  /** Debug output selection, omitted preserves the current selection */
  debug?: DebugView
  /** Default false, true leaves undeclared layer slots empty */
  disableDefaultLayers?: boolean

  /** A validated partial patch, absent experiment keys keep their current values */
  experimental?: Partial<ExperimentalCloudOptions>

  /** Reapplied before scalar props, so explicit resolutionScale wins */
  qualityPreset?: QualityPreset

  /** Normalized ECEF direction copied into the context, no automatic sun clock */
  sunDirection?: Vector3
  /** World metres to ECEF metres, copied rather than retaining this matrix */
  worldToECEFMatrix?: Matrix4

  /** Borrow an object or load an owned URL texture, defaults to the baked URL */
  localWeatherTexture?: Texture | ProceduralTextureLike | string
  /** Borrow a volume/generator or load its raw bytes, defaults to the baked URL */
  shapeTexture?:
    Data3DTexture | ProceduralTextureLike<Storage3DTexture> | string
  /** Borrow a detail volume/generator or load bytes, defaults to the baked URL */
  shapeDetailTexture?:
    Data3DTexture | ProceduralTextureLike<Storage3DTexture> | string
  /** Borrow an object or load an owned URL texture, defaults to the baked URL */
  turbulenceTexture?: Texture | ProceduralTextureLike | string
  /** Borrow a volume or load a URL, omission generates owned jitter without fetch */
  stbnTexture?: Data3DTexture | string

  /** CloudLayer declarations and consumers of useClouds */
  children?: ReactNode
}

/**
 * Own a pass and asset-loading lifecycle, not a complete render pipeline
 * Requires: a Fiber canvas with native WebGPU, app-owned composition and providers
 * Ownership: URL textures are disposed on replacement or unmount
 * The owned pass, context and generated default jitter are disposed on unmount
 * Passed texture and generator objects remain borrowed and are never disposed
 * Loading or failed assets gate rendering without changing context.enabled
 */
export const Clouds: FC<CloudsProps> = props => {
  const [pass, setPass] = useState<CloudsPassNode | null>(null)
  useLayoutEffect(() => {
    const ownedPass = createCloudsPass({ sceneDepth: null })
    setPass(ownedPass)
    return () => {
      const context = ownedPass.cloudsContext
      context.localWeatherTexture = null
      context.shapeTexture = null
      context.shapeDetailTexture = null
      context.turbulenceTexture = null
      context.stbnTexture = null
      ownedPass.dispose()
      context.dispose()
    }
  }, [])
  return pass == null ? null : <CloudsInstance {...props} pass={pass} />
}

const CloudsInstance: FC<CloudsProps & { pass: CloudsPassNode }> = ({
  pass,
  ref: forwardedRef,
  sceneDepth,
  debug,
  disableDefaultLayers = false,
  experimental,
  qualityPreset,
  sunDirection,
  worldToECEFMatrix,
  localWeatherTexture: localWeatherTextureProp = DEFAULT_LOCAL_WEATHER_URL,
  shapeTexture: shapeTextureProp = DEFAULT_SHAPE_URL,
  shapeDetailTexture: shapeDetailTextureProp = DEFAULT_SHAPE_DETAIL_URL,
  turbulenceTexture: turbulenceTextureProp = DEFAULT_TURBULENCE_URL,
  stbnTexture: stbnTextureProp,
  children,
  ...scalars
}) => {
  const context = pass.cloudsContext
  const previousStbnInput = useRef(stbnTextureProp)

  const camera = useThree(state => state.camera)
  pass.camera = camera
  pass.sceneDepth = sceneDepth

  const weather = useAsset(localWeatherTextureProp, loadWeather)
  const shape = useAsset(shapeTextureProp, loadShape)
  const detail = useAsset(shapeDetailTextureProp, loadDetail)
  const turbulence = useAsset(turbulenceTextureProp, loadTurbulence)
  const stbn = useAsset(stbnTextureProp, loadSTBN)
  const assets = assetState([weather, shape, detail, turbulence, stbn])

  // Applied during render so a prop change reaches the next frame, as in
  // <CloudLayer>

  // The preset first, so the explicit scalar props below override it. Both
  // reach the same fields (resolutionScale is in both), and last write wins
  if (qualityPreset !== undefined) {
    context.qualityPreset = qualityPreset
  }

  // The context setter validates the keys and the boolean-ness, and bumps
  // graphVersion only on a real change, so a re-render with an equal object is
  // free
  if (experimental !== undefined) {
    context.experimental = experimental
  }

  // `time` and `frame` are plain props (ADR-003): any pair renders the same
  // pixels. Advancing them from useFrame would bring back the accumulator and
  // break seeking, so a consumer sets both from its own clock
  for (const key of SCALAR_KEYS) {
    const value = scalars[key]
    if (value !== undefined) {
      // Each key is its own property type, the lookup is homogeneous only from
      // the outside
      ;(context as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (debug !== undefined) {
    context.debug = debug
  }
  if (sunDirection != null) {
    context.sunDirection.copy(sunDirection)
  }
  if (worldToECEFMatrix != null) {
    context.worldToECEFMatrix.copy(worldToECEFMatrix)
  }

  context.localWeatherTexture = weather.value
  context.shapeTexture = shape.value
  context.shapeDetailTexture = detail.value
  context.turbulenceTexture = turbulence.value
  syncStbnTexture(context, stbnTextureProp, stbn.value, previousStbnInput)
  pass.setAssetsReady(assets.status === 'ready')

  useImperativeHandle(forwardedRef, () => pass, [pass])

  const value = useMemo(
    () => ({ pass, context, assets }),
    [pass, context, assets.status, assets.error]
  )

  return (
    <CloudsPassContext.Provider value={value}>
      <CloudLayers
        layers={context.cloudLayers}
        disableDefault={disableDefaultLayers}
      >
        {children}
      </CloudLayers>
    </CloudsPassContext.Provider>
  )
}
