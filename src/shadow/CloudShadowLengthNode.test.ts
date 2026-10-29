// CPU twin tests for CloudShadowLengthNode
// Cite: ADR-005 (shadowLength vec2 encoding)

import { Texture } from 'three'
import { texture } from 'three/tsl'
import { describe, expect, test } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  buildCloudShadowLength,
  cloudShadowLengthCPU
} from './CloudShadowLengthNode'

describe('cloudShadowLength CPU twin', () => {
  setCurrentSpec('CloudShadowLengthNode')

  // .y is measured from the real camera, and the runtime moves it for
  // an in-space camera (runtime.ts:193-196, 722-725). So the node passes the
  // segment through, and a rebase here would move it twice
  test('no rebase: the segment passes through for a camera above the shadow top', () => {
    const shadowLength = 3.5
    const shadowStart = 21.25

    const [x, y] = cloudShadowLengthCPU(shadowLength, shadowStart, true, true)

    expect(x).toBe(shadowLength)
    expect(y).toBe(shadowStart)

    log('no-rebase', { x, y, expectedY: shadowStart })
  })

  test('lightShafts = false → (0, 0)', () => {
    const [x, y] = cloudShadowLengthCPU(0.05, 0.002, false, true)

    expect(x).toBe(0)
    expect(y).toBe(0)

    log('lightShafts-off', { x, y })
  })

  test('enabled = false → (0, 0)', () => {
    const [x, y] = cloudShadowLengthCPU(0.05, 0.002, true, false)

    expect(x).toBe(0)
    expect(y).toBe(0)

    log('enabled-off', { x, y })
  })

  test('both lightShafts and enabled false → (0, 0)', () => {
    const [x, y] = cloudShadowLengthCPU(0.05, 0.002, false, false)

    expect(x).toBe(0)
    expect(y).toBe(0)

    log('both-off', { x, y })
  })

  test('vec2 field order: .x = shadowLength, .y = shadow start (ADR-005)', () => {
    const [x, y] = cloudShadowLengthCPU(0.123, 0.456, true, true)

    expect(x).toBe(0.123)
    expect(y).toBe(0.456)

    log('field-order', { x, y })
  })
})

// The GPU node, at emission: the live body is the sample's two channels and
// nothing else (no arithmetic on .y), so a reintroduced rebase is caught here
// rather than only in the twin
describe('CloudShadowLengthNode emission (stage=emission)', () => {
  test('the live node returns the sampled segment unmodified', () => {
    const node = buildCloudShadowLength({
      shadowLengthTextureNode: texture(new Texture()),
      isLive: () => true
    })
    const { fragment } = compileWGSL(node)
    const main = fragment.slice(fragment.indexOf('fn main('))
    const sample = /(\w+) = textureSample(?:Level)?\(/.exec(main)?.[1]
    const arithmeticOnSample =
      sample == null
        ? []
        : main
            .split('\n')
            .filter(
              l =>
                l.includes(sample) &&
                !/= textureSample/.test(l) &&
                /[-*/]|max\(|min\(/.test(l.replace(/\bnodeVar\d+\b/g, ''))
            )
    log('cloud-shadow-length-emission', {
      sampled: sample != null,
      arithmeticLines: arithmeticOnSample.length,
      expected: 0
    })
    expect(sample, 'the node samples the attachment').toBeDefined()
    expect(arithmeticOnSample).toEqual([])
  })
})
