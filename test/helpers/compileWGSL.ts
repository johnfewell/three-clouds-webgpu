import { context as tslContext } from 'three/tsl'
import * as threeWebGPU from 'three/webgpu'
import {
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  NodeMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  WebGPUBackend,
  WebGPUCoordinateSystem,
  WebGPURenderer,
  type Node
} from 'three/webgpu'

export interface CompileResult {
  vertex: string
  fragment: string
  // The textures the compiled program binds, read THROUGH their texture nodes
  // at call time. A TextureNode whose .value was swapped after the build
  // reports the new texture, and a texture captured at build reports the old
  boundTextures: () => unknown[]
}

export interface CompileOptions {
  contextNode?: Node
  width?: number
  height?: number
  // An mrt() fragment resolves its attachment indices against the bound
  // render target's texture names. Pass the target the material renders into
  renderTarget?: unknown
  // WebGPU device features the stub renderer reports (renderer.hasFeature),
  // none by default. Graphs that branch on a feature (quad operations need
  // `subgroups`) are compiled both ways through this
  features?: string[]
  logarithmicDepthBuffer?: boolean
  reversedDepthBuffer?: boolean
}

// three exports StandardNodeLibrary from 'three/webgpu' only since 0.185. On
// 0.184 (the floor the takram builds target) a renderer constructs one at
// construction time, before any GPU or canvas context is needed
function createStandardNodeLibrary(): unknown {
  const webgpu = threeWebGPU as { StandardNodeLibrary?: new () => unknown }
  if (webgpu.StandardNodeLibrary != null)
    return new webgpu.StandardNodeLibrary()
  // A canvas-shaped object: construction only stores it, and the suites run
  // without a DOM
  const canvas = { style: {}, addEventListener() {} }
  const renderer = new WebGPURenderer({
    canvas: canvas as unknown as HTMLCanvasElement
  }) as unknown as { library: unknown }
  return renderer.library
}

function createRendererStub(opts: CompileOptions = {}) {
  const w = opts.width ?? 800
  const h = opts.height ?? 600
  const stub = {
    backend: new WebGPUBackend({}),
    coordinateSystem: WebGPUCoordinateSystem,
    toneMapping: NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: SRGBColorSpace,
    currentColorSpace: LinearSRGBColorSpace,
    library: createStandardNodeLibrary(),
    contextNode: opts.contextNode ?? tslContext({}),
    getRenderTarget: () => opts.renderTarget ?? null,
    getMRT: () => null,
    getOutputRenderTarget: () => null,
    getOutputBufferType: () => HalfFloatType,
    logarithmicDepthBuffer: opts.logarithmicDepthBuffer ?? false,
    reversedDepthBuffer: opts.reversedDepthBuffer ?? false,
    highPrecision: false,
    getDrawingBufferSize: (v: { set: (w: number, h: number) => void }) =>
      v.set(w, h),
    getPixelRatio: () => 1,
    info: { autoReset: true },
    hasFeature: (name: string) => (opts.features ?? []).includes(name),
    lighting: null,
    shadowMap: { enabled: false },
    // three r186 reads renderer.debug.diagnostics.keywords on every declaration
    // and throws when it is absent. This mirrors the Renderer's default
    debug: { diagnostics: { keywords: false } },
    _nodes: {},
    alpha: false
  } as Record<string, unknown>
  ;(stub['backend'] as Record<string, unknown>)['renderer'] = stub
  return stub
}

