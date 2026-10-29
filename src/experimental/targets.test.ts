import type { RenderTarget } from 'three/webgpu'
import { expect, it, vi } from 'vitest'

import { log } from '../../test/helpers/log'
import type { CloudsContext } from '../CloudsContext'
import { clouds } from '../CloudsPassNode'

interface Targets {
  ensureResolveTargets: (ctx: CloudsContext) => void
  ensureShadowResolveTargets: (
    width: number,
    height: number,
    layers: number
  ) => void
  resolveRT: RenderTarget
  historyRT: RenderTarget
  shadowResolveRT: RenderTarget
  shadowHistoryRT: RenderTarget
}

it('preserves array bindings through compute toggles and cascade resizes', () => {
  const pass = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  const targets = pass as unknown as Targets
  ctx.experimental = { computeResolve: true }
  targets.ensureResolveTargets(ctx)
  targets.ensureShadowResolveTargets(63, 61, 3)
  const first = targets.shadowResolveRT
  const disposed = vi.spyOn(first, 'dispose')
  for (const target of [targets.shadowResolveRT, targets.shadowHistoryRT]) {
    expect(target.texture.isArrayTexture).toBe(true)
    expect(
      (target.texture as unknown as { isStorageTexture: boolean })
        .isStorageTexture
    ).toBe(true)
  }
  targets.ensureShadowResolveTargets(67, 65, 2)
  expect(disposed).toHaveBeenCalledOnce()
  expect(targets.shadowResolveRT).not.toBe(first)
  expect(targets.shadowResolveRT.texture.isArrayTexture).toBe(true)
  expect(targets.shadowResolveRT.depth).toBe(2)
  ctx.experimental = { computeResolve: false }
  targets.ensureResolveTargets(ctx)
  targets.ensureShadowResolveTargets(67, 65, 2)
  expect(
    (targets.resolveRT.texture as unknown as { isStorageTexture?: boolean })
      .isStorageTexture
  ).not.toBe(true)
  log('resolve target lifecycle', {
    width: targets.shadowResolveRT.width,
    layers: targets.shadowResolveRT.depth
  })
  pass.dispose()
})
