import {
  Camera,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  NoColorSpace,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  RGBAFormat,
  Uniform,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget
} from 'three'
import { LocalWeather as PortLocalWeather } from 'three-clouds-webgpu'
import {
  float,
  Fn,
  instanceIndex,
  int,
  ivec2,
  mix,
  sin,
  smoothstep,
  storageTexture,
  textureLoad,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import {
  RenderTarget,
  StorageTexture,
  WebGPURenderer,
  type ComputeNode,
  type Node
} from 'three/webgpu'

import { LocalWeather as ReferenceLocalWeather } from '@takram/three-clouds'

import {
  glslMod,
  hashOrders,
  LOW_FBM,
  MID_FBM,
  probeHash,
  probeValueNoise,
  probeWorley,
  probeWorleyArgmin,
  probeWorleyCellJitter,
  probeWorleyFbm,
  REFERENCE_WORLEY_ARGMIN_GLSL,
  REFERENCE_WORLEY_CELL_JITTER_GLSL
} from './localWeatherProbeGraphs'

const HASH_WIDTH = 256
const HASH_UNCOVERED_MIN = 12_288
const HASH_UNCOVERED_MAX = 21_888
const MID_WORLEY_PERIODS = [8, 16, 32, 64] as const
const VALUE_NOISE_HASH_OFFSETS = [0, 1, 57, 58, 113, 114, 170, 171]

function createHashArguments(): number[] {
  const argumentsSet = new Set<number>()

  // LilacOtter covered 0..12287. Extend only the unmeasured upper interval.
  for (let n = HASH_UNCOVERED_MIN; n <= HASH_UNCOVERED_MAX; n++) {
    argumentsSet.add(n)
  }

  // Mid weather evaluates point + vec3(0.5), and every period is even, so its
  // z base cell is period / 2. UV spans every x/y cell, and the Worley -1..1
  // neighbourhood visits every wrapped x/y and these three z cells
  for (const period of MID_WORLEY_PERIODS) {
    addTranslatedHashArguments(argumentsSet, period)
  }

  return [...argumentsSet].sort((a, b) => a - b)
}

function addTranslatedHashArguments(
  argumentsSet: Set<number>,
  period: number
): void {
  for (let x = 0; x < period; x++) {
    for (let y = 0; y < period; y++) {
      addTranslatedHashColumn(argumentsSet, period, x, y)
    }
  }
}

function addTranslatedHashColumn(
  argumentsSet: Set<number>,
  period: number,
  x: number,
  y: number
): void {
  for (let dz = -1; dz <= 1; dz++) {
    const z = (period / 2 + dz + period) % period
    const base = x + 57 * y + 113 * z
    for (const offset of VALUE_NOISE_HASH_OFFSETS) {
      argumentsSet.add(base + offset)
    }
  }
}

const HASH_ARGUMENTS = createHashArguments()
const HASH_SAMPLE_COUNT = HASH_ARGUMENTS.length
const HASH_HEIGHT = Math.ceil(HASH_SAMPLE_COUNT / HASH_WIDTH)
const HASH_TEXEL_COUNT = HASH_WIDTH * HASH_HEIGHT

interface ReferenceInternals {
  material: RawShaderMaterial
  renderTarget: WebGLRenderTarget
}

interface HashMeasurement {
  referenceReadback: Float32Array
  portReadback: Float32Array
  reference: HashSamples
  port: HashSamples
}

interface InputControlMeasurement {
  reference: Float32Array
  port: Float32Array
}

interface WeatherMeasurement {
  reference: Uint8Array
  port: Uint8Array
}

interface HashSamples {
  values: Float32Array
  missing: number
  argumentErrors: number
  coordinateErrors: number
}

interface DifferenceMetrics {
  count: number
  differing: number
  differingShare: number
  maxAbs: number
  meanAbs: number
  correlation: number
}

interface HashDomainMetrics extends DifferenceMetrics {
  name: string
  minArgument: number
  maxArgument: number
}

interface WeatherChannelMetrics extends DifferenceMetrics {
  channel: string
  meanA: number
  meanB: number
}

export interface LocalWeatherIntermediateProbeResult {
  adapter: string
  hashInputControl: {
    reference: Omit<HashSamples, 'values'>
    port: Omit<HashSamples, 'values'>
    indexAligned: boolean
  }
  hash: HashDomainMetrics[]
  localWeatherInputControl: WeatherChannelMetrics[]
  localWeather: {
    width: number
    height: number
    channels: WeatherChannelMetrics[]
  }
  // Arms 4-7, pre-registered with their controls and thresholds
  singleWorley: FloatRowMetrics[]
  composition: CompositionMetrics
  context: ContextMetrics
  topology: TopologyRowMetrics[]
  // Arm 8 (pre-registered 2026-09-02 01:05Z)
  argumentAssembly: AssemblyRowMetrics[]
  // Arm 9 (pre-registered 2026-09-02 01:15Z)
  perCell: PerCellRowMetrics[]
  // Arm 10 (pre-registered 2026-09-02 01:20Z)
  inMarchJitter: InMarchRowMetrics[]
  // Arm 11 (pre-registered 2026-09-02 01:22Z)
  parameterForm: ParamFormRowMetrics[]
  // Arm 12 (pre-registered 2026-09-02 01:36Z): side A only
  unrolledReference: UnrolledRowMetrics[]
}

function requireCanvas(id: string): HTMLCanvasElement {
  const canvas = document.querySelector(`#${id}`)
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(`Missing #${id} canvas`)
  }
  return canvas
}

function referenceInternals(
  weather: ReferenceLocalWeather
): ReferenceInternals {
  return {
    material: requireRuntimeField(weather, 'material'),
    renderTarget: requireRuntimeField(weather, 'renderTarget')
  }
}

function requireRuntimeField<T>(target: object, key: string): T {
  if (!Reflect.has(target, key)) {
    throw new Error(`Expected runtime field ${key}`)
  }
  return Reflect.get(target, key) as T
}

function portComputeNode(weather: PortLocalWeather): ComputeNode {
  return requireRuntimeField(weather, 'computeNode')
}

function createTextureReadTarget(
  texture: StorageTexture,
  width: number,
  height: number
): RenderTarget {
  const target = new RenderTarget(width, height)
  target.textures[0]?.dispose()
  target.textures[0] = texture
  return target
}

function configureFloatTexture(texture: StorageTexture): void {
  texture.type = FloatType
  texture.format = RGBAFormat
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
}

function createArgumentTexture(): DataTexture {
  const data = new Float32Array(HASH_TEXEL_COUNT)
  data.set(HASH_ARGUMENTS)
  data.fill(HASH_ARGUMENTS.at(-1) ?? 0, HASH_SAMPLE_COUNT)
  const texture = new DataTexture(
    data,
    HASH_WIDTH,
    HASH_HEIGHT,
    RedFormat,
    FloatType
  )
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}

async function renderReferenceHash(
  renderer: WebGLRenderer,
  weather: ReferenceLocalWeather
): Promise<Float32Array> {
  const source = referenceInternals(weather).material
  const mainIndex = source.fragmentShader.indexOf('void main()')
  if (mainIndex < 0) {
    throw new Error('Reference LocalWeather shader has no main()')
  }
  const argumentTexture = createArgumentTexture()

  // Keep the package's resolved hash() implementation verbatim. Only the main
  // function is diagnostic: R/G are the exact input/hash pair, B/A prove the
  // fragment-to-readback coordinate mapping independently of the hash result
  const material = new RawShaderMaterial({
    glslVersion: source.glslVersion,
    vertexShader: source.vertexShader,
    fragmentShader: `${source.fragmentShader.slice(0, mainIndex)}
uniform sampler2D probeArguments;
void main() {
  float x = floor(gl_FragCoord.x);
  float y = floor(gl_FragCoord.y);
  float n = texelFetch(probeArguments, ivec2(x, y), 0).r;
  outputColor = vec4(n, hash(n), x, y);
}
`,
    uniforms: {
      probeArguments: new Uniform(argumentTexture)
    }
  })
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  const target = new WebGLRenderTarget(HASH_WIDTH, HASH_HEIGHT, {
    depthBuffer: false,
    format: RGBAFormat,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter
  })
  target.texture.generateMipmaps = false
  target.texture.colorSpace = NoColorSpace

  try {
    renderer.setRenderTarget(target)
    renderer.render(mesh, new Camera())
    renderer.setRenderTarget(null)
    const result = new Float32Array(HASH_TEXEL_COUNT * 4)
    await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      HASH_WIDTH,
      HASH_HEIGHT,
      result
    )
    return result
  } finally {
    renderer.setRenderTarget(null)
    target.dispose()
    material.dispose()
    mesh.geometry.dispose()
    argumentTexture.dispose()
  }
}

