// --keep-linear: keep the linear readbacks a capture's metrics came
// from, so two captures compare on the ladder's own data, not tone-mapped PNGs
// Off by default and never committed (ADR-011, .gitignore as a second lock)
// Plain .mjs + .d.mts like buildDigest
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LINEAR_FILES = {
  A: 'A.linear.f32',
  B: 'B.linear.f32',
  meta: 'linear.json'
}

// The page hands the Float32Array bytes over as base64 (FileReader dataURL of
// a Blob, linear in the buffer size, unlike a String.fromCharCode reduce)
export function writeLinearReadbacks(outDir, { width, height, a64, b64 }) {
  const a = Buffer.from(a64, 'base64')
  const b = Buffer.from(b64, 'base64')
  const expected = width * height * 4 * 4
  if (a.length !== expected || b.length !== expected) {
    throw new Error(
      `linear readback size mismatch: A ${a.length} B ${b.length} bytes, expected ${expected} (${width}x${height} RGBA float32)`
    )
  }
  writeFileSync(join(outDir, LINEAR_FILES.A), a)
  writeFileSync(join(outDir, LINEAR_FILES.B), b)
  writeFileSync(
    join(outDir, LINEAR_FILES.meta),
    JSON.stringify(
      {
        width,
        height,
        channels: 4,
        dtype: 'float32le',
        source: 'window.__parity.readLinear',
        note: 'never committed (ADR-011); written only with --keep-linear'
      },
      null,
      2
    ) + '\n'
  )
  return { bytes: expected }
}

export function readLinearReadback(path) {
  const b = readFileSync(path)
  return new Float32Array(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  )
}