export function compileWGSL(
  fragmentNode: Node,
  opts: CompileOptions = {}
): CompileResult {
  const stub = createRendererStub(opts)
  const scene = new Scene()
  const camera = new PerspectiveCamera(
    75,
    (opts.width ?? 800) / (opts.height ?? 600),
    0.1,
    1000
  )
  const material = new NodeMaterial()
  material.fragmentNode = fragmentNode
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  scene.add(mesh)

  // WGSLNodeBuilder internal API: not in @types/three, and not exported from
  // 'three/webgpu' before 0.185. The backend constructs it on every version
  const backend = stub['backend'] as {
    createNodeBuilder: (object: unknown, renderer: unknown) => unknown
  }
  const b = backend.createNodeBuilder(mesh, stub) as Record<string, unknown>
  b['scene'] = scene
  b['material'] = material
  b['camera'] = camera
  ;(b['context'] as Record<string, unknown>)['material'] = material
  b['lightsNode'] = null
  b['environmentNode'] = null
  b['fogNode'] = null
  b['clippingContext'] = null
  // three reports TSL graph errors via console.error and keeps going with a
  // broken program. A snapshot must never pass on such a graph
  const tslErrors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    const message = args.map(a => String(a)).join(' ')
    if (message.includes('THREE.TSL')) tslErrors.push(message)
    else originalError(...args)
  }
  try {
    ;(b as unknown as { build: () => void }).build()
  } finally {
    console.error = originalError
  }
  if (tslErrors.length > 0) {
    throw new Error(`TSL build errors:\n${tslErrors.join('\n')}`)
  }

  const vertexShader = b['vertexShader'] as string
  const fragmentShader = b['fragmentShader'] as string
  assertNoJsClassTypes({ vertex: vertexShader, fragment: fragmentShader })

  return {
    vertex: vertexShader,
    fragment: fragmentShader,
    boundTextures: () => {
      const out: unknown[] = []
      // bindings[stage] is a map of group name → array of bindings
      // ({ vertex: { render: [...], object: [...] }, fragment: { object: [...] }, … })
      const stages = (b['bindings'] ?? {}) as Record<
        string,
        Record<string, unknown[]>
      >
      for (const groups of Object.values(stages)) {
        for (const bindings of Object.values(groups ?? {})) {
          for (const binding of bindings ?? []) {
            const node = (binding as { textureNode?: { value?: unknown } })
              .textureNode
            if (node != null) out.push(node.value)
          }
        }
      }
      return out
    }
  }
}

export function compileComputeWGSL(compute: unknown): string {
  const renderer = createRendererStub()
  const backend = renderer['backend'] as {
    createNodeBuilder: (
      object: unknown,
      renderer: unknown
    ) => { build: () => void; computeShader: string; compute?: unknown }
  }
  // r185 reads the kernel off the builder's object and r186 off its `compute`
  // property, which NodeManager assigns before build()
  const builder = backend.createNodeBuilder(compute, renderer)
  builder.compute = compute
  const errors: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }
  try {
    builder.build()
  } finally {
    console.error = original
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
  if (!builder.computeShader) throw new Error('No compute shader was generated')
  assertNoJsClassTypes({ compute: builder.computeShader })
  return builder.computeShader
}

/**
 * A three.js class name where a WGSL type belongs, in the emitted source.
 *
 * three falls back to a value's constructor name when it cannot resolve the
 * node's type at build time, so `struct({ toward: varying(x) })` inside an `Fn`
 * body types its member `VaryingNode`.
 *
 * The stub hands the WGSL back as a string and nothing parses it, so that graph
 * is green here and renders nothing on a device: the shader module fails to
 * parse and the pass draws nothing (hardware review 2026-10-03).
 *
 * Two shapes, because the type is lost in different ways. The class name lands
 * in a declared type position when a struct or a var cannot be typed at build
 * time. The three names listed are checked anywhere, since a leak can also reach
 * a cast or an argument without one.
 */
const JS_CLASS_AS_TYPE_RE = /:\s*([A-Z][A-Za-z0-9]*Node)\b/g
const JS_CLASS_NAMES = ['VaryingNode', 'UniformNode', 'TextureNode']

export function jsClassNamesInWgsl(wgsl: string): string[] {
  const hits = new Set<string>()
  for (const match of wgsl.matchAll(JS_CLASS_AS_TYPE_RE)) hits.add(match[1]!)
  for (const name of JS_CLASS_NAMES) {
    if (wgsl.includes(name)) hits.add(name)
  }
  return [...hits].sort()
}

