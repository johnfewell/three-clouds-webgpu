// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import {
  Data3DTexture,
  NearestFilter,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType
} from 'three'
import { describe, expect, it } from 'vitest'

import {
  createHashJitterTexture,
  createJitterTexture
} from './loadBakedCloudTextures'

describe.each([
  ['createJitterTexture', createJitterTexture],
  ['createHashJitterTexture', createHashJitterTexture]
])('%s', (_name, create) => {
  const tex = create()

  it('returns a Data3DTexture', () => {
    expect(tex).toBeInstanceOf(Data3DTexture)
  })

  it('has correct dimensions 128×128×64', () => {
    expect(tex.image.width).toBe(128)
    expect(tex.image.height).toBe(128)
    expect(tex.image.depth).toBe(64)
  })

  it('has correct format, type, filter, and wrapping', () => {
    expect(tex.format).toBe(RedFormat)
    expect(tex.type).toBe(UnsignedByteType)
    expect(tex.minFilter).toBe(NearestFilter)
    expect(tex.magFilter).toBe(NearestFilter)
    expect(tex.wrapS).toBe(RepeatWrapping)
    expect(tex.wrapT).toBe(RepeatWrapping)
    expect(tex.wrapR).toBe(RepeatWrapping)
    expect(tex.colorSpace).toBe('')
  })

  it('is deterministic across calls', () => {
    const tex2 = create()
    const a = tex.image.data as Uint8Array
    const b = tex2.image.data as Uint8Array
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        throw new Error(`Mismatch at index ${i}: ${a[i]} vs ${b[i]}`)
      }
    }
  })

  it('has values spread over 0–255', () => {
    const data = tex.image.data as Uint8Array
    const buckets = new Array<number>(256).fill(0)
    for (let i = 0; i < data.length; i++) {
      buckets[data[i]!]!++
    }
    const min = Math.min(...buckets)
    const max = Math.max(...buckets)
    expect(min).toBeGreaterThan(0)
    expect(max).toBeLessThan(data.length / 128)
    expect(max - min).toBeLessThan(data.length / 256)
  })
})

// The ladder's bytes: the parity harness keeps this volume
describe('createHashJitterTexture bytes', () => {
  const tex = createHashJitterTexture()

  it('has deterministic first 4 bytes', () => {
    const data = tex.image.data as Uint8Array
    expect(data[0]).toBe(50)
    expect(data[1]).toBe(114)
    expect(data[2]).toBe(121)
    expect(data[3]).toBe(38)
  })

  it('has a fixed checksum', () => {
    const data = tex.image.data as Uint8Array
    let checksum = 0
    for (let i = 0; i < data.length; i++) {
      checksum = (checksum + data[i]!) | 0
    }
    expect(checksum >>> 0).toBe(133479638)
  })
})
