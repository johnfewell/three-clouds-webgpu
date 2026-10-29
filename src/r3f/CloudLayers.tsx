// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: r3f/CloudLayers.tsx:1-54

import {
  createContext,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type FC,
  type ReactNode
} from 'react'

import { CloudLayer } from '../CloudLayer'
import { CloudLayers as CloudLayersImpl } from '../CloudLayers'

/** Advanced allocation state, normally managed through CloudLayer children */
export interface CloudLayersContextValue {
  /** The borrowed four-slot collection */
  layers: CloudLayersImpl
  /** Unclaimed indices, maintained by child mounts and unmounts */
  indexPool: number[]
  /** Whether unclaimed slots reset to the empty standalone layer */
  disableDefault: boolean
}

/** Advanced provider access, normally installed by Clouds */
export const CloudLayersContext =
  /*#__PURE__*/ createContext<CloudLayersContextValue | null>(null)

interface LayerAllocation {
  index: number | null
}

interface LayerAllocator {
  context: CloudLayersContextValue
  dirty: boolean
  requests: Map<LayerAllocation, number | undefined>
  allocations: Set<LayerAllocation>
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
}

const allocators = new WeakMap<CloudLayersContextValue, LayerAllocator>()

function getAllocator(context: CloudLayersContextValue): LayerAllocator {
  let allocator = allocators.get(context)
  if (allocator == null) {
    const listeners = new Set<() => void>()
    allocator = {
      context,
      dirty: true,
      requests: new Map(),
      allocations: new Set(),
      listeners,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    allocators.set(context, allocator)
  }
  return allocator
}

function resetLayer(context: CloudLayersContextValue, index: number): void {
  context.layers[index]!.copy(
    context.disableDefault
      ? CloudLayer.DEFAULT
      : CloudLayersImpl.DEFAULT[index]!
  )
}

function releaseAllocation(
  allocator: LayerAllocator,
  allocation: LayerAllocation
): void {
  const index = allocation.index
  if (index == null) return
  resetLayer(allocator.context, index)
  allocator.allocations.delete(allocation)
  allocator.dirty = true
  allocation.index = null
  allocator.context.indexPool.push(index)
  allocator.context.indexPool.sort((first, second) => first - second)
}

function reserveExplicitAllocations(
  allocator: LayerAllocator,
  available: Set<number>
): Map<LayerAllocation, number> {
  const next = new Map<LayerAllocation, number>()
  if (allocator.requests.size > 4) {
    throw new Error(
      'Clouds supports at most four CloudLayer children; remove a layer before adding another'
    )
  }
  for (const [allocation, requested] of allocator.requests) {
    if (requested == null) continue
    if (!Number.isInteger(requested) || requested < 0 || requested > 3) {
      throw new RangeError(
        `CloudLayer index must be 0, 1, 2 or 3; received ${requested}`
      )
    }
    if (!available.delete(requested)) {
      throw new Error(
        `CloudLayer index ${requested} is already occupied; use a unique index or omit index for automatic allocation`
      )
    }
    next.set(allocation, requested)
  }
  return next
}

function requestedAllocations(allocator: LayerAllocator): {
  next: Map<LayerAllocation, number>
  available: Set<number>
} {
  const available = new Set(allocator.context.indexPool)
  for (const allocation of allocator.allocations) {
    if (allocation.index != null) available.add(allocation.index)
  }
  const next = reserveExplicitAllocations(allocator, available)
  for (const allocation of allocator.requests.keys()) {
    if (next.has(allocation) || allocation.index == null) continue
    if (available.delete(allocation.index))
      next.set(allocation, allocation.index)
  }
  for (const allocation of allocator.requests.keys()) {
    if (next.has(allocation)) continue
    const index = [...available].sort((first, second) => first - second)[0]
    if (index == null) {
      throw new Error(
        'CloudLayer has no free slot; release a layer or include an unclaimed index in the provider indexPool'
      )
    }
    available.delete(index)
    next.set(allocation, index)
  }
  return { next, available }
}

function reconcileAllocations(allocator: LayerAllocator): void {
  if (!allocator.dirty) return
  allocator.dirty = false
  const { next, available } = requestedAllocations(allocator)
  let changed = false
  for (const allocation of allocator.allocations) {
    if (allocation.index !== next.get(allocation)) {
      resetLayer(allocator.context, allocation.index!)
      allocation.index = null
      changed = true
    }
  }
  for (const [allocation, index] of next) {
    changed ||= allocation.index !== index
    allocation.index = index
  }
  allocator.allocations = new Set(next.keys())
  allocator.context.indexPool.splice(
    0,
    allocator.context.indexPool.length,
    ...[...available].sort((first, second) => first - second)
  )
  if (changed) for (const listener of allocator.listeners) listener()
}

export function useCloudLayerAllocation(
  context: CloudLayersContextValue,
  requested?: number
): LayerAllocation {
  const allocator = getAllocator(context)
  const allocation = useMemo<LayerAllocation>(
    () => ({ index: null }),
    [allocator]
  )

  useInsertionEffect(() => {
    allocator.requests.set(allocation, requested)
    allocator.dirty = true
    return () => {
      allocator.requests.delete(allocation)
      allocator.dirty = true
    }
  }, [allocator, allocation, requested])

  useLayoutEffect(() => {
    reconcileAllocations(allocator)
  })
  useLayoutEffect(
    () => () => releaseAllocation(allocator, allocation),
    [allocator, allocation]
  )
  useSyncExternalStore(
    allocator.subscribe,
    () => allocation.index,
    () => null
  )
  return allocation
}

/** Bind declarative children to an existing four-slot collection */
export interface CloudLayersProps {
  /** Borrowed collection, this component does not own GPU resources */
  layers: CloudLayersImpl
  /** Default false, true resets unclaimed slots to zero-height CloudLayer.DEFAULT */
  disableDefault?: boolean
  /** At most four simultaneously claimed CloudLayer slots */
  children?: ReactNode
}

/**
 * Provide fixed-slot allocation for advanced composition with an existing context
 * Normal Clouds usage installs this provider automatically
 */
export const CloudLayers: FC<CloudLayersProps> = ({
  layers,
  disableDefault = false,
  children
}) => {
  const context = useMemo<CloudLayersContextValue>(
    () => ({ layers, indexPool: [0, 1, 2, 3], disableDefault }),
    [layers, disableDefault]
  )

  useLayoutEffect(() => {
    for (const index of context.indexPool) {
      layers[index]!.copy(
        disableDefault ? CloudLayer.DEFAULT : CloudLayersImpl.DEFAULT[index]!
      )
    }
  }, [context, layers, disableDefault])

  return (
    <CloudLayersContext.Provider value={context}>
      {children}
    </CloudLayersContext.Provider>
  )
}
