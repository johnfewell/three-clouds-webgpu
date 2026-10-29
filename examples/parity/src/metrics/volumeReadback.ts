// Byte-volume comparison for the p4 procedural shape readback
//. Both sides store the generated 128^3 shape
// as UnsignedByte, so agreement is measured in bytes: <= 1 means <= 1/255

/** FNV-1a 32-bit over the bytes, as 8 hex digits */
export function fnv1a32(bytes: ArrayLike<number>): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]! & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function compareVolumes(
  a: ArrayLike<number>,
  b: ArrayLike<number>
): { texels: number; maxAbs: number; differing: number } {
  if (a.length !== b.length) {
    throw new Error(`compareVolumes: sizes differ (${a.length} vs ${b.length})`)
  }
  if (a.length === 0) throw new Error('compareVolumes: empty volumes')
  let maxAbs = 0
  let differing = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d > 0) differing++
    if (d > maxAbs) maxAbs = d
  }
  return { texels: a.length, maxAbs, differing }
}

/** How much structure a byte volume has: a constant or blank read has 1 value */
export function byteSpread(bytes: ArrayLike<number>): {
  distinct: number
  min: number
  max: number
} {
  if (bytes.length === 0) throw new Error('byteSpread: empty volume')
  const seen = new Set<number>()
  let min = 255
  let max = 0
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]!
    seen.add(v)
    if (v < min) min = v
    if (v > max) max = v
  }
  return { distinct: seen.size, min, max }
}
