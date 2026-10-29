// Showcase application for three-clouds-webgpu pairing volumetric clouds,
// atmosphere, and three-ocean-waves with a preset selector, day timeline,
// and free-flight camera

import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC
} from 'react'
import {
  Color,
  DefaultLoadingManager,
  Matrix4,
  NoToneMapping,
  Quaternion,
  Vector3
} from 'three'
import {
  applyScenePreset,
  isScenePresetName,
  resolveTimeOfDay,
  scenePresetNames,
  scenePresets,
  syncCelestialDirections,
  type CloudsContext,
  type QualityPreset,
  type ScenePresetName
} from 'three-clouds-webgpu'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import { WebGPURenderer, type Node as ThreeNode } from 'three/webgpu'

import {
  DEFAULT_STARS_DATA_URL,
  getECIToECEFRotationMatrix
} from '@takram/three-atmosphere'
import {
  DEFAULT_STBN_URL,
  Geodetic,
  PointOfView,
  radians
} from '@takram/three-geospatial'
import { highpVelocity } from '@takram/three-geospatial/webgpu'

import { createAtmosphereContext } from './atmosphereContext'
import { CloudsPostProcessing, type FrameStats } from './CloudsPostProcessing'
import { FlyControls } from './FlyControls'
import { FlyEntry } from './FlyEntry'
import {
  GROUND_LOCATIONS,
  groundLabel,
  groundMRT,
  GroundTiles,
  hasIonToken,
  hasOcean,
  resolveGround,
  useGroundCamera,
  type GroundLocationKey,
  type GroundState,
  type GroundValue,
  type PointOfViewProps
} from './ground'
import { GroundOcean } from './oceanGround'
import {
  useBakedCloudTextures,
  useJitterTexture
} from './useBakedCloudTextures'

// Redirect atmosphere internal asset loads to local public/assets files
DefaultLoadingManager.setURLModifier(url => {
  if (url === DEFAULT_STBN_URL) return 'assets/atmosphere-jitter.bin'
  if (url === DEFAULT_STARS_DATA_URL) return 'assets/stars.bin'
  return url
})

const BASE_DATE = new Date('2026-05-21T12:00:00Z')

// Opening camera pose: low altitude (~7 m) looking slightly up (+9 degrees)
// toward the WNW sunset horizon (heading 140) across 3D ocean waves and rolling cloud bases
export const OCEAN_OPENING_POV: PointOfViewProps = {
  longitude: 30,
  latitude: 33,
  height: 10,
  heading: 140,
  pitch: 9,
  distance: 20
}

export const PRESET_LABELS: Record<ScenePresetName, string> = {
  partlyCloudy: 'Partly Cloudy',
  fluffy: 'Fluffy Cumulus',
  pixar: 'Pixar Sky',
  stunningSunset: 'Stunning Sunset',
  moonlitNight: 'Moonlit Night',
  hazy: 'Hazy Midday',
  thunderstorm: 'Thunderstorm',
  stormyEvening: 'Stormy Evening'
}

export const QUALITY_OPTIONS: readonly QualityPreset[] = [
  'low',
  'medium',
  'high',
  'ultra',
  'lowEnd'
]

export const SPEED_OPTIONS = [
  { value: 60, label: '60s / day' },
  { value: 180, label: '180s / day' },
  { value: 600, label: '600s / day' },
  { value: 1800, label: '1800s / day' }
] as const

const DEFAULT_EXPOSURE = 10

function wrapTimeOfDay(value: number): number {
  const wrapped = ((value % 1) + 1) % 1
  return wrapped >= 0.999999 ? 0 : wrapped
}