async function renderPortHash(renderer: WebGPURenderer): Promise<Float32Array> {
  const texture = new StorageTexture(HASH_WIDTH, HASH_HEIGHT)
  configureFloatTexture(texture)
  const target = storageTexture(texture)
  const argumentTexture = createArgumentTexture()

  // This deliberately repeats the port's one-line hash expression instead of
  // reimplementing Worley. It isolates the backend sin() range reduction while
  // the real LocalWeather generators below arbitrate the composed result
  const computeNode = Fn(() => {
    const i = int(instanceIndex)
    const x = i.mod(HASH_WIDTH)
    const y = i.div(HASH_WIDTH)
    const n = textureLoad(argumentTexture, ivec2(x, y), int(0)).r
    const hashed = sin(n.add(1.951)).mul(43758.5453).fract()
    textureStore(target, ivec2(x, y), vec4(n, hashed, float(x), float(y)))
  })().compute(HASH_TEXEL_COUNT)

  try {
    await renderer.compute(computeNode)
    const readTarget = createTextureReadTarget(texture, HASH_WIDTH, HASH_HEIGHT)
    return (await renderer.readRenderTargetPixelsAsync(
      readTarget,
      0,
      0,
      HASH_WIDTH,
      HASH_HEIGHT
    )) as Float32Array
  } finally {
    texture.dispose()
    argumentTexture.dispose()
  }
}

async function renderReferenceFloatField(
  renderer: WebGLRenderer,
  weather: ReferenceLocalWeather,
  mainBody: string,
  // Spliced between the package's prelude and main(), so a helper can call the
  // package's own `noise`/`mod`/`getWorleyNoise` (arm 7)
  extraFunctions = '',
  // Runtime uniforms, so a value the compiler must not fold reaches the shader
  // as a binding rather than a literal (arm 11)
  uniforms: Record<string, Uniform> = {}
): Promise<Float32Array> {
  const size = weather.size
  const source = referenceInternals(weather).material
  const mainIndex = source.fragmentShader.indexOf('void main()')
  if (mainIndex < 0) {
    throw new Error('Reference LocalWeather shader has no main()')
  }
  const material = new RawShaderMaterial({
    glslVersion: source.glslVersion,
    vertexShader: source.vertexShader,
    fragmentShader: `${source.fragmentShader.slice(0, mainIndex)}
${extraFunctions}
void main() {
${mainBody}
}
`,
    uniforms
  })
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  const target = new WebGLRenderTarget(size, size, {
    depthBuffer: false,
    format: RGBAFormat,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter
  })
  target.texture.generateMipmaps = false
  target.texture.colorSpace = NoColorSpace

  try {
    renderer.setRenderTarget(target)
    renderer.render(mesh, new Camera())
    renderer.setRenderTarget(null)
    const result = new Float32Array(size * size * 4)
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size, result)
    return result
  } finally {
    renderer.setRenderTarget(null)
    target.dispose()
    material.dispose()
    mesh.geometry.dispose()
  }
}

async function renderPortFloatField(
  renderer: WebGPURenderer,
  size: number,
  generate: (uv: Node<'vec2'>) => Node<'vec4'>
): Promise<Float32Array> {
  const texture = new StorageTexture(size, size)
  configureFloatTexture(texture)
  const target = storageTexture(texture)
  const computeNode = Fn(() => {
    const i = int(instanceIndex)
    const x = i.mod(size)
    const y = i.div(size)
    const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(size)
    textureStore(target, ivec2(x, y), generate(uv))
  })().compute(size * size)

  try {
    await renderer.compute(computeNode)
    const readTarget = createTextureReadTarget(texture, size, size)
    return (await renderer.readRenderTargetPixelsAsync(
      readTarget,
      0,
      0,
      size,
      size
    )) as Float32Array
  } finally {
    texture.dispose()
  }
}

function indexHashSamples(data: Float32Array): HashSamples {
  const values = new Float32Array(HASH_SAMPLE_COUNT)
  values.fill(Number.NaN)
  let argumentErrors = 0
  let coordinateErrors = 0

  for (let index = 0; index < HASH_SAMPLE_COUNT; index++) {
    const offset = index * 4
    const n = data[offset]
    const hash = data[offset + 1]
    const x = data[offset + 2]
    const y = data[offset + 3]
    if (n == null || hash == null || x == null || y == null) {
      throw new Error(`Incomplete hash readback at float offset ${offset}`)
    }
    if (n !== HASH_ARGUMENTS[index]) argumentErrors++
    if (x !== index % HASH_WIDTH || y !== Math.floor(index / HASH_WIDTH)) {
      coordinateErrors++
    }
    values[index] = hash
  }

  let missing = 0
  for (const value of values) {
    if (Number.isNaN(value)) missing++
  }
  return { values, missing, argumentErrors, coordinateErrors }
}

function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Number.NaN
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < a.length; i++) {
    meanA += a[i] ?? 0
    meanB += b[i] ?? 0
  }
  meanA /= a.length
  meanB /= b.length

  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let i = 0; i < a.length; i++) {
    const da = (a[i] ?? 0) - meanA
    const db = (b[i] ?? 0) - meanB
    covariance += da * db
    varianceA += da * da
    varianceB += db * db
  }
  return covariance / Math.sqrt(varianceA * varianceB)
}

function differenceMetrics(
  a: ArrayLike<number>,
  b: ArrayLike<number>
): DifferenceMetrics {
  if (a.length !== b.length) {
    throw new Error(`Readback length mismatch: ${a.length} vs ${b.length}`)
  }
  let differing = 0
  let maxAbs = 0
  let sumAbs = 0
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs((a[i] ?? 0) - (b[i] ?? 0))
    if (diff !== 0) differing++
    maxAbs = Math.max(maxAbs, diff)
    sumAbs += diff
  }
  return {
    count: a.length,
    differing,
    differingShare: differing / a.length,
    maxAbs,
    meanAbs: sumAbs / a.length,
    correlation: correlation(a, b)
  }
}

function hashDomainMetrics(
  reference: Float32Array,
  port: Float32Array
): HashDomainMetrics[] {
  const groups = [
    {
      name: 'translated-point-plus-0.5-lattices',
      includes: (n: number) => n < HASH_UNCOVERED_MIN
    },
    {
      name: 'uncovered-12288-through-21888',
      includes: (n: number) => n >= HASH_UNCOVERED_MIN
    }
  ]
  return groups.map(({ name, includes }) => {
    const argumentsInGroup: number[] = []
    const referenceInGroup: number[] = []
    const portInGroup: number[] = []
    HASH_ARGUMENTS.forEach((argument, index) => {
      if (!includes(argument)) return
      argumentsInGroup.push(argument)
      referenceInGroup.push(reference[index] ?? Number.NaN)
      portInGroup.push(port[index] ?? Number.NaN)
    })
    return {
      name,
      minArgument: Math.min(...argumentsInGroup),
      maxArgument: Math.max(...argumentsInGroup),
      ...differenceMetrics(referenceInGroup, portInGroup)
    }
  })
}

function nonHashChannelsAlign(
  reference: Float32Array,
  port: Float32Array
): boolean {
  for (let index = 0; index < HASH_SAMPLE_COUNT; index++) {
    const offset = index * 4
    if (
      reference[offset] !== port[offset] ||
      reference[offset + 2] !== port[offset + 2] ||
      reference[offset + 3] !== port[offset + 3]
    ) {
      return false
    }
  }
  return true
}

function weatherChannelMetrics(
  reference: Uint8Array,
  port: Uint8Array,
  channelIndex: number,
  channel: string
): WeatherChannelMetrics {
  const count = reference.length / 4
  const a = new Float32Array(count)
  const b = new Float32Array(count)
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < count; i++) {
    const av = (reference[i * 4 + channelIndex] ?? 0) / 255
    const bv = (port[i * 4 + channelIndex] ?? 0) / 255
    a[i] = av
    b[i] = bv
    sumA += av
    sumB += bv
  }
  return {
    channel,
    meanA: sumA / count,
    meanB: sumB / count,
    ...differenceMetrics(a, b)
  }
}

