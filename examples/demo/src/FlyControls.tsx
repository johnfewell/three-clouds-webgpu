// WASD flight controls layered on OrbitControls so keys translate the camera
// and orbit pivot together while pointer drag looks around from any altitude

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type FC } from 'react'
import { Quaternion, Vector3, type Matrix4 } from 'three'

import { Geodetic } from '@takram/three-geospatial'

const FORWARD = new Set(['KeyW', 'ArrowUp'])
const BACK = new Set(['KeyS', 'ArrowDown'])
const LEFT = new Set(['KeyA', 'ArrowLeft'])
const RIGHT = new Set(['KeyD', 'ArrowRight'])
const DOWN = new Set(['KeyQ', 'KeyC'])
const UP = new Set(['KeyE', 'Space'])
const FLY_KEYS = new Set([
  ...FORWARD,
  ...BACK,
  ...LEFT,
  ...RIGHT,
  ...DOWN,
  ...UP
])

const SPEED_PER_METRE = 0.3
const MIN_SPEED = 25
const BOOST = 4

const forward = /*#__PURE__*/ new Vector3()
const right = /*#__PURE__*/ new Vector3()
const up = /*#__PURE__*/ new Vector3()
const move = /*#__PURE__*/ new Vector3()
const ecef = /*#__PURE__*/ new Vector3()
const ecefToWorld = /*#__PURE__*/ new Quaternion()
const geodetic = /*#__PURE__*/ new Geodetic()

interface OrbitLike {
  target: Vector3
  minDistance: number
  update: () => void
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

function axis(keys: Set<string>, plus: Set<string>, minus: Set<string>) {
  let value = 0
  for (const code of keys) {
    if (plus.has(code)) value += 1
    if (minus.has(code)) value -= 1
  }
  return Math.sign(value)
}

export interface FlyControlsProps {
  enabled: boolean
  worldToECEF: Matrix4
  onAltitudeChange?: (altitudeMeters: number, cameraDirectionY: number) => void
}

export const FlyControls: FC<FlyControlsProps> = ({
  enabled,
  worldToECEF,
  onAltitudeChange
}) => {
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(({ controls }) => controls) as OrbitLike | null
  const invalidate = useThree(({ invalidate }) => invalidate)
  const keys = useRef(new Set<string>())
  const boost = useRef(false)
  const flying = useRef(false)
  const lastReportRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      keys.current.clear()
      flying.current = false
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      boost.current = event.shiftKey
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!FLY_KEYS.has(event.code) || isTyping(event.target)) return
      event.preventDefault()
      keys.current.add(event.code)
      invalidate()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      boost.current = event.shiftKey
      keys.current.delete(event.code)
    }
    const onBlur = () => {
      keys.current.clear()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      keys.current.clear()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [enabled, invalidate])

  useFrame((state, delta) => {
    ecef.copy(camera.position).applyMatrix4(worldToECEF)
    const altitude = geodetic.setFromECEF(ecef).height
    if (
      onAltitudeChange != null &&
      state.clock.elapsedTime - lastReportRef.current > 0.1
    ) {
      lastReportRef.current = state.clock.elapsedTime
      camera.getWorldDirection(forward)
      ecefToWorld.setFromRotationMatrix(worldToECEF).invert()
      up.copy(ecef).normalize().applyQuaternion(ecefToWorld)
      onAltitudeChange(altitude, forward.dot(up))
    }

    if (!enabled) return
    const held = keys.current
    if (held.size === 0 || controls == null) return

    camera.getWorldDirection(forward)
    ecefToWorld.setFromRotationMatrix(worldToECEF).invert()
    up.copy(ecef).normalize().applyQuaternion(ecefToWorld)
    right.crossVectors(forward, up).normalize()

    if (!flying.current) {
      flying.current = true
      controls.target
        .copy(camera.position)
        .addScaledVector(forward, controls.minDistance)
    }

    move
      .set(0, 0, 0)
      .addScaledVector(forward, axis(held, FORWARD, BACK))
      .addScaledVector(right, axis(held, RIGHT, LEFT))
      .addScaledVector(up, axis(held, UP, DOWN))
    if (move.lengthSq() === 0) return

    const speed =
      Math.max(MIN_SPEED, Math.abs(altitude) * SPEED_PER_METRE) *
      (boost.current ? BOOST : 1)
    move.normalize().multiplyScalar(speed * Math.min(delta, 0.1))

    camera.position.add(move)
    controls.target.add(move)
    controls.update()
    invalidate()
  })

  return null
}
