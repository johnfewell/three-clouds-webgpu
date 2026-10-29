// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:519 - optional refinement of an empty-to-dense bracket

import { bool, float, Fn, If, Loop } from 'three/tsl'
import type { Node } from 'three/webgpu'

export function createRefineCloudFront(
  occupied: (
    position: Node<'vec3'>,
    mip: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'bool'>
) {
  return Fn(
    ([origin, direction, near, far, mip, jitter]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const low = float(near).toVar()
      const high = float(far).toVar()
      // Keep the first dense endpoint: returning the empty side would let the
      // next long skip jump across the boundary we just found
      If(occupied(origin.add(direction.mul(high)), mip, jitter), () => {
        Loop(4, () => {
          const mid = low.add(high).mul(0.5).toVar()
          If(occupied(origin.add(direction.mul(mid)), mip, jitter), () => {
            high.assign(mid)
          }).Else(() => {
            low.assign(mid)
          })
        })
      })
      return high
    }
  )
}

export function refineCloudFrontCPU(
  occupied: (distance: number) => boolean,
  near: number,
  far: number
): number {
  if (!occupied(far)) return far
  for (let i = 0; i < 4; i++) {
    const mid = (near + far) * 0.5
    if (occupied(mid)) far = mid
    else near = mid
  }
  return far
}

export function createFrontTracker(
  refine: ReturnType<typeof createRefineCloudFront> | null
) {
  let previousDistance: Node<'float'>
  let previousOccupied: Node<'bool'>
  return {
    initialize: () => {
      previousDistance = float(0).toVar()
      previousOccupied = bool(true).toVar()
    },
    record: (distance: Node<'float'>, occupied: Node<'bool'>) => {
      if (refine != null) {
        previousDistance.assign(distance)
        previousOccupied.assign(occupied)
      }
    },
    refine: Fn(
      ([origin, direction, distance, mip, jitter]: [
        Node<'vec3'>,
        Node<'vec3'>,
        Node<'float'>,
        Node<'float'>,
        Node<'float'>
      ]) => {
        const result = distance.toVar()
        if (refine != null) {
          If(previousOccupied.not(), () => {
            result.assign(
              refine(origin, direction, previousDistance, distance, mip, jitter)
            )
          })
        }
        return result
      }
    )
  }
}
