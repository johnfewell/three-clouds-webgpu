import { hash, hashString } from 'three/src/nodes/core/NodeUtils.js'
import { NodeBuilder, type Renderer } from 'three/webgpu'

export function isWebGPU(
  target: NodeBuilder | Renderer | Renderer['backend']
): boolean {
  const backend =
    target instanceof NodeBuilder
      ? target.renderer.backend
      : 'backend' in target
        ? target.backend
        : target
  return backend.isWebGPUBackend === true
}

export function hashValues(
  ...values: ReadonlyArray<number | boolean | string | null | undefined>
): number {
  return hash(
    ...values.map(value =>
      typeof value === 'number'
        ? value
        : typeof value === 'boolean'
          ? +value
          : typeof value === 'string'
            ? hashString(value)
            : 0x7fffffff
    )
  )
}
