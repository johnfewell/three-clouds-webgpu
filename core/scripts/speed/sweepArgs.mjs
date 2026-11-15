// Side-effect-free argv and arm handling for sweep.mjs, so the parsing and
// the combination merge can be tested without starting Vite or Chrome

export const DEFAULT_CASES =
  'baseline-medium,sky-horizon-low-sun,shafts-low-sun,layers-4-shadow'
export const DEFAULT_SIZE = '2880x1800@2'

// One arm is a name plus the two ways to change state from the case's own:
// a named quality preset first, then a list of dotted paths to values
export const ARMS = [
  { id: 'base' },
  { id: 'preset-low', preset: 'low' },
  { id: 'preset-medium', preset: 'medium' },
  { id: 'preset-high', preset: 'high' },
  { id: 'temporalUpscale', set: [['temporalUpscale', true]] },
  { id: 'resolutionScale-0.75', set: [['resolutionScale', 0.75]] },
  { id: 'resolutionScale-0.5', set: [['resolutionScale', 0.5]] },
  { id: 'lightShafts-off', set: [['lightShafts', false]] },
  { id: 'lightShaftsHalfRes', set: [['lightShaftsHalfResolution', true]] },
  { id: 'shadow-128', set: [['shadow.mapSize', [128, 128]]] },
  { id: 'shadow-512', set: [['shadow.mapSize', [512, 512]]] },
  { id: 'cascades-2', set: [['shadow.cascadeCount', 2]] },
  { id: 'cascades-1', set: [['shadow.cascadeCount', 1]] },
  { id: 'shadowInterval-2', set: [['shadow.updateInterval', 2]] },
  { id: 'shadowInterval-4', set: [['shadow.updateInterval', 4]] },
  { id: 'shadowTemporal-off', set: [['shadow.temporalPass', false]] },
  { id: 'shadowIter-25', set: [['shadow.maxIterationCount', 25]] },
  { id: 'maxIter-250', set: [['clouds.maxIterationCount', 250]] },
  { id: 'maxIter-100', set: [['clouds.maxIterationCount', 100]] },
  { id: 'minStep-100', set: [['clouds.minStepSize', 100]] },
  { id: 'minStep-200', set: [['clouds.minStepSize', 200]] },
  { id: 'iterToSun-1', set: [['clouds.maxIterationCountToSun', 1]] },
  { id: 'iterToSun-0', set: [['clouds.maxIterationCountToSun', 0]] },
  { id: 'octaves-4', set: [['multiScatteringOctaves', 4]] },
  { id: 'shapeDetail-off', set: [['shapeDetail', false]] }
]

const POSITIVE_INT = /^[0-9]+$/

// What a combination file may hold. Anything else is refused loudly rather
// than reaching the page as a knob that silently does nothing
export function validateExtra(extra) {
  if (!Array.isArray(extra)) throw new Error('--extra must be a JSON array')
  const seen = new Set()
  for (const [i, arm] of extra.entries()) {
    if (arm == null || typeof arm !== 'object' || Array.isArray(arm))
      throw new Error(`--extra arm ${i} is not an object`)
    if (typeof arm.id !== 'string' || arm.id === '')
      throw new Error(`--extra arm ${i} has no string id`)
    if (seen.has(arm.id)) throw new Error(`--extra arm id ${arm.id} repeats`)
    seen.add(arm.id)
    if (arm.preset != null && typeof arm.preset !== 'string')
      throw new Error(`--extra arm ${arm.id} preset is not a string`)
    if (arm.set == null) continue
    if (!Array.isArray(arm.set))
      throw new Error(`--extra arm ${arm.id} set is not an array`)
    for (const entry of arm.set) {
      if (!Array.isArray(entry) || entry.length !== 2)
        throw new Error(`--extra arm ${arm.id} set entry is not [path, value]`)
      if (typeof entry[0] !== 'string' || entry[0] === '')
        throw new Error(`--extra arm ${arm.id} has an empty knob path`)
    }
  }
  return extra
}

// Ids to arms. A combined list may name a built-in arm and a combination arm
export function resolveArms(ids, extra = []) {
  const table = [...ARMS, ...extra]
  return ids.map(id => {
    const arm = table.find(a => a.id === id)
    if (arm == null) throw new Error(`unknown arm ${id}`)
    return arm
  })
}

// `2880x1800@2` -> physical pixels and device pixel ratio
export function parseSize(text) {
  const match = /^([0-9]+)x([0-9]+)(?:@([0-9.]+))?$/.exec(text)
  if (match == null) throw new Error(`bad size ${text}, expected WxH[@DPR]`)
  const [, w, h, dpr = '1'] = match
  const size = { w: Number(w), h: Number(h), dpr: Number(dpr) }
  if (!(size.w > 0) || !(size.h > 0) || !(size.dpr > 0))
    throw new Error(`bad size ${text}, every field must be positive`)
  return size
}

// The count guard: a run over zero inputs is a failed measurement
export function checkRunInputs({ cases, arms, reps }) {
  if (!Array.isArray(cases) || cases.length === 0)
    throw new Error('REFUSING: zero cases')
  if (!Array.isArray(arms) || arms.length === 0)
    throw new Error('REFUSING: zero arms')
  if (!Number.isInteger(reps) || reps < 1)
    throw new Error('REFUSING: zero repetitions')
  return { cases: cases.length, arms: arms.length, reps }
}

// A sweep is timed by default. --vsync measures a real app loop instead, in
// which case a measured window is needed rather than samples
export function timingMode(values) {
  const mode = values.vsync ? 'vsync' : 'timed'
  if (values.vsync) {
    const seconds = Number(values.seconds ?? '8')
    if (!(seconds > 0)) throw new Error('--seconds must be positive')
    const warmup = values.warmup == null ? 60 : Number(values.warmup)
    if (!(warmup >= 0)) throw new Error('--warmup must be zero or more')
    return { mode, seconds, warmup }
  }
  const warmup = values.warmup == null ? 40 : Number(values.warmup)
  const samples = values.samples == null ? 30 : Number(values.samples)
  if (!POSITIVE_INT.test(String(samples)) || !(samples > 0))
    throw new Error('--samples must be a positive integer')
  if (!(warmup >= 0)) throw new Error('--warmup must be zero or more')
  return { mode, warmup, samples }
}

// Rotation so that no arm always follows the same neighbour: a fixed offset
// per repetition and case, wrapped around the arm list
export function armOrder(arms, rep, caseIndex) {
  if (arms.length === 0) return []
  const offset = (rep * 7 + caseIndex * 3) % arms.length
  return [...arms.slice(offset), ...arms.slice(0, offset)]
}

// The median of a set of numbers, by value, averaging the middle pair
export function median(values) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

// The millisecond a frame's GPU time is quoted in: fast-clock work, from the
// probe that followed it (docs/BENCHMARKS.md "Clock State")
export const PROBE_FAST_MS = 0.4
