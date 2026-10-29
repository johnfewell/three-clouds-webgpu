// Vendored from three-geospatial storybook-webgpu/src/hooks/useMaybeMotionValue.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Verbatim.

import { MotionValue, motionValue } from 'motion/react'
import { useMemo } from 'react'

export function useMaybeMotionValue<T>(
  value: T | MotionValue<T>
): MotionValue<T> {
  return useMemo(
    () => (value instanceof MotionValue ? value : motionValue(value)),
    [value]
  )
}