function formatSolarClock(timeOfDay: number): string {
  const totalMinutes = Math.floor(wrapTimeOfDay(timeOfDay) * 24 * 60)
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function solarPhaseLabel(timeOfDay: number): string {
  const t = wrapTimeOfDay(timeOfDay)
  if (t < 0.21 || t >= 0.84) return 'Night'
  if (t < 0.28) return 'Dawn'
  if (t < 0.45) return 'Morning'
  if (t < 0.57) return 'Midday'
  if (t < 0.72) return 'Afternoon'
  if (t < 0.775) return 'Golden Hour'
  return 'Dusk'
}

export interface CameraPoseRequest {
  altitude: number
  pitch: number
  heading?: number
  x?: number
  z?: number
}

export interface DemoHandle {
  getState: () => {
    preset: ScenePresetName
    quality: QualityPreset
    exposure: number
    coverage: number
    ground: GroundValue
    flyMode: boolean
    timeOfDay: number
    playing: boolean
    secondsPerDay: number
    frame: number
    fps: number
    frameMs: number
    oceanReady: boolean
    texturesReady: boolean
    altitudeMeters: number
    cameraDirectionY: number
  }
  setPreset: (preset: ScenePresetName) => void
  setQuality: (quality: QualityPreset) => void
  setExposure: (exposure: number) => void
  setCoverage: (coverage: number) => void
  setGround: (ground: GroundValue) => void
  setFlyMode: (enabled: boolean) => void
  setTimeOfDay: (timeOfDay: number) => void
  setPlaying: (playing: boolean) => void
  setSecondsPerDay: (seconds: number) => void
  setCameraPose: (pose: CameraPoseRequest) => void
  resetOpeningCamera: () => void
}

declare global {
  interface Window {
    __demo?: DemoHandle
  }
}

const atmosphereContext = createAtmosphereContext()
const cloudsHolder: { current: CloudsContext | null } = { current: null }

const scratchMat = /*#__PURE__*/ new Matrix4()
const scratchQuat = /*#__PURE__*/ new Quaternion()

interface SceneControllerProps {
  ground: GroundState
  preset: ScenePresetName
  quality: QualityPreset
  coverage: number
  timeOfDay: number
  playing: boolean
  secondsPerDay: number
  onAdvanceTime: (deltaDays: number, deltaSeconds: number) => void
  poseSetterRef: { current: ((pose: CameraPoseRequest) => void) | null }
  resetCameraRef: { current: (() => void) | null }
}

const SceneController: FC<SceneControllerProps> = ({
  ground,
  preset,
  quality,
  coverage,
  timeOfDay,
  playing,
  secondsPerDay,
  onAdvanceTime,
  poseSetterRef,
  resetCameraRef
}) => {
  const { context: cloudsContext } = useClouds()
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(
    state => state.controls as { target?: Vector3; update?: () => void } | null
  )

  useLayoutEffect(() => {
    cloudsHolder.current = cloudsContext
    return () => {
      cloudsHolder.current = null
    }
  }, [cloudsContext])

  // Dev-only handle so a capture script can A/B context knobs at one pose
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __demoClouds?: unknown }
    w.__demoClouds = { context: cloudsContext, camera, atmosphereContext }
    return () => {
      delete w.__demoClouds
    }
  }, [cloudsContext, camera])

  useLayoutEffect(() => {
    cloudsContext.qualityPreset = quality
    cloudsContext.lightShaftsHalfResolution = false
    cloudsContext.shadow.maxFar = 1e5
    // March tuning to eliminate grazing horizon step banding and Mie forward blowout
    cloudsContext.clouds.perspectiveStepScale = 1.0005
    cloudsContext.clouds.minStepSize = 35
    cloudsContext.clouds.maxStepSize = 350
    cloudsContext.clouds.minShadowLengthStepSize = 65
    cloudsContext.clouds.maxShadowLengthRayDistance = 32500
    cloudsContext.clouds.hazeDensityScale = 7e-6
  }, [cloudsContext, quality])

  const appliedPresetRef = useRef<ScenePresetName | null>(null)
  const location = useMemo(
    () => ({
      longitude: ground.pov.longitude,
      latitude: ground.pov.latitude
    }),
    [ground.pov.longitude, ground.pov.latitude]
  )

  // Apply preset cloud layers and experimental flags whenever the preset or
  // ground surface changes
  useLayoutEffect(() => {
    const safeTime = wrapTimeOfDay(timeOfDay)
    const sinks = [
      {
        sunDirection: atmosphereContext.sunDirectionECEF,
        moonDirection: atmosphereContext.moonDirectionECEF
      },
      {
        sunDirection: cloudsContext.sunDirection,
        moonDirection: cloudsContext.moonDirection
      }
    ]
    applyScenePreset(cloudsContext, preset, {
      date: BASE_DATE,
      location,
      timeOfDay: safeTime,
      sinks
    })

    cloudsContext.experimental = {
      ...cloudsContext.experimental,
      cloudEnvironment: ground.ocean
    }
    cloudsContext.shadow.maxFar = 1e5
    appliedPresetRef.current = preset
  }, [cloudsContext, preset, location, ground.ocean])

  // Sync coverage slider and celestial vectors on every time-of-day or
  // coverage update without resetting the user's coverage adjustment
  useLayoutEffect(() => {
    cloudsContext.coverage = coverage
  }, [cloudsContext, coverage])

  useLayoutEffect(() => {
    const safeTime = wrapTimeOfDay(timeOfDay)
    const when = resolveTimeOfDay(BASE_DATE, safeTime, location)
    syncCelestialDirections(
      [
        {
          sunDirection: atmosphereContext.sunDirectionECEF,
          moonDirection: atmosphereContext.moonDirectionECEF
        },
        {
          sunDirection: cloudsContext.sunDirection,
          moonDirection: cloudsContext.moonDirection
        }
      ],
      {
        date: BASE_DATE,
        location,
        timeOfDay: safeTime
      }
    )
    getECIToECEFRotationMatrix(when, atmosphereContext.matrixECIToECEF.value)
  }, [timeOfDay, location])

  useLayoutEffect(() => {
    cloudsContext.localWeatherVelocity.set(playing ? 0.001 : 0, 0)
  }, [cloudsContext, playing])

  useEffect(() => {
    poseSetterRef.current = ({
      altitude,
      pitch,
      heading = ground.pov.heading,
      x = 0,
      z = 0
    }: CameraPoseRequest) => {
      const worldToECEF = atmosphereContext.matrixWorldToECEF.value
      const targetECEF = new Geodetic(
        radians(ground.pov.longitude),
        radians(ground.pov.latitude),
        altitude
      ).toECEF()
      const pov = new PointOfView(10, radians(heading), radians(pitch))
      pov.decompose(targetECEF, camera.position, camera.quaternion, camera.up)

      if (ground.ocean) {
        const inverse = scratchMat.copy(worldToECEF).invert()
        scratchQuat.setFromRotationMatrix(inverse)
        camera.position.set(x, altitude, z)
        camera.quaternion.premultiply(scratchQuat)
        camera.up.applyQuaternion(scratchQuat)
      }
      camera.updateMatrixWorld()
      if (controls?.target != null) {
        const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
        controls.target.copy(camera.position).addScaledVector(forward, 50)
        controls.update?.()
      }
      cloudsContext.resetHistory()
    }

    resetCameraRef.current = () => {
      const worldToECEF = atmosphereContext.matrixWorldToECEF.value
      const {
        longitude,
        latitude,
        height = 0,
        heading,
        pitch,
        distance
      } = ground.pov
      const targetECEF = new Geodetic(
        radians(longitude),
        radians(latitude),
        height
      ).toECEF()
      const pov = new PointOfView(distance, radians(heading), radians(pitch))
      pov.decompose(targetECEF, camera.position, camera.quaternion, camera.up)
      const inverse = scratchMat.copy(worldToECEF).invert()
      scratchQuat.setFromRotationMatrix(inverse)
      camera.position.applyMatrix4(inverse)
      camera.quaternion.premultiply(scratchQuat)
      camera.up.applyQuaternion(scratchQuat)
      camera.updateMatrixWorld()
      if (controls?.target != null) {
        controls.target.copy(targetECEF.applyMatrix4(inverse))
        controls.update?.()
      }
      cloudsContext.resetHistory()
    }

    return () => {
      poseSetterRef.current = null
      resetCameraRef.current = null
    }
  }, [camera, controls, cloudsContext, ground, poseSetterRef, resetCameraRef])

  useFrame((_, delta) => {
    if (!playing) return
    const clamped = Math.min(delta, 0.1)
    const deltaDays = clamped / Math.max(10, secondsPerDay)
    onAdvanceTime(deltaDays, clamped)
  })

  return null
}

