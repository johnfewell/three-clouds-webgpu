// Every uniform in the emitted WGSL gets a stable name, never nodeUniformN
// The port's own value uniforms are named in TSL (setName). The emitter names
// the rest as three builds them: textures after their three texture, which a
// sample() clone cannot carry, and uniforms made inside three or takram after
// the code that made them. A port uniform left unnamed is reported instead

import { readFileSync } from 'node:fs'
import * as tsl from 'three/tsl'
import {
  NodeBuilder,
  ReferenceNode,
  RendererReferenceNode,
  UniformNode,
  WorkgroupInfoNode
} from 'three/webgpu'

export interface AnonymousUniform {
  type: string
  stage: string
  site: string
}

interface Frame {
  fn: string
  file: string
  line: number
  column: number
}

// at fn (file:line:col) or at file:line:col
const FRAME_RE = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/

function parseStack(stack: string): Frame[] {
  return stack
    .split('\n')
    .slice(1)
    .flatMap(l => {
      const m = l.trim().match(FRAME_RE)
      if (m == null) return []
      return [
        {
          fn: m[1] ?? '',
          file: m[2]!.replace(/^file:\/\//, ''),
          line: Number(m[3]),
          column: Number(m[4])
        }
      ]
    })
}

// Under vite's SSR loader stacks point into transformed code. The emit
// script hands over vite's own fixer, vitest maps stacks itself
function sourceStack(error: Error): string {
  const fix = (globalThis as { __emitFixStack?: (e: Error) => void })
    .__emitFixStack
  fix?.(error)
  return error.stack ?? ''
}

const inDependency = (f: Frame) => f.file.includes('/node_modules/')
const isEmitter = (f: Frame) => f.file.includes('/core/emit/')
// three's own node constructors and the uniform() helpers they go through
const isMaker = (f: Frame) =>
  inDependency(f) &&
  /^(new \w*(Uniform|Texture)\w*Node|uniform|uniformArray|texture3?D?)$/.test(
    f.fn
  )

const sourceLines = new Map<string, string[]>()
function sourceText(f: Frame): string {
  let lines = sourceLines.get(f.file)
  if (lines == null) {
    lines = readFileSync(f.file, 'utf8').split('\n')
    sourceLines.set(f.file, lines)
  }
  return (lines[f.line - 1] ?? '').slice(0, f.column - 1)
}

// three's internals that assign no property, by method and uniform type
const THREE_INTERNALS: Record<string, string> = {
  'ScreenNode.setup:vec2': 'screenSize',
  'ScreenNode.setup:vec4': 'viewport',
  'ScreenNode.setup:float': 'dpr',
  'TextureNode.getTransformedUV:mat3': 'uvTransform'
}

// A dependency's uniform: the chain of `this.prop =` assignments from the
// outermost dependency constructor in to the uniform, which minification
// leaves intact (takram's skyNode_starsNode_magnitudeRange)
function dependencyName(frames: Frame[], type: string): string | null {
  const own = frames.findIndex(f => !inDependency(f))
  const deps = frames.slice(0, own < 0 ? frames.length : own)
  const props: string[] = []
  for (const f of deps) {
    const m = sourceText(f).match(/this\.(\w+)\s*=\s*(?:new\s+)?\w*\(?\s*$/)
    if (m != null) props.unshift(m[1]!.replace(/^_+/, ''))
  }
  if (props.length > 0) return props.join('_')
  for (const f of deps) {
    const internal = THREE_INTERNALS[`${f.fn}:${type}`]
    if (internal != null) return internal
  }
  return null
}

const TEXTURE_TYPES =
  /^(texture|texture3D|textureArray|cubeTexture|storageTexture|depthTexture)/

function identifier(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z]/.test(id) ? id : `t_${id}`
}

export interface UniformNaming {
  // the port's value uniforms still unnamed, with where each was made
  anonymous: AnonymousUniform[]
  // what the emitter named, by kind: textures and dependency uniforms
  assigned: { name: string; type: string; from: string }[]
}

interface Run {
  naming: UniformNaming
  seen: Set<string>
  textureName: (texture: object) => string | undefined
}

// The hooks live on three's prototypes, so they are installed once per process
// and read the current run. Wrapping them again per emit nested an older run's
// hook inside, which named the next run's textures from the old roles
let current: Run | null = null
let installed = false

export function nameUniforms(
  textureName: (texture: object) => string | undefined
): UniformNaming {
  const naming: UniformNaming = { anonymous: [], assigned: [] }
  current = { naming, seen: new Set(), textureName }
  if (!installed) {
    installHooks()
    installed = true
  }
  return naming
}

function installHooks(): void {
  // An unnamed workgroup array is WorkgroupArray_<node id>, a counter over
  // the whole process. Named per module instead, in the order it is built
  const workgroupCount = new WeakMap<object, number>()
  const wg = WorkgroupInfoNode.prototype as unknown as {
    generate: (this: { name: string }, builder: object) => string
  }
  const generate = wg.generate
  wg.generate = function (this: { name: string }, builder: object) {
    if (this.name === '') {
      const n = workgroupCount.get(builder) ?? 0
      workgroupCount.set(builder, n + 1)
      this.name = `workgroupArray_${n}`
    }
    return generate.call(this, builder)
  }
  // UniformNode's constructor assigns isUniformNode on the instance, so a
  // prototype setter sees every construction and keeps its stack
  Object.defineProperty(UniformNode.prototype, 'isUniformNode', {
    configurable: true,
    set(this: Record<string, unknown>, value: unknown) {
      Object.defineProperty(this, 'isUniformNode', {
        value,
        writable: true,
        configurable: true
      })
      Object.defineProperty(this, '__frames', {
        value: parseStack(sourceStack(new Error())).filter(
          f => !isEmitter(f) && !isMaker(f)
        ),
        enumerable: false
      })
    }
  })
  // a reference node makes its uniform on demand: name it for the property
  for (const proto of [
    ReferenceNode.prototype,
    Object.getPrototypeOf(RendererReferenceNode.prototype) as object
  ]) {
    const p = proto as { setNodeType: (this: unknown, t: string) => void }
    const setNodeType = p.setNodeType
    p.setNodeType = function (this: unknown, t: string) {
      setNodeType.call(this, t)
      const self = this as { node?: { name?: string }; property?: string }
      if (self.node != null && !self.node.name && self.property != null) {
        self.node.name = `reference_${self.property}`
      }
    }
  }

  // three's module-level uniforms predate the hook: name them by export
  // by node id: an export is a TSL proxy, the builder sees the node itself
  const exported = new Map<number, string>()
  // an Object3DNode export (modelWorldMatrix) holds its uniform inside
  for (const [key, value] of Object.entries(tsl)) {
    const inner = (value as { uniformNode?: unknown } | null)?.uniformNode
    for (const node of [value, inner]) {
      if (node instanceof UniformNode) exported.set(node.id, key)
    }
  }
  const usedNames = new WeakMap<object, Set<string>>()
  const proto = NodeBuilder.prototype as unknown as {
    getUniformFromNode: (...args: unknown[]) => { name: string }
  }
  const original = proto.getUniformFromNode
  proto.getUniformFromNode = function (this: object, ...args: unknown[]) {
    const result = original.apply(this, args)
    const run = current
    if (run == null) return result
    let used = usedNames.get(this)
    if (used == null) usedNames.set(this, (used = new Set()))
    if (!/^nodeUniform\d+$/.test(result.name)) {
      used.add(result.name)
      return result
    }
    const node = args[0] as { __frames?: Frame[]; value?: unknown; id: number }
    const type = String(args[1])
    const frames = node.__frames ?? []
    let name: string | null = null
    let from = ''
    if (TEXTURE_TYPES.test(type)) {
      const value = node.value as { name?: string } | null
      name = (value != null ? run.textureName(value) : undefined) ?? null
      name ??= value?.name ? value.name : 'unnamed'
      name = `${name}Texture`
      from = 'texture'
    } else if (exported.has(node.id)) {
      name = `three_${exported.get(node.id)}`
      from = 'three'
    } else if (frames[0] != null && inDependency(frames[0])) {
      // the origin as a prefix, clear of three's own generated locals
      const origin = frames[0].file.includes('/@takram/') ? 'takram' : 'three'
      const found = dependencyName(frames, type)
      name = found == null ? null : `${origin}_${found}`
      from = origin
    }
    if (name == null) {
      const site = frames[0]
      const entry = {
        type,
        stage: String(args[2]),
        site:
          site == null
            ? '(unknown)'
            : `${site.file}:${site.line}:${site.column}`
      }
      const key = `${entry.site}|${type}`
      if (!run.seen.has(key)) {
        run.seen.add(key)
        run.naming.anonymous.push(entry)
      }
      return result
    }
    // unique within the module three is building
    const base = identifier(name)
    let unique = base
    for (let i = 1; used.has(unique); i++) unique = `${base}_${i}`
    used.add(unique)
    result.name = unique
    run.naming.assigned.push({ name: unique, type, from })
    return result
  }
}
