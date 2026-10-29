// The default jitter volume is blue noise traceable to a committed
// generator, and the parity harness still gets the old hash bytes. Regenerate
// with `node scripts/generate-blue-noise.mjs` if the first test fails

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  createHashJitterTexture,
  createJitterTexture
} from '../src/textures/loadBakedCloudTextures'
import { log } from '../test/helpers/log'
import {
  generateRankMap,
  goldenVolume,
  jitterStatistics,
  lowbias32Volume,
  RANK_MAP_MODULE_PATH,
  rankMapModule
} from './generate-blue-noise.mjs'

// sha256 of main's createJitterTexture() at bab99ec4, the volume every
// committed parity capture was rendered with
const LADDER_HASH_SHA256 =
  '0f9c837276fd8979ef8b3065bf69d51d4d6232089248a2359a11ef7a254bb2c4'

const bytes = (texture: { image: { data: unknown } }): Uint8Array => {
  const data = texture.image.data
  if (!(data instanceof Uint8Array) || data.length === 0) {
    throw new Error('jitter volume has no bytes')
  }
  return data
}
const sha256 = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

describe('blue-noise jitter volume', () => {
  const map = generateRankMap()

  it('the embedded rank map is exactly what the committed generator emits', () => {
    const committed = readFileSync(RANK_MAP_MODULE_PATH, 'utf8')
    expect(committed).toBe(rankMapModule(map))
  })

  it('createJitterTexture builds the generator volume from the embedded map', () => {
    const library = bytes(createJitterTexture())
    const reference = goldenVolume(map)
    expect(library.length).toBe(reference.length)
    expect(sha256(library)).toBe(sha256(reference))
  })

  it('every slice is a uniform histogram, so no frame biases the jitter', () => {
    const data = bytes(createJitterTexture())
    const area = 128 * 128
    for (let k = 0; k < 64; k++) {
      const counts = new Uint32Array(256)
      for (let p = 0; p < area; p++) counts[data[k * area + p]!]!++
      expect(Math.min(...counts)).toBe(64)
      expect(Math.max(...counts)).toBe(64)
    }
  })

  // The point of the change: white noise leaves ~10x more low-frequency
  // energy per frame and per pixel than blue, which TRAA shows as grain
  it('is blue where the hash is white, on both statistics', () => {
    const blue = jitterStatistics(bytes(createJitterTexture()))
    const white = jitterStatistics(bytes(createHashJitterTexture()))
    log('jitter statistics', [
      { volume: 'blue (default)', ...blue },
      { volume: 'hash (parity)', ...white }
    ])
    expect(blue.blurVarianceMax).toBeLessThan(3e-4)
    expect(blue.pixelMeanVariance).toBeLessThan(1e-4)
    expect(white.blurVarianceMin).toBeGreaterThan(1e-3)
    expect(white.pixelMeanVariance).toBeGreaterThan(1e-3)
  })

  it('the parity hash volume is byte-identical to the ladder baseline', () => {
    const hash = bytes(createHashJitterTexture())
    log('parity hash volume', { sha256: sha256(hash) })
    expect(sha256(hash)).toBe(LADDER_HASH_SHA256)
    expect(sha256(lowbias32Volume())).toBe(LADDER_HASH_SHA256)
  })
})
