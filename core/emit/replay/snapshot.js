// Texture readback for the replay proof
// Rows are padded to 256 bytes, the same layout gpuhook.js records
const BPT = {
  r8unorm: 1,
  r8snorm: 1,
  r8uint: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  r16float: 2,
  rg16float: 4,
  rgba16float: 8,
  r32float: 4,
  rg32float: 8,
  rgba32float: 16,
  r32uint: 4,
  rgba32uint: 16,
  rgb10a2unorm: 4,
  rg11b10ufloat: 4,
  depth32float: 4,
  r16uint: 2,
  rg32uint: 8
}
export async function snapshot(device, tex, mip = 0) {
  const fmt = tex.format
  const bpt = BPT[fmt]
  if (!bpt) return { skipped: 'format ' + fmt }
  const w = Math.max(1, tex.width >> mip)
  const h = tex.dimension === '1d' ? 1 : Math.max(1, tex.height >> mip)
  const d =
    tex.dimension === '3d'
      ? Math.max(1, tex.depthOrArrayLayers >> mip)
      : tex.depthOrArrayLayers
  const bpr = Math.ceil((w * bpt) / 256) * 256
  const buf = device.createBuffer({
    size: bpr * h * d,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  })
  const enc = device.createCommandEncoder()
  enc.copyTextureToBuffer(
    {
      texture: tex,
      mipLevel: mip,
      aspect: fmt.startsWith('depth') ? 'depth-only' : 'all'
    },
    { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
    [w, h, d]
  )
  device.queue.submit([enc.finish()])
  await buf.mapAsync(GPUMapMode.READ)
  const bytes = new Uint8Array(buf.getMappedRange().slice(0))
  buf.unmap()
  buf.destroy()
  return { fmt, w, h, d, bpr, bpt, bytes }
}