function floatChannelMetrics(
  reference: Float32Array,
  port: Float32Array,
  channelIndex: number,
  channel: string
): WeatherChannelMetrics {
  const count = reference.length / 4
  const a = new Float32Array(count)
  const b = new Float32Array(count)
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < count; i++) {
    const av = reference[i * 4 + channelIndex] ?? Number.NaN
    const bv = port[i * 4 + channelIndex] ?? Number.NaN
    a[i] = av
    b[i] = bv
    sumA += av
    sumB += bv
  }
  return {
    channel,
    meanA: sumA / count,
    meanB: sumB / count,
    ...differenceMetrics(a, b)
  }
}

async function readReferenceWeather(
  renderer: WebGLRenderer,
  weather: ReferenceLocalWeather
): Promise<Uint8Array> {
  weather.render(renderer)
  const { renderTarget } = referenceInternals(weather)
  const result = new Uint8Array(weather.size * weather.size * 4)
  await renderer.readRenderTargetPixelsAsync(
    renderTarget,
    0,
    0,
    weather.size,
    weather.size,
    result
  )
  return result
}

async function readPortWeather(
  renderer: WebGPURenderer,
  weather: PortLocalWeather
): Promise<Uint8Array> {
  await renderer.compute(portComputeNode(weather))
  weather.needsRender = false
  const readTarget = createTextureReadTarget(
    weather.texture,
    weather.size,
    weather.size
  )
  return (await renderer.readRenderTargetPixelsAsync(
    readTarget,
    0,
    0,
    weather.size,
    weather.size
  )) as Uint8Array
}

// Arms 4-7 (pre-registered 2026-09-01 21:15Z). Side A runs
// the package's own shader prelude with a custom main(), side B the probe-local
// TSL twin, validated by arm 5 before any A-vs-B row is read

interface FloatRowMetrics {
  name: string
  cellCount: number
  offset: number
  value: WeatherChannelMetrics
  // Channels 1..3 echo the input point. They must be bit-identical, or the two
  // sides were asked different questions and the row is void
  inputEcho: WeatherChannelMetrics[]
}

interface QuantizedControl {
  channel: string
  // Largest |round(float * 255) - byte| over the texture, in 8-bit counts
  maxCounts: number
  withinOneCountShare: number
  exactShare: number
}

interface CompositionMetrics {
  // rawMid, rawLow, smoothMid, smoothLow: A vs B on the float intermediates
  channels: WeatherChannelMetrics[]
  controls: {
    // The spliced main composed to RGBA8 vs the package's real target (A)
    referenceVsPackage: QuantizedControl[]
    // The TSL twin composed to RGBA8 vs the package's real target (B)
    portVsPackage: QuantizedControl[]
  }
}

interface GiantShaderSideMetrics {
  // The identical single expression, evaluated inside the giant composition
  // shader vs alone in arm 4's small shader, on the SAME side
  worley8GiantVsAlone: DifferenceMetrics
  worley16GiantVsAlone: DifferenceMetrics
  // The fbm written out by hand from shared octave nodes vs the side's own fbm
  // function, in the same shader: a within-side copy-vs-copy reading
  manualVsFunctionFbm: DifferenceMetrics
}

interface ContextMetrics {
  octaves: Array<{ octaves: number; value: WeatherChannelMetrics }>
  aloneVsTogether: {
    reference: WeatherChannelMetrics
    port: WeatherChannelMetrics
    togetherAB: WeatherChannelMetrics
  }
  // Arm 6b (pre-registered 22:55Z): channels of one dispatch per
  // side are (worley8 on p+0.5, worley16 on p, rawMid by hand, rawMid by fbm)
  giant: {
    reference: GiantShaderSideMetrics
    port: GiantShaderSideMetrics
    crossAB: WeatherChannelMetrics[]
  }
}

interface TopologyRowMetrics {
  name: string
  cellCount: number
  offset: number
  value: WeatherChannelMetrics
  argmin: WeatherChannelMetrics
  jitter: WeatherChannelMetrics
  // The argmin twin's value against the plain worley on the SAME side
  controls: { reference: DifferenceMetrics; port: DifferenceMetrics }
}

interface FbmParameters {
  frequency: number
  amplitude: number
  lacunarity: number
  gain: number
}

const SINGLE_WORLEY_ROWS = [8, 16, 32, 64, 128].flatMap(cellCount =>
  [0, 0.5].map(offset => ({ cellCount, offset }))
)
const TOPOLOGY_ROWS = [
  { cellCount: 8, offset: 0.5 },
  { cellCount: 16, offset: 0 }
]

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

// `+ vec3(0.0)` is omitted rather than emitted, so the offset-0 rows keep the
// same program shape as the package's low channel on both sides
function referencePoint(offset: number): string {
  const base = 'vec3(vUv.x, vUv.y, 0.0)'
  return offset === 0 ? base : `${base} + vec3(${glslFloat(offset)})`
}

function portPoint(uv: Node<'vec2'>, offset: number): Node<'vec3'> {
  const base = vec3(uv.x, uv.y, 0)
  return offset === 0 ? base : base.add(vec3(offset))
}

function fbmGlsl(point: string, fbm: FbmParameters, octaves: number): string {
  return `getWorleyFbm(${point}, ${glslFloat(fbm.frequency)}, ${fbm.amplitude}, ${glslFloat(fbm.lacunarity)}, ${fbm.gain}, ${octaves})`
}

function portFbm(
  point: Node<'vec3'>,
  fbm: FbmParameters,
  octaves: number
): Node<'float'> {
  return probeWorleyFbm(
    point,
    fbm.frequency,
    fbm.amplitude,
    fbm.lacunarity,
    fbm.gain,
    octaves
  )
}

function channelPairMetrics(
  field: Float32Array,
  a: number,
  b: number
): DifferenceMetrics {
  const count = field.length / 4
  const left = new Float32Array(count)
  const right = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    left[i] = field[i * 4 + a] ?? Number.NaN
    right[i] = field[i * 4 + b] ?? Number.NaN
  }
  return differenceMetrics(left, right)
}

function quantizedControl(
  expected: Float32Array,
  actual: Uint8Array,
  channelIndex: number,
  channel: string
): QuantizedControl {
  const count = actual.length / 4
  let maxCounts = 0
  let withinOne = 0
  let exact = 0
  for (let i = 0; i < count; i++) {
    const value = Math.min(1, Math.max(0, expected[i] ?? Number.NaN))
    const counts = Math.abs(
      Math.round(value * 255) - (actual[i * 4 + channelIndex] ?? 0)
    )
    if (Number.isNaN(counts)) {
      maxCounts = Number.POSITIVE_INFINITY
      continue
    }
    maxCounts = Math.max(maxCounts, counts)
    if (counts <= 1) withinOne++
    if (counts === 0) exact++
  }
  return {
    channel,
    maxCounts,
    withinOneCountShare: withinOne / count,
    exactShare: exact / count
  }
}

// R = saturate(smoothLow - smoothMid), G = smoothMid (localWeather.frag:32-58),
// composed from the float intermediates (rawMid, rawLow, smoothMid, smoothLow)
function composedChannels(field: Float32Array): {
  red: Float32Array
  green: Float32Array
} {
  const count = field.length / 4
  const red = new Float32Array(count)
  const green = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const smoothMid = field[i * 4 + 2] ?? Number.NaN
    const smoothLow = field[i * 4 + 3] ?? Number.NaN
    green[i] = smoothMid
    red[i] = Math.min(1, Math.max(0, smoothLow - smoothMid))
  }
  return { red, green }
}

interface SingleWorleyFields {
  reference: Map<string, Float32Array>
  port: Map<string, Float32Array>
}

function rowName(cellCount: number, offset: number): string {
  return `worley-c${cellCount}-o${offset}`
}

