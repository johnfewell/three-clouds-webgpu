// gl.readPixels returns rows bottom-first, side B's WebGPU readback top-first
// Every readLinear('A') consumer assumed top-first, which happened to agree
// with side B's mirrored layer (jg7u, ADR-013 Amendment 4). This helper is the
// one place the convention is corrected
export function flipRowsTopFirst(
  data: Float32Array,
  width: number,
  height: number,
  channels = 4
): Float32Array {
  const rowLength = width * channels
  if (data.length !== rowLength * height) {
    throw new Error(
      `flipRowsTopFirst: ${data.length} values is not ${width}x${height}x${channels}`
    )
  }
  const out = new Float32Array(data.length)
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowLength
    out.set(data.subarray(src, src + rowLength), y * rowLength)
  }
  return out
}
