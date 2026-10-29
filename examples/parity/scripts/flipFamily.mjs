// Flip-family orientation test over the committed plates: before any mechanism
// hunt, check whether a failing case is a flip, mirror or rotation (several
// real defects were). Correlation is affine-invariant, so level shifts cannot
// change the winner. Exits non-zero if any flip beats identity
//   node examples/parity/scripts/flipFamily.mjs [--all | --case <name> --tiles]

import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { inflateSync } from 'node:zlib'

/**
 * Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced, which is what
 * canvas.toDataURL() emits and therefore all this repo ever writes. Inline
 * because the workspace has no image dependency and a plate comparison is not
 * worth adding one.
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, channels: number, data: Buffer }}
 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      if (body[12] !== 0) throw new Error('interlaced PNG unsupported')
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`colour type ${colorType} unsupported`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const row = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev =
      y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = row[x]
      switch (filter) {
        case 0:
          break
        case 1:
          v += a
          break
        case 2:
          v += b
          break
        case 3:
          v += (a + b) >> 1
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
        default:
          throw new Error(`bad filter ${filter} on row ${y}`)
      }
      cur[x] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

/**
 * Luminance plane as Float64Array, so transforms are cheap.
 * @param {{width:number,height:number,channels:number,data:Buffer}} img
 * @returns {Float64Array}
 */
export function luminance({ width, height, channels, data }) {
  const out = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    out[i] =
      (data[i * channels] + data[i * channels + 1] + data[i * channels + 2]) / 3
  }
  return out
}

/**
 * Pearson correlation. Invariant under affine transforms of either input,
 * which is why a level shift cannot change which orientation wins.
 * @param {Float64Array} x
 * @param {Float64Array} y
 * @returns {number}
 */
export function correlation(x, y) {
  let mx = 0
  let my = 0
  for (let i = 0; i < x.length; i++) {
    mx += x[i]
    my += y[i]
  }
  mx /= x.length
  my /= y.length
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx
    const dy = y[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx < 1e-9 || syy < 1e-9) return NaN
  return sxy / Math.sqrt(sxx * syy)
}

export const flipY = (a, w, h) => {
  const o = new Float64Array(a.length)
  for (let y = 0; y < h; y++)
    o.set(a.subarray((h - 1 - y) * w, (h - y) * w), y * w)
  return o
}
export const mirrorX = (a, w, h) => {
  const o = new Float64Array(a.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) o[y * w + x] = a[y * w + (w - 1 - x)]
  return o
}

/** Each of N column- or row-tiles flipped vertically, for atlas layouts */
export function perTileFlipY(a, w, h, n, axis) {
  const o = Float64Array.from(a)
  if (axis === 'col') {
    const tw = Math.floor(w / n)
    for (let i = 0; i < n; i++) {
      const x0 = i * tw
      const x1 = i === n - 1 ? w : x0 + tw
      for (let y = 0; y < h; y++)
        for (let x = x0; x < x1; x++) o[y * w + x] = a[(h - 1 - y) * w + x]
    }
  } else {
    const th = Math.floor(h / n)
    for (let i = 0; i < n; i++) {
      const y0 = i * th
      const y1 = i === n - 1 ? h : y0 + th
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < w; x++)
          o[y * w + x] = a[(y1 - 1 - (y - y0)) * w + x]
    }
  }
  return o
}

/** CLI entry. Exported for the test to call with an explicit argv. */
export function main(argvIn = process.argv.slice(2)) {
  const argv = argvIn
  const wantAll = argv.includes('--all')
  const wantTiles = argv.includes('--tiles')
  const onlyCase = argv.includes('--case')
    ? argv[argv.indexOf('--case') + 1]
    : null

  const dirs = globSync('parity/results/*/*').filter(d =>
    existsSync(join(d, 'metrics.json'))
  )

  const rows = []
  for (const d of dirs.sort()) {
    const m = JSON.parse(readFileSync(join(d, 'metrics.json'), 'utf8'))
    if (onlyCase != null && m.case !== onlyCase) continue
    if (!wantAll && onlyCase == null && m.result !== 'fail') continue
    const ap = join(d, 'A.png')
    const bp = join(d, 'B.png')
    if (!existsSync(ap) || !existsSync(bp)) continue
    const A = decodePng(readFileSync(ap))
    const B = decodePng(readFileSync(bp))
    if (A.width !== B.width || A.height !== B.height) continue
    const { width: w, height: h } = A
    const a = luminance(A)
    const b = luminance(B)
    const cands = {
      identity: a,
      flipY: flipY(a, w, h),
      mirrorX: mirrorX(a, w, h),
      rot180: mirrorX(flipY(a, w, h), w, h)
    }
    if (wantTiles) {
      for (const n of [2, 3, 4]) {
        cands[`tileY/${n}col`] = perTileFlipY(a, w, h, n, 'col')
        cands[`tileY/${n}row`] = perTileFlipY(a, w, h, n, 'row')
      }
    }
    const scores = {}
    for (const [k, v] of Object.entries(cands)) scores[k] = correlation(v, b)
    const best = Object.keys(scores).reduce((p, k) =>
      (Number.isNaN(scores[k]) ? -2 : scores[k]) >
      (Number.isNaN(scores[p]) ? -2 : scores[p])
        ? k
        : p
    )
    rows.push({ phase: m.phase, case: m.case, ssim: m.ssim, scores, best })
  }

  if (rows.length === 0) {
    console.log('no comparable plates found')
    return 0
  }

  const keys = Object.keys(rows[0].scores)
  const pad = (s, n) => String(s).padEnd(n)
  const W = 11
  const num = v =>
    Number.isNaN(v) ? 'n/a'.padStart(W) : v.toFixed(4).padStart(W)
  console.log(
    pad('ph', 4) +
      pad('case', 26) +
      'ssim'.padStart(W) +
      keys.map(k => k.padStart(W)).join('') +
      '   best'
  )
  let flipped = 0
  for (const r of rows.sort((x, y) => x.ssim - y.ssim)) {
    const flag = r.best === 'identity' ? '' : '   <-- FLIP BEATS IDENTITY'
    if (r.best !== 'identity') flipped++
    console.log(
      pad(r.phase, 4) +
        pad(r.case, 26) +
        num(r.ssim) +
        keys.map(k => num(r.scores[k])).join('') +
        '   ' +
        r.best +
        flag
    )
  }
  console.log(
    `\n${rows.length} case(s); ${flipped} where a transform beats identity.`
  )
  if (flipped > 0) {
    console.log(
      'A flip beating identity means the disagreement is ORIENTATION, not content —\n' +
        'settle the direction against a third reference (sun, or a known asymmetric\n' +
        'feature) before hunting a mechanism.'
    )
    return 1
  }

  return 0
}

if (
  process.argv[1] != null &&
  import.meta.url.endsWith(basename(process.argv[1]))
) {
  process.exit(main())
}
