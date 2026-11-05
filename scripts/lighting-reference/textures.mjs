// PNG codec and texture sampling for the lighting reference. The CPU density
// evaluator reads the same baked assets the GPU reads, so this decodes the
// PNGs and samples them the way the sampler does
//
// Cite: src/textures/loadBakedCloudTextures.ts (the formats and the filters)
// Cite: src/density/sampleWeather.ts (the weather read and its mip level)

import { readFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'

// PNG decoding

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel
  const out = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? cur[x - bytesPerPixel] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) value += paeth(a, b, c)
      cur[x] = value & 0xff
    }
  }
  return out
}

/**
 * Decode a non-interlaced 8-bit PNG into RGBA bytes
 * Only what the baked assets use: colour type 6 (RGBA) or 2 (RGB)
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG')
  }
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8) throw new Error('only 8-bit PNGs are supported')
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported')
      colorType = body[9]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error('unsupported PNG colour type')
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = unfilter(raw, width, height, channels)
  if (channels === 4) {
    return { width, height, data: new Uint8Array(pixels) }
  }
  // Expand RGB to RGBA so every sampler sees one layout
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * 3]
    rgba[i * 4 + 1] = pixels[i * 3 + 1]
    rgba[i * 4 + 2] = pixels[i * 3 + 2]
    rgba[i * 4 + 3] = 255
  }
  return { width, height, data: rgba }
}

export function loadPngFile(path) {
  return decodePng(readFileSync(path))
}

// PNG writing

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

/** Write RGBA bytes as a PNG */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    )
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Texture sampling

function wrapRepeat(value, size) {
  const wrapped = value % size
  return wrapped < 0 ? wrapped + size : wrapped
}

/**
 * A 2D RGBA texture with a box-filtered mip chain, sampled the way a
 * LinearMipMapLinearFilter sampler does
 */
export class Texture2D {
  constructor(width, height, data) {
    this.width = width
    this.height = height
    this.levels = [data]
    this.buildMips()
  }

  buildMips() {
    let { width, height } = this
    let data = this.levels[0]
    while (width > 1 || height > 1) {
      const nextWidth = Math.max(1, width >> 1)
      const nextHeight = Math.max(1, height >> 1)
      const next = new Uint8Array(nextWidth * nextHeight * 4)
      for (let y = 0; y < nextHeight; y++) {
        for (let x = 0; x < nextWidth; x++) {
          const x0 = Math.min(width - 1, x * 2)
          const x1 = Math.min(width - 1, x * 2 + 1)
          const y0 = Math.min(height - 1, y * 2)
          const y1 = Math.min(height - 1, y * 2 + 1)
          for (let c = 0; c < 4; c++) {
            const sum =
              data[(y0 * width + x0) * 4 + c] +
              data[(y0 * width + x1) * 4 + c] +
              data[(y1 * width + x0) * 4 + c] +
              data[(y1 * width + x1) * 4 + c]
            next[(y * nextWidth + x) * 4 + c] = Math.round(sum / 4)
          }
        }
      }
      this.levels.push(next)
      width = nextWidth
      height = nextHeight
      data = next
    }
  }

  /** The bilinear sample of one mip level, in [0, 1] per channel */
  sampleLevel(u, v, level) {
    const data = this.levels[Math.min(level, this.levels.length - 1)]
    const width = Math.max(1, this.width >> level)
    const height = Math.max(1, this.height >> level)
    const fx = u * width - 0.5
    const fy = v * height - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const xa = wrapRepeat(x0, width)
    const xb = wrapRepeat(x0 + 1, width)
    const ya = wrapRepeat(y0, height)
    const yb = wrapRepeat(y0 + 1, height)
    const out = [0, 0, 0, 0]
    for (let c = 0; c < 4; c++) {
      const v00 = data[(ya * width + xa) * 4 + c]
      const v10 = data[(ya * width + xb) * 4 + c]
      const v01 = data[(yb * width + xa) * 4 + c]
      const v11 = data[(yb * width + xb) * 4 + c]
      const top = v00 + (v10 - v00) * tx
      const bottom = v01 + (v11 - v01) * tx
      out[c] = (top + (bottom - top) * ty) / 255
    }
    return out
  }

  /** The trilinear-mip sample, matching textureSampleLevel at a fractional level */
  sample(u, v, level) {
    const maxLevel = this.levels.length - 1
    const clamped = Math.max(0, Math.min(maxLevel, level))
    const low = Math.floor(clamped)
    const high = Math.min(maxLevel, low + 1)
    const frac = clamped - low
    const a = this.sampleLevel(u, v, low)
    const b = this.sampleLevel(u, v, high)
    const out = [0, 0, 0, 0]
    for (let c = 0; c < 4; c++) out[c] = a[c] + (b[c] - a[c]) * frac
    return out
  }
}

/**
 * A single-channel 3D volume with repeat wrapping, sampled trilinearly
 * The layout matches three's Data3DTexture: x fastest, then y, then z
 */
export class Volume3D {
  constructor(size, data) {
    this.size = size
    this.data = data
  }

  at(x, y, z) {
    const n = this.size
    const xi = wrapRepeat(Math.floor(x), n)
    const yi = wrapRepeat(Math.floor(y), n)
    const zi = wrapRepeat(Math.floor(z), n)
    return this.data[xi + yi * n + zi * n * n] / 255
  }

  /** The trilinear sample, with the sampler clamp at 1/255 */
  sample(x, y, z) {
    const n = this.size
    const fx = x * n - 0.5
    const fy = y * n - 0.5
    const fz = z * n - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const z0 = Math.floor(fz)
    const tx = fx - x0
    const ty = fy - y0
    const tz = fz - z0
    let total = 0
    for (let dz = 0; dz < 2; dz++) {
      const wz = dz === 0 ? 1 - tz : tz
      for (let dy = 0; dy < 2; dy++) {
        const wy = dy === 0 ? 1 - ty : ty
        for (let dx = 0; dx < 2; dx++) {
          const wx = dx === 0 ? 1 - tx : tx
          const xi = wrapRepeat(x0 + dx, n)
          const yi = wrapRepeat(y0 + dy, n)
          const zi = wrapRepeat(z0 + dz, n)
          total += wx * wy * wz * this.data[xi + yi * n + zi * n * n]
        }
      }
    }
    return Math.min(1, total / 255)
  }
}