// Arm 4: one worley per shader, both sides, value + input echo. The raw fields
// of the two rows arm 6b re-evaluates inside the giant shader are kept
async function measureSingleWorley(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number
): Promise<{ rows: FloatRowMetrics[]; fields: SingleWorleyFields }> {
  const rows: FloatRowMetrics[] = []
  const fields: SingleWorleyFields = { reference: new Map(), port: new Map() }
  for (const { cellCount, offset } of SINGLE_WORLEY_ROWS) {
    const reference = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `  vec3 p = ${referencePoint(offset)};
  outputColor = vec4(getWorleyNoise(p, ${glslFloat(cellCount)}), p);`
    )
    const port = await renderPortFloatField(portRenderer, size, uv => {
      const p = portPoint(uv, offset)
      return vec4(probeWorley(p, float(cellCount)), p.x, p.y, p.z)
    })
    const name = rowName(cellCount, offset)
    rows.push({
      name,
      cellCount,
      offset,
      value: floatChannelMetrics(reference, port, 0, 'worley'),
      inputEcho: ['p.x', 'p.y', 'p.z'].map((label, index) =>
        floatChannelMetrics(reference, port, index + 1, label)
      )
    })
    if (
      TOPOLOGY_ROWS.some(r => r.cellCount === cellCount && r.offset === offset)
    ) {
      fields.reference.set(name, reference)
      fields.port.set(name, port)
    }
  }
  return { rows, fields }
}

// Arm 6b: the same worley expression inside the giant composition shader. Both
// sides emit worley8/16, rawMid by hand and rawMid by their own fbm from ONE
// shader, so the compiler sees the full program
const MID_AMPLITUDES = [0.4, 0.38, 0.361, 0.34295] as const

async function measureGiantShader(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number,
  single: SingleWorleyFields
): Promise<ContextMetrics['giant']> {
  const [a1, a2, a3, a4] = MID_AMPLITUDES
  const reference = await renderReferenceFloatField(
    referenceRenderer,
    referenceWeather,
    `  vec3 point = vec3(vUv.x, vUv.y, 0.0);
  vec3 p8 = point + vec3(0.5);
  float o1 = getWorleyNoise(p8, 8.0);
  float o2 = getWorleyNoise(p8, 16.0);
  float o3 = getWorleyNoise(p8, 32.0);
  float o4 = getWorleyNoise(p8, 64.0);
  float manual = (((0.0 + ${a1} * (1.0 - o1)) + ${a2} * (1.0 - o2)) + ${a3} * (1.0 - o3)) + ${a4} * (1.0 - o4);
  float fbm = ${fbmGlsl('p8', MID_FBM, MID_FBM.octaves)};
  outputColor = vec4(o1, getWorleyNoise(point, 16.0), manual, fbm);`
  )
  const port = await renderPortFloatField(portRenderer, size, uv => {
    const point = vec3(uv.x, uv.y, 0)
    const p8 = point.add(vec3(0.5))
    const octaves = [8, 16, 32, 64].map(c => probeWorley(p8, float(c)))
    let manual: Node<'float'> = float(0)
    octaves.forEach((o, i) => {
      manual = manual.add(
        float(1)
          .sub(o)
          .mul(MID_AMPLITUDES[i] ?? 0)
      )
    })
    const fbm = portFbm(p8, MID_FBM, MID_FBM.octaves)
    return vec4(octaves[0]!, probeWorley(point, float(16)), manual, fbm)
  })
  const side = (
    giant: Float32Array,
    fields: Map<string, Float32Array>
  ): GiantShaderSideMetrics => {
    const alone8 = fields.get(rowName(8, 0.5))
    const alone16 = fields.get(rowName(16, 0))
    if (alone8 == null || alone16 == null) {
      throw new Error('Arm 6b needs arm 4 rows (8, 0.5) and (16, 0)')
    }
    return {
      worley8GiantVsAlone: differenceMetrics(
        channelOf(giant, 0),
        channelOf(alone8, 0)
      ),
      worley16GiantVsAlone: differenceMetrics(
        channelOf(giant, 1),
        channelOf(alone16, 0)
      ),
      manualVsFunctionFbm: channelPairMetrics(giant, 2, 3)
    }
  }
  return {
    reference: side(reference, single.reference),
    port: side(port, single.port),
    crossAB: [
      'worley8-in-giant',
      'worley16-in-giant',
      'raw-mid-manual',
      'raw-mid-fbm'
    ].map((name, index) => floatChannelMetrics(reference, port, index, name))
  }
}

function channelOf(field: Float32Array, channel: number): Float32Array {
  const count = field.length / 4
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = field[i * 4 + channel] ?? Number.NaN
  return out
}

interface CompositionFields {
  reference: Float32Array
  port: Float32Array
}

// Arm 5: the full composition in one shader per side, float intermediates,
// with the self-consistency controls against the package's real targets
async function measureComposition(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number,
  weather: WeatherMeasurement
): Promise<{ fields: CompositionFields; metrics: CompositionMetrics }> {
  const reference = await renderReferenceFloatField(
    referenceRenderer,
    referenceWeather,
    `  vec3 point = vec3(vUv.x, vUv.y, 0.0);
  float rawMid = ${fbmGlsl('point + vec3(0.5)', MID_FBM, MID_FBM.octaves)};
  float rawLow = ${fbmGlsl('point', LOW_FBM, LOW_FBM.octaves)};
  outputColor = vec4(rawMid, rawLow, smoothstep(1.0, 1.4, rawMid), smoothstep(0.8, 1.4, rawLow));`
  )
  const port = await renderPortFloatField(portRenderer, size, uv => {
    const point = vec3(uv.x, uv.y, 0)
    const rawMid = portFbm(point.add(vec3(0.5)), MID_FBM, MID_FBM.octaves)
    const rawLow = portFbm(point, LOW_FBM, LOW_FBM.octaves)
    return vec4(
      rawMid,
      rawLow,
      smoothstep(float(1), float(1.4), rawMid),
      smoothstep(float(0.8), float(1.4), rawLow)
    )
  })
  const names = ['raw-mid', 'raw-low', 'smooth-mid', 'smooth-low']
  const referenceComposed = composedChannels(reference)
  const portComposed = composedChannels(port)
  return {
    fields: { reference, port },
    metrics: {
      channels: names.map((name, index) =>
        floatChannelMetrics(reference, port, index, name)
      ),
      controls: {
        referenceVsPackage: [
          quantizedControl(
            referenceComposed.red,
            weather.reference,
            0,
            'low-composed-r'
          ),
          quantizedControl(
            referenceComposed.green,
            weather.reference,
            1,
            'mid-worley-g'
          )
        ],
        portVsPackage: [
          quantizedControl(portComposed.red, weather.port, 0, 'low-composed-r'),
          quantizedControl(portComposed.green, weather.port, 1, 'mid-worley-g')
        ]
      }
    }
  }
}

// Arm 6: mid raw fbm at k = 1..4 octaves as separate shaders, and the
// 4-octave field alone against the same field computed together with low
async function measureContext(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number,
  composition: CompositionFields,
  single: SingleWorleyFields
): Promise<ContextMetrics> {
  const octaves: ContextMetrics['octaves'] = []
  let referenceAlone: Float32Array | null = null
  let portAlone: Float32Array | null = null
  for (let k = 1; k <= MID_FBM.octaves; k++) {
    const reference = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `  vec3 point = vec3(vUv.x, vUv.y, 0.0);
  outputColor = vec4(${fbmGlsl('point + vec3(0.5)', MID_FBM, k)}, 0.0, 0.0, 1.0);`
    )
    const port = await renderPortFloatField(portRenderer, size, uv => {
      const point = vec3(uv.x, uv.y, 0)
      return vec4(portFbm(point.add(vec3(0.5)), MID_FBM, k), 0, 0, 1)
    })
    octaves.push({
      octaves: k,
      value: floatChannelMetrics(reference, port, 0, `raw-mid-${k}-octaves`)
    })
    if (k === MID_FBM.octaves) {
      referenceAlone = reference
      portAlone = port
    }
  }
  if (referenceAlone == null || portAlone == null) {
    throw new Error('Context arm produced no 4-octave field')
  }
  const giant = await measureGiantShader(
    referenceRenderer,
    portRenderer,
    referenceWeather,
    size,
    single
  )
  return {
    octaves,
    giant,
    aloneVsTogether: {
      reference: floatChannelMetrics(
        referenceAlone,
        composition.reference,
        0,
        'raw-mid-alone-vs-together-A'
      ),
      port: floatChannelMetrics(
        portAlone,
        composition.port,
        0,
        'raw-mid-alone-vs-together-B'
      ),
      togetherAB: floatChannelMetrics(
        composition.reference,
        composition.port,
        0,
        'raw-mid-together-A-vs-B'
      )
    }
  }
}

