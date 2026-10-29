// Color space conversion utilities for parity metrics
// All inputs are linear RGB [0, 1]; outputs are sRGB or Lab as noted

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// D65 white point
const Xn = 0.95047
const Yn = 1.0
const Zn = 1.08883

function linearToXyz(
  r: number,
  g: number,
  b: number
): [number, number, number] {
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b
  return [x, y, z]
}

function labF(t: number): number {
  const d = 6 / 29
  return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29
}

export function linearRgbToLab(
  r: number,
  g: number,
  b: number
): [number, number, number] {
  const [x, y, z] = linearToXyz(r, g, b)
  const fx = labF(x / Xn)
  const fy = labF(y / Yn)
  const fz = labF(z / Zn)
  const L = 116 * fy - 16
  const a = 500 * (fx - fy)
  const bLab = 200 * (fy - fz)
  return [L, a, bLab]
}

// CIE ΔE2000, following Sharma, Wu, Dalal (2005)
export function deltaE2000(
  L1: number,
  a1: number,
  b1: number,
  L2: number,
  a2: number,
  b2: number
): number {
  const kL = 1
  const kC = 1
  const kH = 1

  const Cab1 = Math.sqrt(a1 * a1 + b1 * b1)
  const Cab2 = Math.sqrt(a2 * a2 + b2 * b2)
  const CabAvg = (Cab1 + Cab2) / 2
  const CabAvg7 = Math.pow(CabAvg, 7)
  const G = 0.5 * (1 - Math.sqrt(CabAvg7 / (CabAvg7 + 6103515625)))

  const ap1 = a1 * (1 + G)
  const ap2 = a2 * (1 + G)
  const Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1)
  const Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2)

  let hp1 = Math.atan2(b1, ap1)
  if (hp1 < 0) hp1 += 2 * Math.PI
  let hp2 = Math.atan2(b2, ap2)
  if (hp2 < 0) hp2 += 2 * Math.PI

  const dLp = L2 - L1
  const dCp = Cp2 - Cp1

  let dhp: number
  if (Cp1 * Cp2 === 0) {
    dhp = 0
  } else if (Math.abs(hp2 - hp1) <= Math.PI) {
    dhp = hp2 - hp1
  } else if (hp2 - hp1 > Math.PI) {
    dhp = hp2 - hp1 - 2 * Math.PI
  } else {
    dhp = hp2 - hp1 + 2 * Math.PI
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dhp / 2)

  const Lp = (L1 + L2) / 2
  const Cp = (Cp1 + Cp2) / 2

  let hp: number
  if (Cp1 * Cp2 === 0) {
    hp = hp1 + hp2
  } else if (Math.abs(hp1 - hp2) <= Math.PI) {
    hp = (hp1 + hp2) / 2
  } else if (hp1 + hp2 < 2 * Math.PI) {
    hp = (hp1 + hp2 + 2 * Math.PI) / 2
  } else {
    hp = (hp1 + hp2 - 2 * Math.PI) / 2
  }

  const T =
    1 -
    0.17 * Math.cos(hp - Math.PI / 6) +
    0.24 * Math.cos(2 * hp) +
    0.32 * Math.cos(3 * hp + Math.PI / 30) -
    0.2 * Math.cos(4 * hp - (63 * Math.PI) / 180)

  const Lp50sq = (Lp - 50) * (Lp - 50)
  const SL = 1 + (0.015 * Lp50sq) / Math.sqrt(20 + Lp50sq)
  const SC = 1 + 0.045 * Cp
  const SH = 1 + 0.015 * Cp * T

  const Cp7 = Math.pow(Cp, 7)
  const RT =
    -2 *
    Math.sqrt(Cp7 / (Cp7 + 6103515625)) *
    Math.sin(
      ((60 * Math.PI) / 180) *
        Math.exp(
          -Math.pow((hp - (275 * Math.PI) / 180) / ((25 * Math.PI) / 180), 2)
        )
    )

  const t1 = dLp / (kL * SL)
  const t2 = dCp / (kC * SC)
  const t3 = dHp / (kH * SH)

  return Math.sqrt(t1 * t1 + t2 * t2 + t3 * t3 + RT * t2 * t3)
}
