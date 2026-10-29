// Host-shareable layout of the uniform structs in three's generated WGSL, and
// the module-scope bindings, so every uniform buffer gets a field map

export interface Field {
  name: string
  type: string
  offset: number
  size: number
}

export interface Binding {
  group: number
  binding: number
  name: string
  // uniform, storage, texture, sampler, storageTexture
  kind: string
  type: string
}

// [align, size] per WGSL host-shareable rules
const SCALAR: Record<string, [number, number]> = {
  f32: [4, 4],
  i32: [4, 4],
  u32: [4, 4],
  f16: [2, 2],
  'vec2<f32>': [8, 8],
  'vec3<f32>': [16, 12],
  'vec4<f32>': [16, 16],
  'vec2<u32>': [8, 8],
  'vec3<u32>': [16, 12],
  'vec4<u32>': [16, 16],
  'vec2<i32>': [8, 8],
  'vec3<i32>': [16, 12],
  'vec4<i32>': [16, 16],
  'mat2x2<f32>': [8, 16],
  'mat3x3<f32>': [16, 48],
  'mat4x4<f32>': [16, 64]
}

export type Structs = Record<string, { name: string; type: string }[]>

// Members split on commas outside <...>, since array<vec4<f32>, 4> holds one
function splitMembers(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '<') depth++
    if (ch === '>') depth--
    if ((ch === ',' || ch === '\n') && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts
}

export function parseStructs(code: string): Structs {
  const structs: Structs = {}
  for (const m of code.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    const members = []
    for (const part of splitMembers(m[2]!)) {
      const mm = part.match(/^\s*(?:@\w+\([^)]*\)\s*)*(\w+)\s*:\s*(.+?)\s*$/)
      if (mm) members.push({ name: mm[1]!, type: mm[2]!.replace(/\s+/g, '') })
    }
    structs[m[1]!] = members
  }
  return structs
}

function typeLayout(
  type: string,
  structs: Structs
): { align: number; size: number } {
  const scalar = SCALAR[type]
  if (scalar) return { align: scalar[0], size: scalar[1] }
  const arr = type.match(/^array<(.+),(\d+)>$/)
  if (arr) {
    // uniform address space: array elements are 16-byte aligned
    const e = typeLayout(arr[1]!, structs)
    const align = Math.max(e.align, 16)
    const stride = Math.ceil(e.size / align) * align
    return { align, size: stride * Number(arr[2]) }
  }
  if (structs[type]) {
    const l = structLayout(type, structs)
    return { align: l.align, size: l.size }
  }
  throw new Error(`unknown WGSL type ${type}`)
}

export function structLayout(
  name: string,
  structs: Structs
): { fields: Field[]; size: number; align: number } {
  let offset = 0
  let align = 16
  const fields: Field[] = []
  for (const m of structs[name] ?? []) {
    const t = typeLayout(m.type, structs)
    offset = Math.ceil(offset / t.align) * t.align
    fields.push({ name: m.name, type: m.type, offset, size: t.size })
    offset += t.size
    align = Math.max(align, t.align)
  }
  return { fields, size: Math.ceil(offset / align) * align, align }
}

const BINDING_RE =
  /@binding\(\s*(\d+)\s*\)\s*@group\(\s*(\d+)\s*\)\s*var(?:<([\w, ]+)>)?\s+(\w+)\s*:\s*([^;]+);/g

export function moduleBindings(code: string): Binding[] {
  const out: Binding[] = []
  for (const m of code.replace(/\n/g, ' ').matchAll(BINDING_RE)) {
    const space = m[3]?.split(',')[0]?.trim()
    const type = m[5]!.replace(/\s+/g, '')
    let kind = 'texture'
    if (space === 'uniform') kind = 'uniform'
    else if (space === 'storage') kind = 'storage'
    else if (type.startsWith('sampler')) kind = 'sampler'
    else if (type.startsWith('texture_storage')) kind = 'storageTexture'
    out.push({
      binding: Number(m[1]),
      group: Number(m[2]),
      name: m[4]!,
      kind,
      type
    })
  }
  return out
}