interface DemoSceneProps {
  ground: GroundState
  preset: ScenePresetName
  quality: QualityPreset
  exposure: number
  coverage: number
  flyMode: boolean
  timeOfDay: number
  playing: boolean
  secondsPerDay: number
  weatherTime: number
  onAdvanceTime: (deltaDays: number, deltaSeconds: number) => void
  onFrameStats: (stats: FrameStats) => void
  onOceanReady: (ready: boolean) => void
  onTexturesReady: (ready: boolean) => void
  onAltitudeChange: (alt: number, dirY: number) => void
  poseSetterRef: { current: ((pose: CameraPoseRequest) => void) | null }
  resetCameraRef: { current: (() => void) | null }
}

const DemoScene: FC<DemoSceneProps> = ({
  ground,
  preset,
  quality,
  exposure,
  coverage,
  flyMode,
  timeOfDay,
  playing,
  secondsPerDay,
  weatherTime,
  onAdvanceTime,
  onFrameStats,
  onOceanReady,
  onTexturesReady,
  onAltitudeChange,
  poseSetterRef,
  resetCameraRef
}) => {
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  atmosphereContext.camera = camera

  useEffect(() => {
    scene.background = new Color(0x000000)
  }, [scene])

  const scenePass = useMemo(() => {
    const p = pass(scene, camera, { samples: 0 })
    p.setMRT(
      mrt({
        output,
        normal: normalView,
        velocity: highpVelocity as unknown as ThreeNode,
        ...groundMRT(ground.ocean)
      })
    )
    return p
  }, [scene, camera, ground.ocean])

  useEffect(() => () => scenePass.dispose(), [scenePass])

  const jitterTexture = useJitterTexture()
  const textures = useBakedCloudTextures()

  useEffect(() => {
    onTexturesReady(textures != null)
  }, [textures, onTexturesReady])

  const target = useGroundCamera(
    ground,
    atmosphereContext.matrixWorldToECEF.value
  )

  if (textures == null) return null

  return (
    <>
      <GroundTiles ground={ground} />
      <OrbitControls
        makeDefault
        target={target}
        minDistance={10}
        maxDistance={150000}
        enableDamping
        dampingFactor={0.08}
      />
      <FlyControls
        key={ground.value}
        enabled={flyMode}
        worldToECEF={atmosphereContext.matrixWorldToECEF.value}
        onAltitudeChange={onAltitudeChange}
      />
      <Clouds
        sceneDepth={scenePass.getTextureNode('depth')}
        localWeatherTexture={textures.localWeatherTexture}
        shapeTexture={textures.shapeTexture}
        shapeDetailTexture={textures.shapeDetailTexture}
        turbulenceTexture={textures.turbulenceTexture}
        stbnTexture={jitterTexture}
      >
        <FlyEntry
          enabled={flyMode}
          worldToECEF={atmosphereContext.matrixWorldToECEF.value}
        />
        <SceneController
          ground={ground}
          preset={preset}
          quality={quality}
          coverage={coverage}
          timeOfDay={timeOfDay}
          playing={playing}
          secondsPerDay={secondsPerDay}
          onAdvanceTime={onAdvanceTime}
          poseSetterRef={poseSetterRef}
          resetCameraRef={resetCameraRef}
        />
        {ground.ocean && <GroundOcean onReady={onOceanReady} />}
        <CloudsPostProcessing
          albedoScale={ground.albedoScale}
          lightingMask={ground.ocean}
          scenePass={scenePass}
          atmosphereContext={atmosphereContext}
          nightSky
          exposure={exposure}
          weatherTime={weatherTime}
          onFrameStats={onFrameStats}
        />
      </Clouds>
    </>
  )
}