// Arm 7: which cell wins and with what jitter, on both sides, with the
// bookkeeping twin checked against the plain worley on its own side
async function measureTopology(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number
): Promise<TopologyRowMetrics[]> {
  const rows: TopologyRowMetrics[] = []
  for (const { cellCount, offset } of TOPOLOGY_ROWS) {
    const reference = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `  vec3 p = ${referencePoint(offset)};
  vec4 r = probeWorleyArgmin(p, ${glslFloat(cellCount)});
  outputColor = vec4(r.x, r.y, r.z, getWorleyNoise(p, ${glslFloat(cellCount)}));`,
      REFERENCE_WORLEY_ARGMIN_GLSL
    )
    const port = await renderPortFloatField(portRenderer, size, uv => {
      const p = portPoint(uv, offset)
      const r = probeWorleyArgmin(p, float(cellCount))
      return vec4(r.x, r.y, r.z, probeWorley(p, float(cellCount)))
    })
    rows.push({
      name: `argmin-c${cellCount}-o${offset}`,
      cellCount,
      offset,
      value: floatChannelMetrics(reference, port, 0, 'worley'),
      argmin: floatChannelMetrics(reference, port, 1, 'argmin-cell'),
      jitter: floatChannelMetrics(reference, port, 2, 'winning-jitter'),
      controls: {
        reference: channelPairMetrics(reference, 0, 3),
        port: channelPairMetrics(port, 0, 3)
      }
    })
  }
  return rows
}

interface OrderMatches {
  t1: DifferenceMetrics
  t2: DifferenceMetrics
  t3: DifferenceMetrics
}

interface AssemblyRowMetrics {
  name: string
  cellCount: number
  offset: number
  // Dispatch 1, A vs B: the jitter (the side's own valueNoise at the wrapped
  // integer cell), the in-shader n, the fract sum, and hash(n + 0)
  jitter: WeatherChannelMetrics
  n: WeatherChannelMetrics
  fract: WeatherChannelMetrics
  hash0: WeatherChannelMetrics
  // Dispatch 2, A vs B, the same association order on both sides
  orders: {
    t1: WeatherChannelMetrics
    t2: WeatherChannelMetrics
    t3: WeatherChannelMetrics
  }
  // Which order on the OTHER side reproduces this side's jitter
  matches: {
    referenceJitterVsPortOrders: OrderMatches
    portJitterVsReferenceOrders: OrderMatches
  }
  // Does the association matter within one side at all
  withinSide: {
    reference: { t1VsT2: DifferenceMetrics; t1VsT3: DifferenceMetrics }
    port: { t1VsT2: DifferenceMetrics; t1VsT3: DifferenceMetrics }
  }
  controls: {
    nIdentical: boolean
    fractMaxReference: number
    fractMaxPort: number
  }
}

const ASSEMBLY_ROWS = [
  { cellCount: 16, offset: 0 },
  { cellCount: 8, offset: 0 },
  { cellCount: 8, offset: 0.5 }
]

function channelMaxAbs(field: Float32Array, channel: number): number {
  const count = field.length / 4
  let max = 0
  for (let i = 0; i < count; i++) {
    const v = Math.abs(field[i * 4 + channel] ?? Number.NaN)
    if (Number.isNaN(v)) return Number.POSITIVE_INFINITY
    if (v > max) max = v
  }
  return max
}

function crossChannelMetrics(
  a: Float32Array,
  aChannel: number,
  b: Float32Array,
  bChannel: number
): DifferenceMetrics {
  return differenceMetrics(channelOf(a, aChannel), channelOf(b, bChannel))
}

// The wrapped z-1 neighbour cell of the base cell, as worley visits it
function referenceCellGlsl(cellCount: number, offset: number): string {
  return `  vec3 p = ${referencePoint(offset)};
  vec3 cell = p * ${glslFloat(cellCount)};
  vec3 tp = floor(cell) + vec3(0.0, 0.0, -1.0);
  vec3 q = mod(tp, ${glslFloat(cellCount)});
  float n = q.x + q.y * 57.0 + 113.0 * q.z;`
}

function portCell(
  uv: Node<'vec2'>,
  cellCount: number,
  offset: number
): Node<'vec3'> {
  const p = portPoint(uv, offset)
  const cell = p.mul(cellCount)
  const tp = cell.floor().add(vec3(0, 0, -1))
  return glslMod(tp, float(cellCount))
}

// Arm 8: is the divergence the in-shader assembly of the hash argument?
async function measureArgumentAssembly(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number
): Promise<AssemblyRowMetrics[]> {
  const rows: AssemblyRowMetrics[] = []
  for (const { cellCount, offset } of ASSEMBLY_ROWS) {
    const reference1 = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `${referenceCellGlsl(cellCount, offset)}
  float fr = fract(q).x + fract(q).y + fract(q).z;
  outputColor = vec4(noise(q), n, fr, hash(n + 0.0));`
    )
    const port1 = await renderPortFloatField(portRenderer, size, uv => {
      const q = portCell(uv, cellCount, offset)
      const n = q.x.add(q.y.mul(57)).add(q.z.mul(113))
      const f = q.fract()
      const fr = f.x.add(f.y).add(f.z)
      return vec4(probeValueNoise(q), n, fr, probeHash(n.add(0)))
    })
    const reference2 = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `${referenceCellGlsl(cellCount, offset)}
  float t1 = fract(sin(((q.x + q.y * 57.0) + 113.0 * q.z) + 1.951) * 43758.5453);
  float t2 = fract(sin((q.x + q.y * 57.0) + (113.0 * q.z + 1.951)) * 43758.5453);
  float t3 = fract(sin(q.x + (q.y * 57.0 + (113.0 * q.z + 1.951))) * 43758.5453);
  outputColor = vec4(t1, t2, t3, noise(q));`
    )
    const port2 = await renderPortFloatField(portRenderer, size, uv => {
      const q = portCell(uv, cellCount, offset)
      const { t1, t2, t3 } = hashOrders(q)
      return vec4(t1, t2, t3, probeValueNoise(q))
    })
    const nMetrics = floatChannelMetrics(reference1, port1, 1, 'n-in-shader')
    rows.push({
      name: `assembly-c${cellCount}-o${offset}`,
      cellCount,
      offset,
      jitter: floatChannelMetrics(reference1, port1, 0, 'jitter-valueNoise'),
      n: nMetrics,
      fract: floatChannelMetrics(reference1, port1, 2, 'fract-sum'),
      hash0: floatChannelMetrics(reference1, port1, 3, 'hash-n-plus-0'),
      orders: {
        t1: floatChannelMetrics(reference2, port2, 0, 't1-literal-order'),
        t2: floatChannelMetrics(reference2, port2, 1, 't2-z-first'),
        t3: floatChannelMetrics(reference2, port2, 2, 't3-right-assoc')
      },
      matches: {
        referenceJitterVsPortOrders: {
          t1: crossChannelMetrics(reference2, 3, port2, 0),
          t2: crossChannelMetrics(reference2, 3, port2, 1),
          t3: crossChannelMetrics(reference2, 3, port2, 2)
        },
        portJitterVsReferenceOrders: {
          t1: crossChannelMetrics(port2, 3, reference2, 0),
          t2: crossChannelMetrics(port2, 3, reference2, 1),
          t3: crossChannelMetrics(port2, 3, reference2, 2)
        }
      },
      withinSide: {
        reference: {
          t1VsT2: channelPairMetrics(reference2, 0, 1),
          t1VsT3: channelPairMetrics(reference2, 0, 2)
        },
        port: {
          t1VsT2: channelPairMetrics(port2, 0, 1),
          t1VsT3: channelPairMetrics(port2, 0, 2)
        }
      },
      controls: {
        nIdentical: nMetrics.differing === 0,
        fractMaxReference: channelMaxAbs(reference1, 2),
        fractMaxPort: channelMaxAbs(port1, 2)
      }
    })
  }
  return rows
}

interface PerCellMetrics {
  index: number
  offset: [number, number, number]
  value: WeatherChannelMetrics
}

