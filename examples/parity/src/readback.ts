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
  const expected = (height - 1) * stride + tight
  if (buf.byteLength !== expected) {
    throw new Error(
      `readback is ${buf.byteLength} B for ${width}×${height} RGBA×${Ctor.BYTES_PER_ELEMENT}: ` +
        `neither tight (${tight * height} B) nor 256-aligned rows (${expected} B)`
    )
  }
  const src = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = new Uint8Array(tight * height)
  for (let y = 0; y < height; y++) {
    out.set(src.subarray(y * stride, y * stride + tight), y * tight)
  }
  return new Ctor(out.buffer)
}