function initialPresetFromUrl(): ScenePresetName {
  if (typeof window === 'undefined') return 'stunningSunset'
  const param = new URLSearchParams(window.location.search).get('preset')
  return isScenePresetName(param) ? param : 'stunningSunset'
}

export const App: FC = () => {
  const [preset, setPresetState] =
    useState<ScenePresetName>(initialPresetFromUrl)
  const [quality, setQuality] = useState<QualityPreset>('high')
  const [exposure, setExposure] = useState<number>(DEFAULT_EXPOSURE)
  const [coverage, setCoverage] = useState<number>(
    () => scenePresets[initialPresetFromUrl()].coverage
  )
  const [groundValue, setGroundValue] = useState<GroundValue>(
    hasOcean ? 'ocean' : 'bare'
  )
  const [flyMode, setFlyMode] = useState<boolean>(false)
  const [collapsed, setCollapsed] = useState<boolean>(false)

  const [timeOfDay, setTimeOfDayState] = useState<number>(
    () => scenePresets[initialPresetFromUrl()].timeOfDay
  )
  const [playing, setPlaying] = useState<boolean>(false)
  const [secondsPerDay, setSecondsPerDay] = useState<number>(600)
  const [weatherElapsed, setWeatherElapsed] = useState<number>(0)

  const [frameStats, setFrameStats] = useState<FrameStats>({
    fps: 60,
    frameMs: 16.7,
    frame: 0
  })
  const [oceanReady, setOceanReady] = useState<boolean>(false)
  const [texturesReady, setTexturesReady] = useState<boolean>(false)
  const [altitudeMeters, setAltitudeMeters] = useState<number>(7)
  const [cameraDirectionY, setCameraDirectionY] = useState<number>(0.16)

  const handleAltitudeChange = useCallback((alt: number, dirY: number) => {
    setAltitudeMeters(alt)
    setCameraDirectionY(dirY)
  }, [])

  const poseSetterRef = useRef<((pose: CameraPoseRequest) => void) | null>(null)
  const resetCameraRef = useRef<(() => void) | null>(null)

  const ground = useMemo(
    () => resolveGround(groundValue, OCEAN_OPENING_POV),
    [groundValue]
  )

  const selectPreset = useCallback((next: ScenePresetName) => {
    setPresetState(next)
    setCoverage(scenePresets[next].coverage)
    setTimeOfDayState(scenePresets[next].timeOfDay)
    setWeatherElapsed(0)
  }, [])

  const setTimeOfDay = useCallback(
    (next: number) => {
      const wrapped = wrapTimeOfDay(next)
      setTimeOfDayState(wrapped)
      // Couple manual timeline scrubbing to evolvingWeather so scrubbing
      // visibly evolves the cloud field alongside the sun and sky
      const baseTime = scenePresets[preset].timeOfDay
      setWeatherElapsed((wrapped - baseTime) * 180)
    },
    [preset]
  )

  const handleAdvanceTime = useCallback(
    (deltaDays: number, deltaSeconds: number) => {
      setTimeOfDayState(prev => wrapTimeOfDay(prev + deltaDays))
      setWeatherElapsed(prev => prev + deltaSeconds)
    },
    []
  )

  useEffect(() => {
    const handle: DemoHandle = {
      getState: () => ({
        preset,
        quality,
        exposure,
        coverage,
        ground: ground.value,
        flyMode,
        timeOfDay,
        playing,
        secondsPerDay,
        frame: frameStats.frame,
        fps: frameStats.fps,
        frameMs: frameStats.frameMs,
        oceanReady: ground.ocean ? oceanReady : true,
        texturesReady,
        altitudeMeters,
        cameraDirectionY
      }),
      setPreset: selectPreset,
      setQuality,
      setExposure,
      setCoverage,
      setGround: setGroundValue,
      setFlyMode,
      setTimeOfDay,
      setPlaying,
      setSecondsPerDay,
      setCameraPose: pose => {
        poseSetterRef.current?.(pose)
      },
      resetOpeningCamera: () => {
        resetCameraRef.current?.()
      }
    }
    window.__demo = handle
    return () => {
      delete window.__demo
    }
  }, [
    preset,
    quality,
    exposure,
    coverage,
    ground,
    flyMode,
    timeOfDay,
    playing,
    secondsPerDay,
    frameStats,
    oceanReady,
    texturesReady,
    altitudeMeters,
    cameraDirectionY,
    selectPreset,
    setTimeOfDay
  ])

  const exposurePercent = ((exposure - 2) / (25 - 2)) * 100
  const coveragePercent = coverage * 100
  const exposureMultiplier = (exposure / DEFAULT_EXPOSURE).toFixed(2)

  return (
    <div className='demo-root'>
      <Canvas
        camera={{ fov: 55, near: 1, far: 4e5 }}
        gl={async props => {
          const renderer = new WebGPURenderer(props as never)
          renderer.highPrecision = true
          renderer.toneMapping = NoToneMapping
          renderer.contextNode = context({
            getAtmosphere: () => atmosphereContext,
            getClouds: () => {
              if (cloudsHolder.current == null) {
                throw new Error(
                  'demo: clouds context requested before <Clouds> mounted'
                )
              }
              return cloudsHolder.current
            }
          })
          await renderer.init()
          return renderer
        }}
      >
        <DemoScene
          ground={ground}
          preset={preset}
          quality={quality}
          exposure={exposure}
          coverage={coverage}
          flyMode={flyMode}
          timeOfDay={timeOfDay}
          playing={playing}
          secondsPerDay={secondsPerDay}
          weatherTime={weatherElapsed}
          onAdvanceTime={handleAdvanceTime}
          onFrameStats={setFrameStats}
          onOceanReady={setOceanReady}
          onTexturesReady={setTexturesReady}
          onAltitudeChange={handleAltitudeChange}
          poseSetterRef={poseSetterRef}
          resetCameraRef={resetCameraRef}
        />
      </Canvas>

      <header className='demo-brand'>
        <div className='demo-brand-row'>
          <span className='demo-brand-title'>three-clouds-webgpu</span>
          <span className='demo-brand-badge'>WebGPU · TSL</span>
        </div>
        <div className='demo-brand-meta'>
          <span className='demo-brand-dot' />
          <span data-testid='fps-readout'>
            {frameStats.fps} FPS · {frameStats.frameMs.toFixed(1)} ms
          </span>
          <span>·</span>
          <span>{PRESET_LABELS[preset]}</span>
        </div>
      </header>

      <aside
        className={`demo-panel ${collapsed ? 'is-collapsed' : ''}`}
        aria-label='Scene Controls'
      >
        <button
          type='button'
          className='demo-panel-header'
          onClick={() => setCollapsed(prev => !prev)}
          aria-expanded={!collapsed}
          data-testid='panel-toggle'
        >
          <span className='demo-panel-header-title'>Controls</span>
          <span className='demo-panel-chevron'>▼</span>
        </button>

        {!collapsed && (
          <div className='demo-panel-body'>
            <div className='demo-field'>
              <div className='demo-field-header'>
                <label htmlFor='demo-preset-select'>Preset</label>
                <span className='demo-field-value'>{preset}</span>
              </div>
              <select
                id='demo-preset-select'
                className='demo-select'
                value={preset}
                onChange={e => selectPreset(e.target.value as ScenePresetName)}
                data-testid='preset-select'
              >
                {scenePresetNames.map(name => (
                  <option key={name} value={name}>
                    {PRESET_LABELS[name]}
                  </option>
                ))}
              </select>
            </div>

            <div className='demo-field'>
              <div className='demo-field-header'>
                <span>Quality</span>
                <span className='demo-field-value'>{quality}</span>
              </div>
              <div
                className='demo-segmented'
                role='group'
                aria-label='Cloud quality preset'
                data-testid='quality-select'
              >
                {QUALITY_OPTIONS.map(q => (
                  <button
                    key={q}
                    type='button'
                    className={`demo-segment-btn ${quality === q ? 'is-active' : ''}`}
                    onClick={() => setQuality(q)}
                    data-testid={`quality-${q}`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            <div className='demo-field'>
              <div className='demo-field-header'>
                <label htmlFor='demo-exposure-slider'>Exposure</label>
                <span className='demo-field-value' data-testid='exposure-value'>
                  {exposureMultiplier}× ({exposure.toFixed(1)})
                </span>
              </div>
              <input
                id='demo-exposure-slider'
                type='range'
                className='demo-slider'
                min={2}
                max={25}
                step={0.25}
                value={exposure}
                style={
                  {
                    '--progress': `${exposurePercent}%`
                  } as CSSProperties
                }
                onChange={e => setExposure(Number(e.target.value))}
                data-testid='exposure-slider'
              />
            </div>

            <div className='demo-field'>
              <div className='demo-field-header'>
                <label htmlFor='demo-coverage-slider'>Cloud coverage</label>
                <span className='demo-field-value' data-testid='coverage-value'>
                  {Math.round(coveragePercent)}%
                </span>
              </div>
              <input
                id='demo-coverage-slider'
                type='range'
                className='demo-slider'
                min={0}
                max={1}
                step={0.01}
                value={coverage}
                style={
                  {
                    '--progress': `${coveragePercent}%`
                  } as CSSProperties
                }
                onChange={e => setCoverage(Number(e.target.value))}
                data-testid='coverage-slider'
              />
            </div>

            <div className='demo-field'>
              <div className='demo-field-header'>
                <label htmlFor='demo-ground-select'>Ground</label>
                <span className='demo-field-value'>{groundLabel(ground)}</span>
              </div>
              <select
                id='demo-ground-select'
                className='demo-select'
                value={ground.value}
                onChange={e => setGroundValue(e.target.value as GroundValue)}
                data-testid='ground-select'
              >
                <option value='bare'>Bare ground</option>
                {hasOcean && <option value='ocean'>Ocean</option>}
                {hasIonToken &&
                  (Object.keys(GROUND_LOCATIONS) as GroundLocationKey[]).map(
                    key => (
                      <option key={key} value={key}>
                        3D Tiles: {GROUND_LOCATIONS[key].title}
                      </option>
                    )
                  )}
              </select>
            </div>

            <div className='demo-field'>
              <div className='demo-field-header'>
                <span>Camera Mode</span>
                <span className='demo-field-value'>
                  {flyMode ? 'Fly' : 'Explore'}
                </span>
              </div>
              <div
                className='demo-segmented demo-segmented-2'
                role='group'
                aria-label='Camera mode'
              >
                <button
                  type='button'
                  className={`demo-segment-btn ${!flyMode ? 'is-active' : ''}`}
                  onClick={() => setFlyMode(false)}
                  data-testid='mode-explore'
                >
                  Explore
                </button>
                <button
                  type='button'
                  className={`demo-segment-btn ${flyMode ? 'is-active' : ''}`}
                  onClick={() => setFlyMode(true)}
                  data-testid='mode-fly'
                >
                  Fly
                </button>
              </div>
            </div>
          </div>
        )}
      </aside>

      {flyMode && (
        <div className='demo-fly-hint' data-testid='fly-hint'>
          <span className='demo-fly-badge'>FLY</span>
          <span className='demo-fly-key-group'>
            <kbd className='demo-kbd'>WASD</kbd> Move
          </span>
          <span className='demo-fly-key-group'>
            <kbd className='demo-kbd'>E</kbd>
            <kbd className='demo-kbd'>Space</kbd> Climb
          </span>
          <span className='demo-fly-key-group'>
            <kbd className='demo-kbd'>Q</kbd>
            <kbd className='demo-kbd'>C</kbd> Descend
          </span>
          <span className='demo-fly-key-group'>
            <kbd className='demo-kbd'>Shift</kbd> 5× Boost
          </span>
          <span className='demo-fly-key-group'>Drag to Look</span>
          <span className='demo-fly-alt' data-testid='fly-altitude'>
            ALT {Math.round(altitudeMeters).toLocaleString()} m
          </span>
        </div>
      )}

      <footer className='demo-timeline' aria-label='Solar Day Timeline'>
        <button
          type='button'
          className={`demo-play-btn ${playing ? 'is-playing' : ''}`}
          onClick={() => setPlaying(prev => !prev)}
          aria-label={playing ? 'Pause timeline' : 'Play timeline'}
          data-testid='timeline-play'
        >
          {playing ? '❚❚' : '▶'}
        </button>

        <div className='demo-time-readout'>
          <span className='demo-time-clock' data-testid='timeline-clock'>
            {formatSolarClock(timeOfDay)}
          </span>
          <span className='demo-time-phase' data-testid='timeline-phase'>
            {solarPhaseLabel(timeOfDay)}
          </span>
        </div>

        <div className='demo-scrubber-wrap'>
          <input
            type='range'
            className='demo-scrubber'
            min={0}
            max={0.999}
            step={0.001}
            value={wrapTimeOfDay(timeOfDay)}
            aria-label='Local solar time'
            onChange={e => setTimeOfDay(Number(e.target.value))}
            data-testid='timeline-scrubber'
          />
          <div className='demo-scrubber-ticks'>
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>24:00</span>
          </div>
        </div>

        <div className='demo-speed-box'>
          <label htmlFor='demo-speed-select' className='demo-speed-label'>
            Speed
          </label>
          <select
            id='demo-speed-select'
            className='demo-select demo-speed-select'
            value={secondsPerDay}
            onChange={e => setSecondsPerDay(Number(e.target.value))}
            data-testid='timeline-speed'
          >
            {SPEED_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </footer>
    </div>
  )
}
