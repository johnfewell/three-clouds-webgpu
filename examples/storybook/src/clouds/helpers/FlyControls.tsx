// WASD flight for the WebGPU clouds stories, layered on the story's
// OrbitControls (mounted with makeDefault). Keys move the camera and the orbit
// target together, so a drag still looks around from wherever you flew to

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type FC } from 'react'
import { Matrix4, Quaternion, Vector3 } from 'three'

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

// Speed follows altitude, so a cloud is crossed in seconds at 1 km and the
// ground does not rush past at 100 m
const SPEED_PER_METRE = 0.3
const MIN_SPEED = 20
const BOOST = 4

const forward = new Vector3()
const right = new Vector3()
const up = new Vector3()
const move = new Vector3()
const ecef = new Vector3()
const ecefToWorld = new Quaternion()
const geodetic = new Geodetic()
const IDENTITY = new Matrix4()

// The slice of drei's OrbitControls this needs
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

// worldToECEF is the scene's world frame: identity for an ECEF world, the
// north-up-east frame for a rebased one (the ocean ground)
export const FlyControls: FC<{ worldToECEF?: Matrix4 }> = ({
  worldToECEF = IDENTITY
}) => {
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(({ controls }) => controls) as OrbitLike | null
  const invalidate = useThree(({ invalidate }) => invalidate)
  const keys = useRef(new Set<string>())
  const boost = useRef(false)
  const flying = useRef(false)

  useEffect(() => {
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
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [invalidate])

  useFrame((_, delta) => {
    const held = keys.current
    if (held.size === 0 || controls == null) return

    camera.getWorldDirection(forward)
    ecef.copy(camera.position).applyMatrix4(worldToECEF)
    ecefToWorld.setFromRotationMatrix(worldToECEF).invert()
    up.copy(ecef).normalize().applyQuaternion(ecefToWorld)
    right.crossVectors(forward, up).normalize()

    // The first key pulls the orbit pivot to just ahead of the camera, so a
    // drag turns the view rather than swinging around the story's far target
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

    const altitude = geodetic.setFromECEF(ecef).height
    const speed =
      Math.max(MIN_SPEED, Math.abs(altitude) * SPEED_PER_METRE) *
      (boost.current ? BOOST : 1)
    // Clamped delta: a tab switch must not fling the camera
    move.normalize().multiplyScalar(speed * Math.min(delta, 0.1))

    camera.position.add(move)
    controls.target.add(move)
    controls.update()
    invalidate()
  })

  return null
}
