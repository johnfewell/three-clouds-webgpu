// Deterministic benchmark plans shared by the runner and comparison tooling

export const SCHEMA_VERSION = 1
export const PROTOCOL_VERSION = 'clouds-bench-v1'

export const EXPERIMENT_KEYS = Object.freeze([
  'cloudFrontRefinement',
  'computeResolve',
  'windReprojection',
  'distantCloudShadows',
  'directionalSkylight'
])

const LOCAL_CASES = Object.freeze([
  {
    caseName: 'baseline-medium',
    workloadId: 'static-medium',
    width: 1920,
    height: 1080,
    dpr: 1,
    motion: 'static',
    settings: {
      temporalUpscale: false,
      lightShafts: false,
      shadowTemporalPass: false,
      shadowUpdateInterval: 2
    }
  },
  {
    caseName: 'sky-horizon-low-sun',
    workloadId: 'horizon-low-sun',
    width: 1920,
    height: 1080,
    dpr: 1,
    motion: 'static',
    settings: {
      temporalUpscale: false,
      lightShafts: false,
      shadowTemporalPass: false,
      shadowUpdateInterval: 2
    }
  },
  {
    caseName: 'shafts-sky-horizon',
    workloadId: 'shafts-horizon',
    width: 1920,
    height: 1080,
    dpr: 1,
    motion: 'static',
    settings: {
      temporalUpscale: false,
      lightShafts: true,
      shadowTemporalPass: false,
      shadowUpdateInterval: 2
    }
  },
  {
    caseName: 'shadow-both-moving',
    workloadId: 'shadow-moving',
    width: 1920,
    height: 1080,
    dpr: 1,
    motion: 'shape',
    settings: {
      temporalUpscale: true,
      lightShafts: false,
      shadowTemporalPass: true,
      shadowUpdateInterval: 2
    }
  }
])

// shadowUpdateInterval: the port's shipping default, stated because parity case
// load pins side B to the reference's 1
const DEFAULT_CASES = LOCAL_CASES

const FULL_CASES = Object.freeze(
  LOCAL_CASES.flatMap(scene =>
    [false, true].flatMap(temporal =>
      ['static', 'shape'].map(motion => ({
        ...scene,
        workloadId: `${scene.workloadId}-temporal-${
          temporal ? 'on' : 'off'
        }-motion-${motion}`,
        motion,
        settings: { ...scene.settings, temporalUpscale: temporal }
      }))
    )
  )
)

function flags(enabled) {
  return Object.freeze(
    Object.fromEntries(EXPERIMENT_KEYS.map(key => [key, enabled === key]))
  )
}

export const DEFAULT_VARIANTS = Object.freeze([
  { id: 'baseline', experimental: flags(null) },
  ...EXPERIMENT_KEYS.map(key => ({ id: key, experimental: flags(key) })),
  {
    id: 'all-experiments',
    experimental: Object.freeze(
      Object.fromEntries(EXPERIMENT_KEYS.map(key => [key, true]))
    )
  },
  ...EXPERIMENT_KEYS.map(key => ({
    id: `all-minus-${key}`,
    experimental: Object.freeze(
      Object.fromEntries(EXPERIMENT_KEYS.map(other => [other, other !== key]))
    )
  }))
])

const SMOKE_VARIANTS = Object.freeze([DEFAULT_VARIANTS[0]])

export const FULL_VARIANTS = Object.freeze(
  Array.from({ length: 2 ** EXPERIMENT_KEYS.length }, (_, mask) => ({
    id: mask === 0 ? 'baseline' : `mask-${mask.toString(16).padStart(2, '0')}`,
    experimental: Object.freeze(
      Object.fromEntries(
        EXPERIMENT_KEYS.map((key, index) => [key, (mask & (1 << index)) !== 0])
      )
    )
  }))
)

export const PROFILES = Object.freeze({
  smoke: Object.freeze({ sampleFrames: 8, repeats: 1, warmupFrames: 8 }),
  standard: Object.freeze({ sampleFrames: 120, repeats: 3, warmupFrames: 64 }),
  full: Object.freeze({ sampleFrames: 120, repeats: 3, warmupFrames: 64 })
})

export const DEFAULT_PLAN = Object.freeze({
  id: 'portable-experiments-v1',
  profile: 'standard',
  schemaVersion: SCHEMA_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  seed: 0x51f15e,
  warmupFrames: 64,
  sampleFrames: 120,
  repeats: 3,
  cases: DEFAULT_CASES,
  variants: DEFAULT_VARIANTS,
  resolutions: Object.freeze([[1920, 1080]]),
  backends: Object.freeze(['webgl', 'webgpu'])
})

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function validateVariant(variant) {
  if (typeof variant?.id !== 'string' || variant.id.length === 0)
    throw new Error('variant id must be a non-empty string')
  for (const key of EXPERIMENT_KEYS) {
    if (typeof variant.experimental?.[key] !== 'boolean')
      throw new Error(`variant ${variant.id} is missing ${key}`)
  }
}

