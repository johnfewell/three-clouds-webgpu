// The off-proof for the cloud-variety work, in the shape
// docs/design/cloud-types.md section 7 asks every sibling to use: an untouched
// CloudsContext must still compile to, and be handed, exactly what main did
// Both literals were measured on a worktree at origin/main with this file and
// test/helpers/defaultChainDigest.ts copied in unmodified

import { describe, expect, it } from 'vitest'

import { table } from '../../test/helpers/cpuTwin'
import {
  compileDefaultChain,
  defaultChainBytes,
  defaultChainDigest,
  layerUniformStateDigest,
  packLayerUniformState
} from '../../test/helpers/defaultChainDigest'
import { CloudsContext } from '../CloudsContext'

// WGSL refreshed for the stock r187 compiler, default uniforms are unchanged
// The two-arm density-chain comparison below still checks distinct programs
// A failure prints the digest, so a stale literal names its own replacement
const DEFAULT_WGSL_SHA256 =
  'f7122d6ac2dad868a810350fb845df7ec400e5eb7ecfcf50a11828b9311370f6'
const DEFAULT_UNIFORMS_SHA256 =
  'd3e9b12a3fd38acb71368b0f9c01f57aff9c4ca9ad55dae1e7e0b97e18ffb37d'

describe('default render is untouched by the variety work', () => {
  it('compiles the density chain to the WGSL main produced', () => {
    const ctx = new CloudsContext()
    const digest = defaultChainDigest(ctx)
    table('default-wgsl', [
      { field: 'sha256', expected: DEFAULT_WGSL_SHA256, actual: digest },
      {
        field: 'both arms, bytes',
        expected: 'main+0',
        actual: defaultChainBytes(ctx)
      },
      {
        field: 'the two arms differ',
        expected: true,
        actual:
          compileDefaultChain(ctx, false) !== compileDefaultChain(ctx, true)
      }
    ])
    expect(digest).toBe(DEFAULT_WGSL_SHA256)
  })

  it('hands the shader the default uniform values main produced', () => {
    const ctx = new CloudsContext()
    const digest = layerUniformStateDigest(ctx)
    table('default-uniforms', [
      {
        field: 'sha256',
        expected: DEFAULT_UNIFORMS_SHA256,
        actual: digest
      },
      { field: 'coverage', expected: 0.3, actual: ctx.coverage },
      {
        field: 'channels',
        expected: 'rgba',
        actual: ctx.cloudLayers.localWeatherChannels
      },
      {
        field: 'structure',
        expected: '1110we',
        actual: [
          ctx.cloudLayers.structure.active.join(''),
          ctx.cloudLayers.structure.weatherExponentOne ? 'w' : '-',
          ctx.cloudLayers.structure.expTermZero ? 'e' : '-'
        ].join('')
      },
      {
        field: 'packed bytes',
        expected: '>0, never a digest of nothing',
        actual: packLayerUniformState(ctx).length
      }
    ])
    expect(digest).toBe(DEFAULT_UNIFORMS_SHA256)
  })
})