interface PerCellRowMetrics {
  name: string
  cellCount: number
  offset: number
  // D1..D7: every neighbour cell's jitter, A vs B, in worley's visiting order
  cells: PerCellMetrics[]
  // D8 at the z-1 cell: [mix(h0, h1, 0.0), h0, noise(q), h1]
  mixControl: {
    crossAB: WeatherChannelMetrics[]
    within: {
      reference: { mixVsH0: DifferenceMetrics; noiseVsH0: DifferenceMetrics }
      port: { mixVsH0: DifferenceMetrics; noiseVsH0: DifferenceMetrics }
    }
  }
  // D9 at the z-1 cell: [noise(q) via the function, the same body inline, n, fract-sum]
  functionVsInline: {
    crossAB: WeatherChannelMetrics[]
    within: { reference: DifferenceMetrics; port: DifferenceMetrics }
  }
  controls: {
    nIdentical: boolean
    fractMaxReference: number
    fractMaxPort: number
  }
}

const PER_CELL_ROWS = [
  { cellCount: 16, offset: 0 },
  { cellCount: 8, offset: 0.5 }
]

// The 27 offsets in worley's visiting order (x outer, y, z inner)
const CELL_OFFSETS: Array<[number, number, number]> = []
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) CELL_OFFSETS.push([x, y, z])
  }
}

function glslVec3(v: [number, number, number]): string {
  return `vec3(${v.map(glslFloat).join(', ')})`
}

// The reference's noise() body written inline, so the function-call form can
// be compared with its own body on the same side (D9)
const REFERENCE_NOISE_INLINE_GLSL = `  vec3 pp = floor(q);
  vec3 ff = fract(q);
  ff = ff * ff * (3.0 - 2.0 * ff);
  float nn = pp.x + pp.y * 57.0 + 113.0 * pp.z;
  float inl = mix(
    mix(mix(hash(nn + 0.0), hash(nn + 1.0), ff.x), mix(hash(nn + 57.0), hash(nn + 58.0), ff.x), ff.y),
    mix(mix(hash(nn + 113.0), hash(nn + 114.0), ff.x), mix(hash(nn + 170.0), hash(nn + 171.0), ff.x), ff.y),
    ff.z
  );`

function portNoiseInline(q: Node<'vec3'>): Node<'float'> {
  const pp = q.floor()
  const f0 = q.fract()
  const ff = f0.mul(f0).mul(float(3).sub(f0.mul(2)))
  const nn = pp.x.add(pp.y.mul(57)).add(pp.z.mul(113))
  const h = (k: number): Node<'float'> => probeHash(nn.add(k))
  return mix(
    mix(mix(h(0), h(1), ff.x), mix(h(57), h(58), ff.x), ff.y),
    mix(mix(h(113), h(114), ff.x), mix(h(170), h(171), ff.x), ff.y),
    ff.z
  )
}

// Arm 9: which of the 27 neighbour cells carry a cross-backend jitter
// difference, and is the source's f = 0 reduction honoured by the hardware
async function measurePerCell(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number
): Promise<PerCellRowMetrics[]> {
  const rows: PerCellRowMetrics[] = []
  for (const { cellCount, offset } of PER_CELL_ROWS) {
    const c = glslFloat(cellCount)
    const cells: PerCellMetrics[] = []
    let nEcho: WeatherChannelMetrics | null = null
    for (let group = 0; group < 7; group++) {
      const members = CELL_OFFSETS.slice(group * 4, group * 4 + 4)
      const spare = members.length < 4
      const reference = await renderReferenceFloatField(
        referenceRenderer,
        referenceWeather,
        `  vec3 p = ${referencePoint(offset)};
  vec3 base = floor(p * ${c});
  ${members
    .map((o, i) => `float j${i} = noise(mod(base + ${glslVec3(o)}, ${c}));`)
    .join('\n  ')}
  ${
    spare
      ? `vec3 q0 = mod(base + ${glslVec3(CELL_OFFSETS[0]!)}, ${c});
  float n0 = q0.x + q0.y * 57.0 + 113.0 * q0.z;`
      : ''
  }
  outputColor = vec4(${members.map((_, i) => `j${i}`).join(', ')}${spare ? ', n0' : ''});`
      )
      const port = await renderPortFloatField(portRenderer, size, uv => {
        const p = portPoint(uv, offset)
        const base = p.mul(cellCount).floor()
        const js = members.map(o =>
          probeValueNoise(glslMod(base.add(vec3(...o)), float(cellCount)))
        )
        if (spare) {
          const q0 = glslMod(
            base.add(vec3(...CELL_OFFSETS[0]!)),
            float(cellCount)
          )
          const n0 = q0.x.add(q0.y.mul(57)).add(q0.z.mul(113))
          return vec4(js[0]!, js[1]!, js[2]!, n0)
        }
        return vec4(js[0]!, js[1]!, js[2]!, js[3]!)
      })
      members.forEach((o, i) => {
        const index = group * 4 + i
        cells.push({
          index,
          offset: o,
          value: floatChannelMetrics(
            reference,
            port,
            i,
            `cell-${index}(${o.join(',')})`
          )
        })
      })
      if (spare) nEcho = floatChannelMetrics(reference, port, 3, 'n-cell-0')
    }
    // D8: the mix control at the wrapped z-1 cell
    const mixReference = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `${referenceCellGlsl(cellCount, offset)}
  outputColor = vec4(mix(hash(n + 0.0), hash(n + 1.0), 0.0), hash(n + 0.0), noise(q), hash(n + 1.0));`
    )
    const mixPort = await renderPortFloatField(portRenderer, size, uv => {
      const q = portCell(uv, cellCount, offset)
      const n = q.x.add(q.y.mul(57)).add(q.z.mul(113))
      const h0 = probeHash(n.add(0))
      const h1 = probeHash(n.add(1))
      return vec4(mix(h0, h1, float(0)), h0, probeValueNoise(q), h1)
    })
    // D9: function vs its own body inline, plus the n / fract controls
    const fnReference = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `${referenceCellGlsl(cellCount, offset)}
${REFERENCE_NOISE_INLINE_GLSL}
  float fr = fract(q).x + fract(q).y + fract(q).z;
  outputColor = vec4(noise(q), inl, n, fr);`
    )
    const fnPort = await renderPortFloatField(portRenderer, size, uv => {
      const q = portCell(uv, cellCount, offset)
      const n = q.x.add(q.y.mul(57)).add(q.z.mul(113))
      const f = q.fract()
      const fr = f.x.add(f.y).add(f.z)
      return vec4(probeValueNoise(q), portNoiseInline(q), n, fr)
    })
    const nMetrics = floatChannelMetrics(fnReference, fnPort, 2, 'n-in-shader')
    rows.push({
      name: `percell-c${cellCount}-o${offset}`,
      cellCount,
      offset,
      cells,
      mixControl: {
        crossAB: ['mix-h0-h1-zero', 'h0', 'noise-q', 'h1'].map((name, i) =>
          floatChannelMetrics(mixReference, mixPort, i, name)
        ),
        within: {
          reference: {
            mixVsH0: channelPairMetrics(mixReference, 0, 1),
            noiseVsH0: channelPairMetrics(mixReference, 2, 1)
          },
          port: {
            mixVsH0: channelPairMetrics(mixPort, 0, 1),
            noiseVsH0: channelPairMetrics(mixPort, 2, 1)
          }
        }
      },
      functionVsInline: {
        crossAB: ['noise-function', 'noise-inline', 'n', 'fract-sum'].map(
          (name, i) => floatChannelMetrics(fnReference, fnPort, i, name)
        ),
        within: {
          reference: channelPairMetrics(fnReference, 0, 1),
          port: channelPairMetrics(fnPort, 0, 1)
        }
      },
      controls: {
        nIdentical: nMetrics.differing === 0 && (nEcho?.differing ?? 1) === 0,
        fractMaxReference: channelMaxAbs(fnReference, 3),
        fractMaxPort: channelMaxAbs(fnPort, 3)
      }
    })
  }
  return rows
}

