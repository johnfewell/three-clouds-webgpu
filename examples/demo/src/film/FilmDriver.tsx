// Frame-locked shot driver. With the canvas on frameloop 'never', each output
// frame sets every channel from shot time, waits for 3D tiles to settle, then
// renders once inside a browser frame (three advances its node frame per rAF)

import { useThree } from '@react-three/fiber'
import { useEffect, type FC } from 'react'
import { Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three'
import {
  applyScenePreset,
  evolvingWeatherDefaults,
  resolveTimeOfDay,
  scenePresets,
  syncCelestialDirections
} from 'three-clouds-webgpu'
import { useClouds } from 'three-clouds-webgpu/r3f'

import { getECIToECEFRotationMatrix } from '@takram/three-atmosphere'
import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'

import { tilesHolder } from '../ground'
import { samplePath } from './path'
import type { FilmAnchor, FilmShot } from './shots'

export type FilmCapture = 'none' | 'png' | 'video'

export interface FilmVideoOptions {
  codec?: string
  bitrate?: number
}

export interface FilmHandle {
  id: string
  fps: number
  frameCount: number
  info: () => Record<string, unknown>
  prepare: (warmupFrames: number) => Promise<void>
  frame: (index: number, capture: FilmCapture) => Promise<string | null>
  startVideo: (options: FilmVideoOptions) => Promise<VideoEncoderConfig>
  finishVideo: () => Promise<void>
}

declare global {
  interface Window {
    __film?: FilmHandle
    __filmSink?: (base64: string, key: boolean, timestamp: number) => void
  }
}

export interface FilmRefs {
  weatherTime: { current: number }
  exposure: { current: number }
}

interface FilmDriverProps {
  shot: FilmShot
  fps: number
  baseDate: Date
  oceanAnchor: FilmAnchor
  atmosphereContext: AtmosphereContext
  refs: FilmRefs
}

const CLOCK_BASE = 1000
const TILE_TIMEOUT_MS = 60_000

function lerp(range: number | readonly [number, number], s: number): number {
  return typeof range === 'number'
    ? range
    : range[0] + (range[1] - range[0]) * s
}

function nextAnimationFrame(): Promise<number> {
  return new Promise(resolve => requestAnimationFrame(resolve))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

// Azimuth clockwise from north and elevation, in degrees, of an ECEF
// direction seen from the local north-up-east frame
function azimuthElevation(
  directionECEF: Vector3,
  localToECEF: Matrix4
): [number, number] {
  const rotation = new Quaternion().setFromRotationMatrix(localToECEF).invert()
  const local = directionECEF.clone().applyQuaternion(rotation)
  const azimuth = (Math.atan2(local.z, local.x) * 180) / Math.PI
  const elevation =
    (Math.asin(Math.max(-1, Math.min(1, local.y))) * 180) / Math.PI
  return [azimuth, elevation]
}

interface TileStats {
  queued: number
  downloading: number
  parsing: number
}

async function waitForTiles(
  camera: PerspectiveCamera,
  gl: unknown
): Promise<void> {
  const tiles = tilesHolder.current
  if (tiles == null) return
  // Untyped in 3d-tiles-renderer 0.4.28, present on TilesRendererBase
  const { stats } = tiles as unknown as { stats: TileStats }
  const started = performance.now()
  // The queue reads empty before the root tileset arrives, and a parsed tile
  // queues its children a moment later, so settle on a loaded root and
  // several idle polls in a row
  let idle = 0
  for (;;) {
    camera.updateMatrixWorld()
    tiles.setResolutionFromRenderer(camera, gl as never)
    tiles.update()
    const busy =
      tiles.root == null || stats.queued + stats.downloading + stats.parsing > 0
    idle = busy ? 0 : idle + 1
    if (idle >= 3) break
    if (performance.now() - started > TILE_TIMEOUT_MS) {
      console.warn('[film] tiles still loading after timeout', stats)
      break
    }
    await sleep(20)
  }
  tiles.update()
}

export const FilmDriver: FC<FilmDriverProps> = ({
  shot,
  fps,
  baseDate,
  oceanAnchor,
  atmosphereContext,
  refs
}) => {
  const { context: cloudsContext } = useClouds()
  const camera = useThree(({ camera }) => camera) as PerspectiveCamera
  const gl = useThree(({ gl }) => gl)
  const get = useThree(({ get }) => get)

  useEffect(() => {
    const anchor = shot.anchor ?? oceanAnchor
    const location = {
      longitude: anchor.longitude,
      latitude: anchor.latitude
    }
    const anchorECEF = new Geodetic(
      radians(anchor.longitude),
      radians(anchor.latitude),
      anchor.height
    ).toECEF()
    const localToECEF = Ellipsoid.WGS84.getNorthUpEastFrame(
      anchorECEF,
      new Matrix4()
    )
    const worldFromLocal = new Matrix4()
    const worldFromLocalRotation = new Quaternion()
    const frameCount = Math.round(shot.duration * fps)
    let frameAzimuth = 0
    let encoder: VideoEncoder | null = null
    let encoderError: Error | null = null

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

    const applyTimeOfDay = (timeOfDay: number): void => {
      const request = { date: baseDate, location, timeOfDay }
      syncCelestialDirections(sinks, request)
      getECIToECEFRotationMatrix(
        resolveTimeOfDay(baseDate, timeOfDay, location),
        atmosphereContext.matrixECIToECEF.value
      )
    }

    const celestial = (): Record<string, number> => {
      const [sunAzimuth, sunElevation] = azimuthElevation(
        cloudsContext.sunDirection,
        localToECEF
      )
      const [moonAzimuth, moonElevation] = azimuthElevation(
        cloudsContext.moonDirection,
        localToECEF
      )
      return { sunAzimuth, sunElevation, moonAzimuth, moonElevation }
    }

    const forward = new Vector3()
    const right = new Vector3()
    const position = new Vector3()
    const direction = new Vector3()
    const lookMatrix = new Matrix4()
    const rollQuat = new Quaternion()
    const zAxis = new Vector3(0, 0, 1)
    const up = new Vector3(0, 1, 0)
    const origin = new Vector3()

    const applyFrame = (t: number): void => {
      const s = shot.duration > 0 ? Math.max(0, t) / shot.duration : 0
      if (Array.isArray(shot.timeOfDay)) {
        applyTimeOfDay(lerp(shot.timeOfDay as [number, number], s))
      }
      if (shot.exposure != null) refs.exposure.current = lerp(shot.exposure, s)
      refs.weatherTime.current = t * (shot.cloudTimeScale ?? 1)

      const pose = samplePath(shot.path, t, shot.pathOptions)
      const az = radians(frameAzimuth)
      forward.set(Math.cos(az), 0, Math.sin(az))
      right.set(-Math.sin(az), 0, Math.cos(az))
      position
        .copy(forward)
        .multiplyScalar(pose.p[0])
        .addScaledVector(up, pose.p[1])
        .addScaledVector(right, pose.p[2])

      const heading = radians(frameAzimuth + pose.heading)
      const pitch = radians(pose.pitch)
      direction.set(
        Math.cos(pitch) * Math.cos(heading),
        Math.sin(pitch),
        Math.cos(pitch) * Math.sin(heading)
      )
      lookMatrix.lookAt(origin, direction, up)
      camera.quaternion.setFromRotationMatrix(lookMatrix)
      rollQuat.setFromAxisAngle(zAxis, radians(pose.roll))
      camera.quaternion.multiply(rollQuat)

      worldFromLocal
        .copy(atmosphereContext.matrixWorldToECEF.value)
        .invert()
        .multiply(localToECEF)
      worldFromLocalRotation.setFromRotationMatrix(worldFromLocal)
      camera.position.copy(position).applyMatrix4(worldFromLocal)
      camera.quaternion.premultiply(worldFromLocalRotation)
      camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
      if (camera.fov !== pose.fov) {
        camera.fov = pose.fov
        camera.updateProjectionMatrix()
      }
      camera.updateMatrixWorld()
    }

    const renderAt = async (
      t: number,
      capture: FilmCapture,
      timestampUs: number
    ): Promise<string | null> => {
      applyFrame(t)
      await waitForTiles(camera, gl)
      await nextAnimationFrame()
      const state = get()
      state.advance(CLOCK_BASE + t, true)
      const canvas = gl.domElement
      if (capture === 'png') return canvas.toDataURL('image/png')
      if (capture === 'video') {
        if (encoder == null) throw new Error('film: video not started')
        if (encoderError != null) throw encoderError
        const frame = new VideoFrame(canvas, {
          timestamp: timestampUs,
          duration: Math.round(1e6 / fps),
          alpha: 'discard'
        })
        encoder.encode(frame, { keyFrame: Math.round(t * fps) % fps === 0 })
        frame.close()
        while (encoder.encodeQueueSize > 2) await sleep(2)
      }
      return null
    }

    const handle: FilmHandle = {
      id: shot.id,
      fps,
      frameCount,
      info: () => ({
        id: shot.id,
        title: shot.title,
        fps,
        frameCount,
        canvas: [gl.domElement.width, gl.domElement.height],
        quality: cloudsContext.qualityPreset,
        experimental: cloudsContext.experimental,
        ...celestial()
      }),
      prepare: async (warmupFrames: number) => {
        const firstTime = Array.isArray(shot.timeOfDay)
          ? (shot.timeOfDay as [number, number])[0]
          : ((shot.timeOfDay as number | undefined) ??
            scenePresets[shot.preset].timeOfDay)
        // Re-applied after mount: <CloudLayers> resets unclaimed slots in a
        // parent layout effect, which runs after the demo's own preset effect
        applyScenePreset(cloudsContext, shot.preset, {
          date: baseDate,
          location,
          timeOfDay: firstTime,
          sinks
        })
        applyTimeOfDay(firstTime)
        if (shot.coverage != null) cloudsContext.coverage = shot.coverage
        cloudsContext.experimental = {
          ...cloudsContext.experimental,
          cloudEnvironment: shot.ground === 'ocean',
          evolvingWeather: shot.evolvingWeather !== false
        }
        if (shot.evolvingWeather !== false) {
          cloudsContext.evolvingWeather = {
            ...evolvingWeatherDefaults,
            windSpeed: 15,
            cellLifetime: 180,
            lifeStrength: 0.5,
            ...shot.evolvingWeather
          }
        }
        const [u = 0, v = 0] = shot.weatherVelocity ?? []
        cloudsContext.localWeatherVelocity.set(u, v)
        shot.configure?.(cloudsContext)
        const { sunAzimuth, moonAzimuth } = celestial()
        frameAzimuth =
          (shot.frame === 'sun'
            ? sunAzimuth
            : shot.frame === 'moon'
              ? moonAzimuth
              : 0) + (shot.frameHeading ?? 0)
        const state = get()
        state.clock.elapsedTime = CLOCK_BASE - (warmupFrames + 1) / fps
        for (let i = warmupFrames; i > 0; --i) {
          await renderAt(-i / fps, 'none', 0)
        }
      },
      frame: (index, capture) =>
        renderAt(index / fps, capture, Math.round((index * 1e6) / fps)),
      startVideo: async ({ codec = 'avc1.640034', bitrate = 120e6 }) => {
        const { width, height } = gl.domElement
        const config: VideoEncoderConfig = {
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          bitrateMode: 'variable',
          latencyMode: 'quality',
          hardwareAcceleration: 'prefer-hardware',
          avc: { format: 'annexb' }
        }
        const support = await VideoEncoder.isConfigSupported(config)
        if (support.supported !== true) {
          throw new Error(
            `film: encoder config unsupported ${JSON.stringify(config)}`
          )
        }
        encoder = new VideoEncoder({
          output: chunk => {
            const bytes = new Uint8Array(chunk.byteLength)
            chunk.copyTo(bytes)
            window.__filmSink?.(
              toBase64(bytes),
              chunk.type === 'key',
              chunk.timestamp
            )
          },
          error: (error: Error) => {
            encoderError = error
          }
        })
        encoder.configure(config)
        return config
      },
      finishVideo: async () => {
        if (encoder == null) return
        await encoder.flush()
        encoder.close()
        encoder = null
        if (encoderError != null) throw encoderError
      }
    }
    window.__film = handle
    return () => {
      delete window.__film
      encoder?.close()
    }
  }, [
    shot,
    fps,
    baseDate,
    oceanAnchor,
    atmosphereContext,
    cloudsContext,
    refs,
    camera,
    gl,
    get
  ])

  return null
}
