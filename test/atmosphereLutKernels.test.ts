// The atmosphere's scattering LUT kernel reads its radius in both cosView
// branches and after them. On three r186 atmosphere builds before fork release 6
// declare it in one branch, so half the 3D LUT used radius 0 (side B ~17 % dark)

import { FloatType } from 'three'
import type { Node } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import {
  AtmosphereLUTNode,
  AtmosphereParameters
} from '@takram/three-atmosphere/webgpu'

import { readsOutsideAssigningBlock, varsAssigned } from './helpers/branchScope'
import { compileComputeWGSL } from './helpers/compileWGSL'
import { log } from './helpers/log'

interface Captured {
  name: string
  node: Node
}

// The LUT node dispatches its kernels through renderer.compute, so a renderer
// that only records them yields each kernel's graph without a GPU
async function captureKernels(): Promise<Captured[]> {
  const captured: Captured[] = []
  const record = (node: Node) => {
    captured.push({ name: node.name, node })
  }
  const renderer = new Proxy<Record<string, unknown>>(
    {
      compute: record,
      computeAsync: record,
      hasFeature: () => true,
      backend: { isWebGPUBackend: true }
    },
    {
      // Every other renderer call is a no-op. `then` stays undefined, or an
      // await of the renderer would treat it as a thenable and never settle
      get: (target, key) =>
        key === 'then'
          ? undefined
          : (target[key as string] ?? (() => undefined))
    }
  )
  const lut = new AtmosphereLUTNode(new AtmosphereParameters(), FloatType)
  const internals = lut as unknown as {
    setup(builder: unknown): unknown
    updateTextures(renderer: unknown): Promise<void>
  }
  try {
    internals.setup({ renderer, backend: renderer['backend'] })
  } catch (error) {
    // The stub builder stops Node.setup after the textures exist, which is
    // all updateTextures needs. Logged, so a different failure is visible
    log('lut-setup-stopped', { error: String(error) })
  }
  await internals.updateTextures(renderer)
  return captured
}

describe('atmosphere LUT kernels', () => {
  it('compute the scattering radius where every read can see it', async () => {
    const kernels = await captureKernels()
    const scattering = kernels.find(k => k.name === 'scattering')
    expect(scattering, 'the scattering kernel is dispatched').toBeDefined()
    const wgsl = compileComputeWGSL(scattering!.node)
    const names = varsAssigned(wgsl, /^sqrt\(/)
    const outside = names.flatMap(n => readsOutsideAssigningBlock(wgsl, n))
    log('scattering-lut-radius', {
      kernels: kernels.map(k => k.name).join(' '),
      sqrtVars: names.length,
      readsOutsideAssigningBlock: outside.length,
      expected: 0
    })
    expect(
      names.length,
      'the scattering radius is held in vars'
    ).toBeGreaterThan(0)
    expect(outside).toEqual([])
  })
})