interface InMarchRowMetrics {
  name: string
  cellCount: number
  offset: number
  namedCell: [number, number, number]
  // Cross A/B on [value, in-march jitter, standalone jitter, argmin]
  crossAB: WeatherChannelMetrics[]
  // The reading: in-march jitter vs standalone jitter on the SAME side
  within: { reference: DifferenceMetrics; port: DifferenceMetrics }
  // Controls: the twin's value equals arm 4's worley for the row on each side
  controls: {
    valueVsArm4Reference: DifferenceMetrics
    valueVsArm4Port: DifferenceMetrics
  }
}

const IN_MARCH_NAMED_CELL: [number, number, number] = [0, 0, -1]

// Arm 10: does the jitter the march consumed equal the same cell's standalone
// jitter, on each side?
async function measureInMarchJitter(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number,
  single: SingleWorleyFields
): Promise<InMarchRowMetrics[]> {
  const rows: InMarchRowMetrics[] = []
  for (const { cellCount, offset } of TOPOLOGY_ROWS) {
    const named = IN_MARCH_NAMED_CELL
    const reference = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `  vec3 p = ${referencePoint(offset)};
  outputColor = probeWorleyCellJitter(p, ${glslFloat(cellCount)}, ${glslVec3(named)});`,
      REFERENCE_WORLEY_CELL_JITTER_GLSL
    )
    const port = await renderPortFloatField(portRenderer, size, uv => {
      const p = portPoint(uv, offset)
      return probeWorleyCellJitter(p, float(cellCount), vec3(...named))
    })
    const arm4Reference = single.reference.get(rowName(cellCount, offset))
    const arm4Port = single.port.get(rowName(cellCount, offset))
    if (arm4Reference == null || arm4Port == null) {
      throw new Error('Arm 10 needs arm 4 rows (16, 0) and (8, 0.5)')
    }
    rows.push({
      name: `inmarch-c${cellCount}-o${offset}`,
      cellCount,
      offset,
      namedCell: named,
      crossAB: ['worley', 'jitter-in-march', 'jitter-standalone', 'argmin'].map(
        (name, i) => floatChannelMetrics(reference, port, i, name)
      ),
      within: {
        reference: channelPairMetrics(reference, 1, 2),
        port: channelPairMetrics(port, 1, 2)
      },
      controls: {
        valueVsArm4Reference: crossChannelMetrics(
          reference,
          0,
          arm4Reference,
          0
        ),
        valueVsArm4Port: crossChannelMetrics(port, 0, arm4Port, 0)
      }
    })
  }
  return rows
}

interface ParamFormRowMetrics {
  name: string
  cellCount: number
  offset: number
  namedCell: [number, number, number]
  // P1 cross A/B: the wrapped cell and n, computed with cellCount as a RUNTIME
  // parameter (a uniform on both sides)
  qn: WeatherChannelMetrics[]
  // P2 cross A/B: [jitter (parameter form), jitter (literal form), fract-sum
  // (parameter form), hash(n+0) (parameter form)]
  jitter: WeatherChannelMetrics[]
  within: {
    reference: { paramVsLiteral: DifferenceMetrics; fractMax: number }
    port: { paramVsLiteral: DifferenceMetrics; fractMax: number }
  }
}

// Side A's helpers for arm 11: the same wrap/hash with cellCount and the cell
// offset arriving as UNIFORMS, which the compiler cannot fold
const REFERENCE_PARAM_FORM_GLSL = `
uniform float probeCellCount;
uniform vec3 probeNamed;
vec4 probeParamQN(const vec3 p, const float cellCount, const vec3 named) {
  vec3 q = mod(floor(p * cellCount) + named, cellCount / 1.0);
  float n = q.x + q.y * 57.0 + 113.0 * q.z;
  return vec4(q, n);
}
vec4 probeParamJitter(const vec3 p, const float cellCount, const vec3 named) {
  vec3 q = mod(floor(p * cellCount) + named, cellCount / 1.0);
  float n = q.x + q.y * 57.0 + 113.0 * q.z;
  float fr = fract(q).x + fract(q).y + fract(q).z;
  return vec4(noise(q), 0.0, fr, hash(n + 0.0));
}
`

// Arm 11: does the parameterised wrap/hash differ from the literal one, and on
// which side?
async function measureParameterForm(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  size: number
): Promise<ParamFormRowMetrics[]> {
  const rows: ParamFormRowMetrics[] = []
  for (const { cellCount, offset } of TOPOLOGY_ROWS) {
    const named = IN_MARCH_NAMED_CELL
    const c = glslFloat(cellCount)
    const uniforms = {
      probeCellCount: new Uniform(cellCount),
      probeNamed: new Uniform(new Vector3(...named))
    }
    const reference1 = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `  vec3 p = ${referencePoint(offset)};
  outputColor = probeParamQN(p, probeCellCount, probeNamed);`,
      REFERENCE_PARAM_FORM_GLSL,
      uniforms
    )
    const reference2 = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `  vec3 p = ${referencePoint(offset)};
  vec4 r = probeParamJitter(p, probeCellCount, probeNamed);
  float lit = noise(mod(floor(p * ${c}) + ${glslVec3(named)}, ${c}));
  outputColor = vec4(r.x, lit, r.z, r.w);`,
      REFERENCE_PARAM_FORM_GLSL,
      uniforms
    )
    const cellCountU = uniform(cellCount)
    const namedU = uniform(new Vector3(...named))
    const port1 = await renderPortFloatField(portRenderer, size, uv => {
      const p = portPoint(uv, offset)
      const q = glslMod(p.mul(cellCountU).floor().add(namedU), cellCountU)
      const n = q.x.add(q.y.mul(57)).add(q.z.mul(113))
      return vec4(q.x, q.y, q.z, n)
    })
    const port2 = await renderPortFloatField(portRenderer, size, uv => {
      const p = portPoint(uv, offset)
      const q = glslMod(p.mul(cellCountU).floor().add(namedU), cellCountU)
      const n = q.x.add(q.y.mul(57)).add(q.z.mul(113))
      const f = q.fract()
      const fr = f.x.add(f.y).add(f.z)
      const literal = probeValueNoise(
        glslMod(
          p
            .mul(cellCount)
            .floor()
            .add(vec3(...named)),
          float(cellCount)
        )
      )
      return vec4(probeValueNoise(q), literal, fr, probeHash(n.add(0)))
    })
    rows.push({
      name: `paramform-c${cellCount}-o${offset}`,
      cellCount,
      offset,
      namedCell: named,
      qn: ['q.x', 'q.y', 'q.z', 'n'].map((name, i) =>
        floatChannelMetrics(reference1, port1, i, name)
      ),
      jitter: [
        'jitter-param',
        'jitter-literal',
        'fract-param',
        'hash0-param'
      ].map((name, i) => floatChannelMetrics(reference2, port2, i, name)),
      within: {
        reference: {
          paramVsLiteral: channelPairMetrics(reference2, 0, 1),
          fractMax: channelMaxAbs(reference2, 2)
        },
        port: {
          paramVsLiteral: channelPairMetrics(port2, 0, 1),
          fractMax: channelMaxAbs(port2, 2)
        }
      }
    })
  }
  return rows
}

interface UnrolledRowMetrics {
  name: string
  cellCount: number
  offset: number
  // U1: the full worley unrolled inline in main() on side A vs the port's
  // arm-4 field. U2: the same body in a loop-free function vs the port
  inlineVsPort: DifferenceMetrics
  functionVsPort: DifferenceMetrics
  // The reference's own loop function (arm-4 side-A field) vs its unrolled self
  inlineVsLoopFunction: DifferenceMetrics
  // Within A: U1 vs U2
  inlineVsFunction: DifferenceMetrics
}

// The reference's getWorleyNoise body with the 3x3x3 loop unrolled into 27
// straight-line cells (literal offsets), as an expression on `p` and `c`
function unrolledWorleyGlsl(
  cellExpr: string,
  c: string,
  lines: string[]
): void {
  lines.push(`  vec3 cell = ${cellExpr};`)
  lines.push(`  vec3 base = floor(cell);`)
  lines.push(`  float d = 1.0e10;`)
  CELL_OFFSETS.forEach((o, i) => {
    lines.push(`  vec3 tp${i} = base + ${glslVec3(o)};`)
    lines.push(`  vec3 dl${i} = cell - tp${i} - noise(mod(tp${i}, ${c}));`)
    lines.push(`  d = min(d, dot(dl${i}, dl${i}));`)
  })
}

