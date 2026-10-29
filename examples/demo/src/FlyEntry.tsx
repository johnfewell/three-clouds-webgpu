// Switching to Fly lifts the camera from the surface into the lowest cloud
// layer, so flight starts among the clouds. The climb eases in over a couple
// of seconds and stops at once when a flight key is pressed

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type FC } from 'react'
import { Quaternion, Vector3, type Matrix4 } from 'three'
import type { CloudsContext } from 'three-clouds-webgpu'
import { useClouds } from 'three-clouds-webgpu/r3f'

import { Geodetic } from '@takram/three-geospatial'

// A third of the way up the layer: among the cells, not inside a dense core
const LAYER_FRACTION = 0.35
// Per-second approach rate of the eased climb, and its top speed in m/s
const EASE_RATE = 1.5
const MAX_SPEED = 900
// Below this distance to the target the climb is done
const ARRIVED_METRES = 5

const ecef = /*#__PURE__*/ new Vector3()
const up = /*#__PURE__*/ new Vector3()
const step = /*#__PURE__*/ new Vector3()
const ecefToWorld = /*#__PURE__*/ new Quaternion()
const geodetic = /*#__PURE__*/ new Geodetic()

interface OrbitLike {
  target: Vector3
  update: () => void
}

// The altitude flight starts at, or null when no layer is active
export function flyEntryAltitude(context: CloudsContext): number | null {
  let lowest: { altitude: number; height: number } | null = null
  for (const layer of context.cloudLayers) {
    if (layer.height <= 0 || layer.densityScale <= 0) continue
    if (lowest == null || layer.altitude < lowest.altitude) lowest = layer
  }
  return lowest == null
    ? null
    : lowest.altitude + lowest.height * LAYER_FRACTION
}

export interface FlyEntryProps {
  enabled: boolean
  worldToECEF: Matrix4
}

export const FlyEntry: FC<FlyEntryProps> = ({ enabled, worldToECEF }) => {
  const { context } = useClouds()
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(({ controls }) => controls) as OrbitLike | null
  const invalidate = useThree(({ invalidate }) => invalidate)
  const target = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) {
      target.current = null
      return
    }
    target.current = flyEntryAltitude(context)
    invalidate()
    // Any flight key hands control back to the pilot
    const cancel = (event: KeyboardEvent) => {
      if (/^(Key[WASDQEC]|Arrow|Space)/.test(event.code)) target.current = null
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [enabled, context, invalidate])

  useFrame((_, delta) => {
    const goal = target.current
    if (goal == null) return
    ecef.copy(camera.position).applyMatrix4(worldToECEF)
    const altitude = geodetic.setFromECEF(ecef).height
    const remaining = goal - altitude
    // Never pull a pilot down who is already above the deck base
    if (remaining < ARRIVED_METRES) {
      target.current = null
      return
    }
    ecefToWorld.setFromRotationMatrix(worldToECEF).invert()
    up.copy(ecef).normalize().applyQuaternion(ecefToWorld)
    const dt = Math.min(delta, 0.1)
    const eased = remaining * (1 - Math.exp(-EASE_RATE * dt))
    step.copy(up).multiplyScalar(Math.min(eased, MAX_SPEED * dt))
    camera.position.add(step)
    controls?.target.add(step)
    controls?.update()
    invalidate()
  })

  return null
}
