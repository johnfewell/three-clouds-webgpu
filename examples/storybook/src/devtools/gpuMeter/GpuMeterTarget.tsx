// Connects an r3f canvas to the GPU meter: its renderer's device, and the
// frame brackets around every r3f frame. The brackets are subscribed only
// while the meter is on

import { addAfterEffect, addEffect, useThree } from '@react-three/fiber'
import { useEffect, useSyncExternalStore, type FC } from 'react'

import type { MeterDevice } from './GpuProfiler'
import { gpuMeter } from './meter'

export function meterDevice(renderer: unknown): MeterDevice | undefined {
  const backend = (renderer as { backend?: { device?: MeterDevice } }).backend
  return backend?.device
}

export const GpuMeterTarget: FC = () => {
  const renderer = useThree(({ gl }) => gl)
  const active = useSyncExternalStore(
    listener => gpuMeter.subscribe(listener),
    () => gpuMeter.active
  )
  useEffect(() => {
    const device = meterDevice(renderer)
    return device != null ? gpuMeter.attach(device) : undefined
  }, [renderer])
  useEffect(() => {
    if (!active) return
    const begin = addEffect(time => {
      gpuMeter.beginFrame(time)
    })
    const end = addAfterEffect(() => {
      gpuMeter.endFrame()
    })
    return () => {
      begin()
      end()
    }
  }, [active])
  return null
}