// Arm 12: does the reference's straight-line arithmetic equal the port's for
// the whole worley value of the row?
async function measureUnrolledReference(
  referenceRenderer: WebGLRenderer,
  referenceWeather: ReferenceLocalWeather,
  single: SingleWorleyFields
): Promise<UnrolledRowMetrics[]> {
  const rows: UnrolledRowMetrics[] = []
  for (const { cellCount, offset } of TOPOLOGY_ROWS) {
    const c = glslFloat(cellCount)
    const inlineLines: string[] = [`  vec3 p = ${referencePoint(offset)};`]
    unrolledWorleyGlsl(`p * ${c}`, c, inlineLines)
    inlineLines.push(`  outputColor = vec4(clamp(d, 0.0, 1.0), 0.0, 0.0, 1.0);`)
    const inline = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      inlineLines.join('\n')
    )
    const fnLines: string[] = []
    unrolledWorleyGlsl('p * cellCount', 'cellCount', fnLines)
    const fnGlsl = `
float probeUnrolledWorley(const vec3 p, const float cellCount) {
${fnLines.join('\n')}
  return clamp(d, 0.0, 1.0);
}
`
    const fn = await renderReferenceFloatField(
      referenceRenderer,
      referenceWeather,
      `  vec3 p = ${referencePoint(offset)};
  outputColor = vec4(probeUnrolledWorley(p, ${c}), 0.0, 0.0, 1.0);`,
      fnGlsl
    )
    const port = single.port.get(rowName(cellCount, offset))
    const loopFunction = single.reference.get(rowName(cellCount, offset))
    if (port == null || loopFunction == null) {
      throw new Error('Arm 12 needs arm 4 rows (16, 0) and (8, 0.5)')
    }
    rows.push({
      name: `unrolled-c${cellCount}-o${offset}`,
      cellCount,
      offset,
      inlineVsPort: crossChannelMetrics(inline, 0, port, 0),
      functionVsPort: crossChannelMetrics(fn, 0, port, 0),
      inlineVsLoopFunction: crossChannelMetrics(inline, 0, loopFunction, 0),
      inlineVsFunction: crossChannelMetrics(inline, 0, fn, 0)
    })
  }
  return rows
}

interface ArmMetrics {
  singleWorley: FloatRowMetrics[]
  composition: CompositionMetrics
  context: ContextMetrics
  topology: TopologyRowMetrics[]
  argumentAssembly: AssemblyRowMetrics[]
  perCell: PerCellRowMetrics[]
  inMarchJitter: InMarchRowMetrics[]
  parameterForm: ParamFormRowMetrics[]
  unrolledReference: UnrolledRowMetrics[]
}

interface ProbeGPUAdapter {
  info: {
    vendor?: string
    architecture?: string
    device?: string
  }
}

interface ProbeNavigator extends Navigator {
  gpu?: {
    requestAdapter: () => Promise<ProbeGPUAdapter | null>
  }
}

async function adapterName(): Promise<string> {
  const { gpu } = navigator as ProbeNavigator
  const adapter = await gpu?.requestAdapter()
  if (adapter == null) return 'no-adapter'
  const info = adapter.info
  return (
    `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.device ?? ''}`.trim() ||
    'unknown'
  )
}

async function measureHash(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather
): Promise<HashMeasurement> {
  const referenceReadback = await renderReferenceHash(
    referenceRenderer,
    referenceWeather
  )
  const portReadback = await renderPortHash(portRenderer)
  return {
    referenceReadback,
    portReadback,
    reference: indexHashSamples(referenceReadback),
    port: indexHashSamples(portReadback)
  }
}

async function measureInputControl(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  portWeather: PortLocalWeather
): Promise<InputControlMeasurement> {
  const reference = await renderReferenceFloatField(
    referenceRenderer,
    referenceWeather,
    '  outputColor = vec4(vUv, 0.0, 1.0);'
  )
  const port = await renderPortFloatField(portRenderer, portWeather.size, uv =>
    vec4(uv, 0, 1)
  )
  return { reference, port }
}

async function measureWeather(
  referenceRenderer: WebGLRenderer,
  portRenderer: WebGPURenderer,
  referenceWeather: ReferenceLocalWeather,
  portWeather: PortLocalWeather
): Promise<WeatherMeasurement> {
  return {
    reference: await readReferenceWeather(referenceRenderer, referenceWeather),
    port: await readPortWeather(portRenderer, portWeather)
  }
}

function summarizeHashInput(measurement: HashMeasurement) {
  const summary = (samples: HashSamples): Omit<HashSamples, 'values'> => ({
    missing: samples.missing,
    argumentErrors: samples.argumentErrors,
    coordinateErrors: samples.coordinateErrors
  })
  return {
    reference: summary(measurement.reference),
    port: summary(measurement.port),
    indexAligned: nonHashChannelsAlign(
      measurement.referenceReadback,
      measurement.portReadback
    )
  }
}

function summarizeFloatChannels(
  reference: Float32Array,
  port: Float32Array,
  names: readonly string[]
): WeatherChannelMetrics[] {
  return names.map((name, index) =>
    floatChannelMetrics(reference, port, index, name)
  )
}

function summarizeWeatherChannels(
  reference: Uint8Array,
  port: Uint8Array
): WeatherChannelMetrics[] {
  const names = ['low-composed-r', 'mid-worley-g', 'high-perlin-b', 'alpha']
  return names.map((name, index) =>
    weatherChannelMetrics(reference, port, index, name)
  )
}

export async function runLocalWeatherIntermediateProbe(): Promise<LocalWeatherIntermediateProbeResult> {
  const referenceRenderer = new WebGLRenderer({
    canvas: requireCanvas('reference'),
    antialias: false,
    preserveDrawingBuffer: true
  })
  const portRenderer = new WebGPURenderer({
    canvas: requireCanvas('port'),
    antialias: false
  })
  await portRenderer.init()
  const referenceWeather = new ReferenceLocalWeather()
  const portWeather = new PortLocalWeather()

  try {
    const hash = await measureHash(
      referenceRenderer,
      portRenderer,
      referenceWeather
    )
    const inputControl = await measureInputControl(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      portWeather
    )
    const weather = await measureWeather(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      portWeather
    )
    const size = referenceWeather.size
    const single = await measureSingleWorley(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size
    )
    const composition = await measureComposition(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size,
      weather
    )
    const context = await measureContext(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size,
      composition.fields,
      single.fields
    )
    const topology = await measureTopology(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size
    )
    const argumentAssembly = await measureArgumentAssembly(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size
    )
    const perCell = await measurePerCell(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size
    )
    const inMarchJitter = await measureInMarchJitter(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size,
      single.fields
    )
    const parameterForm = await measureParameterForm(
      referenceRenderer,
      portRenderer,
      referenceWeather,
      size
    )
    const unrolledReference = await measureUnrolledReference(
      referenceRenderer,
      referenceWeather,
      single.fields
    )
    return assembleResult(hash, inputControl, weather, size, {
      singleWorley: single.rows,
      composition: composition.metrics,
      context,
      topology,
      argumentAssembly,
      perCell,
      inMarchJitter,
      parameterForm,
      unrolledReference
    })
  } finally {
    referenceWeather.dispose()
    portWeather.dispose()
    referenceRenderer.dispose()
    void portRenderer.dispose()
  }
}

async function assembleResult(
  hash: HashMeasurement,
  inputControl: InputControlMeasurement,
  weather: WeatherMeasurement,
  size: number,
  arms: ArmMetrics
): Promise<LocalWeatherIntermediateProbeResult> {
  return {
    adapter: await adapterName(),
    hashInputControl: summarizeHashInput(hash),
    hash: hashDomainMetrics(hash.reference.values, hash.port.values),
    localWeatherInputControl: summarizeFloatChannels(
      inputControl.reference,
      inputControl.port,
      ['uv-x', 'uv-y', 'zero', 'one']
    ),
    localWeather: {
      width: size,
      height: size,
      channels: summarizeWeatherChannels(weather.reference, weather.port)
    },
    ...arms
  }
}

declare global {
  interface Window {
    __localWeatherIntermediateProbe: {
      run: typeof runLocalWeatherIntermediateProbe
    }
  }
}

window.__localWeatherIntermediateProbe = {
  run: runLocalWeatherIntermediateProbe
}
