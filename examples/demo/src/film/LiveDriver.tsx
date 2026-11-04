// Endless, real-time version of a film shot. The camera holds near the
// anchor with a slow waver while the whole cloud field streams past at flight
// speed through the offset velocities, so the flight never ends and never
// jumps. Everything else (preset, sun, exposure) is the shot's own

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type FC } from 'react'
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

import type { FilmRefs } from './FilmDriver'
import type { FilmAnchor, FilmShot } from './shots'
import {
  bindSteeringInput,
  createSteering,
  flightDelta,
  stepSteering
} from './steering'

export interface LiveOptions {
  // Ground speed the cloud field streams at, metres per second
  speed: number
  // Cloud clock seconds per real second
  cloudTimeScale: number
  // Height of the hold, metres above the anchor
  altitude: number
  // Peak to peak of the slow vertical waver, metres
  bob: number
  pitch: number
  fov: number
  // Degrees clockwise from the shot's frame direction; 0 looks straight at it
  heading: number
}

interface LiveDriverProps {
  shot: FilmShot
  options: LiveOptions
  baseDate: Date
  oceanAnchor: FilmAnchor
  atmosphereContext: AtmosphereContext
  refs: FilmRefs
}

// Reads a live shot's knobs from the URL, with the shot's own values as the
// defaults: speed, cts, alt, bob, pitch, fov
export function liveOptionsFromParams(
  shot: FilmShot,
  params: URLSearchParams
): LiveOptions {
  const num = (key: string, fallback: number): number => {
    const value = Number(params.get(key))
    return params.get(key) != null && Number.isFinite(value) ? value : fallback
  }
  const first = shot.path[0]
  return {
    speed: num('speed', 45),
    cloudTimeScale: num('cts', 2),
    altitude: num('alt', first?.p[1] ?? 3000),
    bob: num('bob', 60),
    pitch: num('pitch', first?.pitch ?? -2),
    fov: num('fov', first?.fov ?? 55),
    heading: num('fh', 0)
  }
}

// The weather map is sampled on the cube-sphere uv of src/density/globeUv.ts,
// not exported by the package, so the same formula lives here for the CPU
function cubeSphereUv(px: number, py: number, pz: number): [number, number] {
  const len = Math.sqrt(px * px + py * py + pz * pz)
  const nx = px / len
  const ny = py / len
  const nz = pz / len
  const fx = Math.abs(nx)
  const fy = Math.abs(ny)
  const fz = Math.abs(nz)
  const fmax = Math.max(fx, fy, fz)
  const cx = nx / fmax
  const cy = ny / fmax
  const cz = nz / fmax
  let mx: number
  let my: number
  if (fy > fx && fy > fz) {
    mx = cy > 0 ? -nx : nx
    my = nz
  } else if (fx > fy && fx > fz) {
    mx = cx > 0 ? ny : -ny
    my = nz
  } else {
    mx = nx
    my = cz > 0 ? ny : -ny
  }
  const mx2 = mx * mx
  const my2 = my * my
  const q = -2 * mx2 + 2 * my2 - 3
  const inner = -24 * mx2 + q * q
  const uvx =
    Math.sqrt(
      Math.max(0, 1.5 + mx2 - my2 - 0.5 * Math.sqrt(Math.max(0, inner)))
    ) * Math.sign(mx)
  const uvy = Math.sqrt(Math.max(0, 6 / (3 - uvx * uvx))) * my
  return [uvx * 0.5 + 0.5, uvy * 0.5 + 0.5]
}

function azimuthOf(directionECEF: Vector3, localToECEF: Matrix4): number {
  const rotation = new Quaternion().setFromRotationMatrix(localToECEF).invert()
  const local = directionECEF.clone().applyQuaternion(rotation)
  return (Math.atan2(local.z, local.x) * 180) / Math.PI
}

