import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  LINEAR_FILES,
  readLinearReadback,
  writeLinearReadbacks
} from '../examples/parity/scripts/captureLinear.mjs'

// --keep-linear: the bytes the page computed its metrics from come
// back out as base64 and land on disk as float32le, byte-exact
describe('captureLinear', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-linear-'))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const width = 3
  const height = 2
  const values = new Float32Array(width * height * 4).map((_, i) =>
    i % 4 === 3 ? 1 : Math.fround(Math.sin(i) * 0.25 + 0.1)
  )
  const b64 = Buffer.from(
    values.buffer,
    values.byteOffset,
    values.byteLength
  ).toString('base64')

  it('round-trips the readback byte-exactly and writes the meta sidecar', () => {
    const { bytes } = writeLinearReadbacks(dir, {
      width,
      height,
      a64: b64,
      b64
    })
    expect(bytes).toBe(width * height * 16)
    const back = readLinearReadback(join(dir, LINEAR_FILES.A))
    expect(back.length).toBe(values.length)
    expect(Array.from(back)).toEqual(Array.from(values))
    expect(existsSync(join(dir, LINEAR_FILES.B))).toBe(true)
    const meta = JSON.parse(
      readFileSync(join(dir, LINEAR_FILES.meta), 'utf-8')
    ) as Record<string, unknown>
    expect(meta).toMatchObject({
      width,
      height,
      channels: 4,
      dtype: 'float32le'
    })
  })

  it('refuses a payload whose size does not match the frame', () => {
    expect(() =>
      writeLinearReadbacks(dir, {
        width: width + 1,
        height,
        a64: b64,
        b64
      })
    ).toThrow(/size mismatch/)
  })
})
