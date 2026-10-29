// Vendored from three-geospatial storybook-webgpu/src/worker/pool.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Edited: unchanged code; the worker only registers computeCreasedNormalAttribute (no water-area task).

import workerpool, { type Pool, type Promise } from 'workerpool'
import type { ExecOptions } from 'workerpool/types/types'

import type { TransferResult } from './transfer'
import type { methods } from './worker'
import worker from './worker?worker&url'

let pool: Pool | undefined

function createPool(): Pool {
  return (pool ??= workerpool.pool(worker, {
    // On many-core CPUs, using all the cores consumes too much heap memory.
    maxWorkers: 8,
    // This is the strategy that makes sense to use with 3d-tiles-renderer.
    queueStrategy: 'lifo',
    workerOpts: {
      type: 'module'
    }
  }))
}

type Method = keyof typeof methods
type MethodParams<T extends Method> = Parameters<(typeof methods)[T]>
type MethodReturnType<
  T extends Method,
  R = Awaited<ReturnType<(typeof methods)[T]>>
> = R extends TransferResult<infer U> ? U : R

// eslint-disable-next-line @typescript-eslint/promise-function-async
export function queueTask<T extends Method>(
  method: T,
  params?: MethodParams<T>,
  options?: ExecOptions
): Promise<MethodReturnType<T>> {
  return createPool().exec(method, params, options)
}