// Three slow sines that never line up, so the waver reads as drift, not a loop
function waver(
  t: number,
  periods: readonly number[],
  phases: readonly number[]
): number {
  let value = 0
  const weights = [0.6, 0.3, 0.1]
  for (let i = 0; i < periods.length; ++i) {
    const period = periods[i] ?? 1
    value +=
      (weights[i] ?? 0) *
      Math.sin((2 * Math.PI * t) / period + (phases[i] ?? 0))
  }
  return value
}

export const LiveDriver: FC<LiveDriverProps> = ({
  shot,
  options,
  baseDate,
  oceanAnchor,
  atmosphereContext,
  refs
}) => {
  const { context: cloudsContext } = useClouds()
  const camera = useThree(({ camera }) => camera) as PerspectiveCamera
  const poseRef = useRef<((t: number, dt: number) => void) | null>(null)
  const elapsed = useRef(0)

  useEffect(() => {
    const anchor = shot.anchor ?? oceanAnchor
    const location = { longitude: anchor.longitude, latitude: anchor.latitude }
    const anchorECEF = new Geodetic(
      radians(anchor.longitude),
      radians(anchor.latitude),
      anchor.height
    ).toECEF()
    const localToECEF = Ellipsoid.WGS84.getNorthUpEastFrame(
      anchorECEF,
      new Matrix4()
    )
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
    const timeOfDay = Array.isArray(shot.timeOfDay)
      ? (shot.timeOfDay as [number, number])[0]
      : ((shot.timeOfDay as number | undefined) ??
        scenePresets[shot.preset].timeOfDay)
    applyScenePreset(cloudsContext, shot.preset, {
      date: baseDate,
      location,
      timeOfDay,
      sinks
    })
    syncCelestialDirections(sinks, { date: baseDate, location, timeOfDay })
    getECIToECEFRotationMatrix(
      resolveTimeOfDay(baseDate, timeOfDay, location),
      atmosphereContext.matrixECIToECEF.value
    )
    if (shot.coverage != null) cloudsContext.coverage = shot.coverage
    refs.exposure.current =
      typeof shot.exposure === 'number'
        ? shot.exposure
        : (shot.exposure?.[0] ?? refs.exposure.current)
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
    shot.configure?.(cloudsContext)

    // Flight direction: the shot's frame (toward the sun) turned by its heading
    const frameAzimuth =
      (shot.frame === 'sun'
        ? azimuthOf(cloudsContext.sunDirection, localToECEF)
        : shot.frame === 'moon'
          ? azimuthOf(cloudsContext.moonDirection, localToECEF)
          : 0) + options.heading
    const az = radians(frameAzimuth)
    const forwardLocal = new Vector3(Math.cos(az), 0, Math.sin(az))
    const localRotation = new Quaternion().setFromRotationMatrix(localToECEF)
    const forwardECEF = forwardLocal.clone().applyQuaternion(localRotation)
    const rightECEF = new Vector3(
      -Math.sin(az),
      0,
      Math.cos(az)
    ).applyQuaternion(localRotation)
    const flightDirection = new Vector3()
    const steering = createSteering()
    const input = { turn: 0, throttle: 0 }
    const unbindInput = bindSteeringInput(input)

    // Offsets advance by velocity x cloud time, which runs at cloudTimeScale,
    // so the per-cloud-second speed is the ground speed over that. A growing
    // offset moves the field against the flight: what flying forward looks like
    const perCloudSecond =
      options.cloudTimeScale > 0 ? options.speed / options.cloudTimeScale : 0
    const step = 10
    const ahead = anchorECEF.clone().addScaledVector(forwardECEF, step)
    const uv0 = cubeSphereUv(anchorECEF.x, anchorECEF.y, anchorECEF.z)
    const uv1 = cubeSphereUv(ahead.x, ahead.y, ahead.z)
    ahead.copy(anchorECEF).addScaledVector(rightECEF, step)
    const uvRight = cubeSphereUv(ahead.x, ahead.y, ahead.z)

    const fly = (): void => {
      const angle = radians(steering.heading)
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const speed = perCloudSecond * steering.speed
      flightDirection
        .copy(forwardECEF)
        .multiplyScalar(cos)
        .addScaledVector(rightECEF, sin)
      cloudsContext.shapeVelocity
        .copy(flightDirection)
        .multiplyScalar(speed)
        .multiply(cloudsContext.shapeRepeat)
      cloudsContext.shapeDetailVelocity
        .copy(flightDirection)
        .multiplyScalar(speed)
        .multiply(cloudsContext.shapeDetailRepeat)
      cloudsContext.localWeatherVelocity.set(
        (((uv1[0] - uv0[0]) * cos + (uvRight[0] - uv0[0]) * sin) / step) *
          speed *
          cloudsContext.localWeatherRepeat.x,
        (((uv1[1] - uv0[1]) * cos + (uvRight[1] - uv0[1]) * sin) / step) *
          speed *
          cloudsContext.localWeatherRepeat.y
      )
    }

    camera.fov = options.fov
    camera.updateProjectionMatrix()

    const worldFromLocal = new Matrix4()
    const worldFromLocalRotation = new Quaternion()
    const position = new Vector3()
    const direction = new Vector3()
    const lookMatrix = new Matrix4()
    const rollQuat = new Quaternion()
    const zAxis = new Vector3(0, 0, 1)
    const up = new Vector3(0, 1, 0)
    const origin = new Vector3()

    const pose = (t: number, dt: number): void => {
      stepSteering(steering, input, dt)
      fly()
      const height =
        options.altitude +
        (options.bob / 2) * waver(t, [31, 12.3, 5.1], [0, 1.7, 0.4])
      const heading =
        frameAzimuth +
        steering.heading +
        1.2 * waver(t, [41, 17, 7.3], [0.9, 2.6, 0.2])
      const pitch =
        options.pitch + 0.5 * waver(t, [23, 9.1, 4.3], [2.0, 0.3, 1.1])
      const roll = 1.5 * waver(t, [37, 14.7, 6.2], [1.3, 0.5, 2.2])
      position.set(0, height, 0)
      const h = radians(heading)
      const p = radians(pitch)
      direction.set(
        Math.cos(p) * Math.cos(h),
        Math.sin(p),
        Math.cos(p) * Math.sin(h)
      )
      lookMatrix.lookAt(origin, direction, up)
      camera.quaternion.setFromRotationMatrix(lookMatrix)
      rollQuat.setFromAxisAngle(zAxis, radians(roll))
      camera.quaternion.multiply(rollQuat)
      worldFromLocal
        .copy(atmosphereContext.matrixWorldToECEF.value)
        .invert()
        .multiply(localToECEF)
      worldFromLocalRotation.setFromRotationMatrix(worldFromLocal)
      camera.position.copy(position).applyMatrix4(worldFromLocal)
      camera.quaternion.premultiply(worldFromLocalRotation)
      camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
      camera.updateMatrixWorld()
    }
    pose(elapsed.current, 0)
    poseRef.current = pose
    return () => {
      unbindInput()
      poseRef.current = null
      cloudsContext.shapeVelocity.set(0, 0, 0)
      cloudsContext.shapeDetailVelocity.set(0, 0, 0)
      cloudsContext.localWeatherVelocity.set(0, 0)
    }
  }, [
    shot,
    options,
    baseDate,
    oceanAnchor,
    atmosphereContext,
    cloudsContext,
    refs,
    camera
  ])

  // Priority -1: the pose and the cloud clock are set before the passes read
  // them in the same frame
  useFrame((_, delta) => {
    if (document.hidden) return
    const dt = flightDelta(delta)
    const t = (elapsed.current += dt)
    refs.weatherTime.current = t * options.cloudTimeScale
    poseRef.current?.(t, dt)
  }, -1)

  return null
}