// The declaration lines, so a failure names the defect rather than the graph
function classNameLines(wgsl: string, names: string[]): string[] {
  return wgsl
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => names.some(name => line.includes(name)))
    .slice(0, 8)
    .map(({ line, index }) => `  ${index + 1}: ${line.slice(0, 120)}`)
}

function assertNoJsClassTypes(shaders: Record<string, string>): void {
  const found = Object.entries(shaders).flatMap(([stage, wgsl]) =>
    jsClassNamesInWgsl(wgsl).map(name => ({ stage, name, wgsl }))
  )
  if (found.length === 0) return
  const { stage, wgsl } = found[0]!
  throw new Error(
    `WGSL declares a three.js class as a type: ${found
      .map(f => f.name)
      .join(', ')}\n` +
      `three could not resolve a node type while building, and wrote the\n` +
      `value's constructor name instead. This stub returns the WGSL unparsed, so\n` +
      `only a check like this can see it; on a device the shader module fails to\n` +
      `parse and the pass renders nothing. In the ${stage} stage:\n` +
      classNameLines(
        wgsl,
        found.map(f => f.name)
      ).join('\n')
  )
}

const NODE_VAR_RE = /node(Var|Const|Uniform|Attribute|Varying)\d+/g
// three names generated structs from a per-build counter (NodeBuffer_21507),
// so two builds of one graph differ in those ids alone. Normalising them lets a
// test say "the same program" rather than "the same up to a counter"
const NODE_ID_RE = /Node([A-Za-z]+)_?\d+/g
// three stamps its own revision into the first line, and the revision is the
// one thing a digest cannot survive across peers: the same graph compiles to
// byte-identical WGSL on 0.184 and 0.185 apart from this banner
const BANNER_RE = /^\/\/ Three\.js r\d+ - Node System$/m

export function normalizeWGSL(wgsl: string): string {
  const functions = new Map<string, string>()
  return wgsl
    .replace(BANNER_RE, '// Three.js - Node System')
    .replace(NODE_VAR_RE, (_, kind: string) => `node${kind}N`)
    .replace(NODE_ID_RE, (_, type: string) => `Node${type}N`)
    .replace(/\bfn\d+\b/g, name => {
      if (!functions.has(name)) functions.set(name, `fn${functions.size}`)
      return functions.get(name)!
    })
    .replace(/\s+/g, ' ')
    .trim()
}

export function expectWGSL(wgsl: string) {
  return {
    toContain(snippet: string) {
      if (!wgsl.includes(snippet)) {
        throw new Error(
          `Expected WGSL to contain:\n  ${snippet}\n\nActual WGSL:\n${wgsl}`
        )
      }
    },
    toNotContain(snippet: string) {
      if (wgsl.includes(snippet)) {
        throw new Error(
          `Expected WGSL NOT to contain:\n  ${snippet}\n\nActual WGSL:\n${wgsl}`
        )
      }
    }
  }
}

export class WGSLStructNotFoundError extends Error {
  override name = 'WGSLStructNotFoundError'
}

// The core helpers emit unnamed structs (StructType0, ...), so a test finds one
// by its members, in declaration order. A miss throws rather than returning a
// name no regex can match, which would read as "zero constructions"
export function findStructByMembers(
  wgsl: string,
  members: Record<string, string>
): string {
  const wanted = Object.entries(members)
    .map(([name, type]) => `${name}:${type}`)
    .join(',')
  for (const match of wgsl.matchAll(/struct (\w+)\s*\{([^}]*)\}/g)) {
    const declared = match[2]!
      .split(',')
      .map(member => member.replace(/\s+/g, ''))
      .filter(member => member.length > 0)
      .join(',')
    if (declared === wanted) return match[1]!
  }
  throw new WGSLStructNotFoundError(
    `no WGSL struct declares exactly { ${Object.entries(members)
      .map(([name, type]) => `${name}: ${type}`)
      .join(', ')} }`
  )
}
