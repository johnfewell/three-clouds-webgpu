// WebGPU readbacks come back with 256-byte row stride: three 0.185's
// readRenderTargetPixelsAsync never strips the padding, and every consumer
// indexes tight rows. Invisible at 1280/320 columns (multiples of 256 B), it
// sheared 1277-column frames 3 px per row. RGBA only, anything else
// refuses rather than guessing a stride
export function unpadRows<T extends ArrayBufferView>(
  buf: T,
  width: number,
  height: number
): T {
  const Ctor = buf.constructor as {
    new (buffer: ArrayBuffer): T
    BYTES_PER_ELEMENT: number
  }
  const bytesPerTexel = 4 * Ctor.BYTES_PER_ELEMENT
  const tight = width * bytesPerTexel
  if (buf.byteLength === tight * height) return buf
  const stride = Math.ceil(tight / 256) * 256
  const tailTrimmed = (height - 1) * stride + tight
  const fullPadded = height * stride
  if (buf.byteLength !== tailTrimmed && buf.byteLength !== fullPadded) {
    throw new Error(
      `readback is ${buf.byteLength} B for ${width}×${height} RGBA×${Ctor.BYTES_PER_ELEMENT}: ` +
        `neither tight (${tight * height} B) nor 256-aligned rows (${tailTrimmed} B or ${fullPadded} B)`
    )
  }
  const src = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = new Uint8Array(tight * height)
  for (let y = 0; y < height; y++) {
    out.set(src.subarray(y * stride, y * stride + tight), y * tight)
  }
  return new Ctor(out.buffer)
}

// Derive 2D slice row stride from actual readback byte count so both
// tight three 0.187 slices and 256-padded slices decode without guessing
export function sliceRowStride(
  byteLength: number,
  width: number,
  height: number,
  bytesPerTexel: number
): number {
  const unpadded = width * bytesPerTexel
  const padded = Math.ceil(unpadded / 256) * 256
  if (byteLength === unpadded * height) return unpadded
  if (byteLength === padded * height) return padded
  throw new Error(
    `slice readback is ${byteLength} B for ${width}×${height}×${bytesPerTexel} B: ` +
      `expected unpadded ${unpadded * height} B (stride ${unpadded}) or 256-padded ${padded * height} B (stride ${padded})`
  )
}

export function readSliceRed(
  raw: Uint8Array,
  width: number,
  height: number,
  bytesPerTexel: number,
  out: Uint8Array = new Uint8Array(width * height),
  outOffset = 0
): Uint8Array {
  const stride = sliceRowStride(raw.byteLength, width, height, bytesPerTexel)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[outOffset + y * width + x] = raw[y * stride + x * bytesPerTexel]!
    }
  }
  return out
}