export function validatePlan(plan) {
  if (plan == null || typeof plan !== 'object')
    throw new Error('plan is required')
  if (plan.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`unsupported plan schemaVersion: ${plan.schemaVersion}`)
  if (plan.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`unsupported protocolVersion: ${plan.protocolVersion}`)
  if (!Number.isInteger(plan.seed)) throw new Error('seed must be an integer')
  if (!['smoke', 'standard', 'full'].includes(plan.profile))
    throw new Error(`unsupported profile: ${plan.profile}`)
  positiveInt(plan.warmupFrames, 'warmupFrames')
  positiveInt(plan.sampleFrames, 'sampleFrames')
  positiveInt(plan.repeats, 'repeats')
  if (!Array.isArray(plan.cases) || plan.cases.length === 0)
    throw new Error('plan must contain at least one case')
  for (const item of plan.cases) {
    if (typeof item?.caseName !== 'string' || item.caseName.length === 0)
      throw new Error('caseName must be a non-empty string')
    positiveInt(item.width, `${item.caseName}.width`)
    positiveInt(item.height, `${item.caseName}.height`)
    if (item.dpr !== 1)
      throw new Error(`${item.caseName}.dpr must be 1 (physical pixels)`)
    if (!['static', 'shape'].includes(item.motion))
      throw new Error(`${item.caseName}.motion must be static or shape`)
    if (item.settings == null || typeof item.settings !== 'object')
      throw new Error(`${item.caseName}.settings must be an object`)
    if (typeof item.workloadId !== 'string' || item.workloadId.length === 0)
      throw new Error(`${item.caseName}.workloadId must be a non-empty string`)
  }
  if (!Array.isArray(plan.resolutions) || plan.resolutions.length === 0)
    throw new Error('plan must contain at least one resolution')
  for (const resolution of plan.resolutions) {
    if (
      !Array.isArray(resolution) ||
      resolution.length !== 2 ||
      !Number.isInteger(resolution[0]) ||
      !Number.isInteger(resolution[1]) ||
      resolution[0] <= 0 ||
      resolution[1] <= 0
    )
      throw new Error('resolution must be a positive [width, height] pair')
  }
  if (!Array.isArray(plan.variants) || plan.variants.length === 0)
    throw new Error('plan must contain at least one variant')
  for (const variant of plan.variants) validateVariant(variant)
  if (!Array.isArray(plan.backends) || plan.backends.length === 0)
    throw new Error('plan must contain at least one backend')
  if (plan.backends.some(backend => !['webgl', 'webgpu'].includes(backend)))
    throw new Error('backend must be webgl or webgpu')
  for (const [name, ids] of [
    ['variants', plan.variants.map(variant => variant.id)],
    ['backends', plan.backends],
    [
      'workloads',
      plan.cases.map(scene =>
        JSON.stringify([
          scene.caseName,
          scene.workloadId,
          scene.width,
          scene.height
        ])
      )
    ]
  ]) {
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${name}`)
  }
  return plan
}

export function makePlan(overrides = {}) {
  const profile = overrides.profile ?? DEFAULT_PLAN.profile
  const profileConfig = PROFILES[profile]
  if (profileConfig == null) throw new Error(`unsupported profile: ${profile}`)
  const variants =
    overrides.variants ??
    (profile === 'smoke'
      ? SMOKE_VARIANTS
      : profile === 'full'
        ? FULL_VARIANTS
        : DEFAULT_VARIANTS)
  const cases =
    overrides.cases ??
    (profile === 'smoke'
      ? [{ ...LOCAL_CASES[0], width: 640, height: 360 }]
      : profile === 'full'
        ? FULL_CASES.flatMap(scene => [
            scene,
            { ...scene, width: 3840, height: 2160 }
          ])
        : LOCAL_CASES)
  const plan = {
    ...DEFAULT_PLAN,
    ...overrides,
    profile,
    cases,
    variants,
    warmupFrames: overrides.warmupFrames ?? profileConfig.warmupFrames,
    sampleFrames: overrides.sampleFrames ?? profileConfig.sampleFrames,
    repeats: overrides.repeats ?? profileConfig.repeats,
    resolutions:
      overrides.resolutions ??
      (profile === 'full'
        ? [
            [1920, 1080],
            [3840, 2160]
          ]
        : cases.length > 0
          ? [[cases[0].width, cases[0].height]]
          : []),
    backends: overrides.backends ?? DEFAULT_PLAN.backends
  }
  return validatePlan(plan)
}

// Mulberry32 gives a stable permutation without relying on runtime-specific RNG
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function scheduleFor(plan) {
  validatePlan(plan)
  const jobs = []
  for (let repetition = 0; repetition < plan.repeats; repetition++) {
    for (const scene of plan.cases) {
      for (const variant of plan.variants) {
        for (const backend of plan.backends) {
          jobs.push({ scene, variant, backend, repetition })
        }
      }
    }
  }
  const draw = random(plan.seed)
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(draw() * (i + 1))
    const current = jobs[i]
    jobs[i] = jobs[j]
    jobs[j] = current
  }
  return jobs.map((job, orderIndex) => ({ ...job, orderIndex }))
}

export function planFingerprint(plan) {
  validatePlan(plan)
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    protocolVersion: plan.protocolVersion,
    id: plan.id,
    profile: plan.profile,
    seed: plan.seed,
    warmupFrames: plan.warmupFrames,
    sampleFrames: plan.sampleFrames,
    repeats: plan.repeats,
    resolutions: plan.resolutions,
    cases: plan.cases,
    variants: plan.variants,
    backends: plan.backends
  })
}
