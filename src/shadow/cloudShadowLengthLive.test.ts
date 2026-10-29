// `cloudsPass.cloudShadowLength` must be a live node from
// construction. Consumers read it before the pass builds, and a null left
// shafts inert (plates identical to seven decimals, arm L)

// The build-time capture trap, one level up: a producer's public node has to
// exist from construction, never be minted in setup(). Both tests failed on
// the old code: a null getter, then a consumer compiled to vec2(0)

import { Texture } from 'three'
import { Fn, texture, vec2, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { describe, expect, test } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { clouds } from '../CloudsPassNode'

describe('cloudShadowLength is live from construction', () => {
  setCurrentSpec('cloudShadowLengthLive')

  test('exists before the first build and is the SAME node after it', () => {
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true
    ctx.lightShafts = true

    // What sideB.ts:428 / examples read: at construction, before any build
    const before = pass.cloudShadowLength
    expect(before).not.toBeNull()

    // Builds the whole pass graph, i.e. runs setup(), the point at which the
    // old code first minted the node
    compileWGSL(pass.composite(texture(new Texture())))
    const after = pass.cloudShadowLength

    expect(after).toBe(before)
    log('identity', {
      nonNullBeforeBuild: before != null,
      sameObjectAfterBuild: after === before
    })
  })

  test('a consumer built around it reads the shadow-length attachment when lightShafts is on, and vec2(0) when off', () => {
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true

    // Captured once, exactly as the aerial node captures it. The graph flag
    // is read when the CONSUMER builds, not when the node was handed over
    const captured: Node<'vec2'> | null = pass.cloudShadowLength
    const consumer = () => Fn(() => vec4(captured ?? vec2(0), 0, 1))()

    ctx.lightShafts = true
    const on = normalizeWGSL(compileWGSL(consumer()).fragment)
    ctx.lightShafts = false
    const off = normalizeWGSL(compileWGSL(consumer()).fragment)

    const onReads = (on.match(/textureSample/g) ?? []).length
    const offReads = (off.match(/textureSample/g) ?? []).length
    log('consumer-reads', { onReads, offReads })

    expect(onReads).toBeGreaterThan(0)
    expect(offReads).toBe(0)
  })
})
