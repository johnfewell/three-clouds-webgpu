// Packs CPU values into a uniform buffer's bytes through the description's
// field map. Each value is written as its WGSL type's float32, u32 or i32
// words, which is how three uploads the same value

import type { FieldInfo } from './description'

interface Vector {
  x: number
  y: number
  z?: number
  w?: number
}
interface Matrix {
  elements: ArrayLike<number>
}

export type FieldValue =
  number | boolean | Vector | Matrix | readonly (number | Vector | Matrix)[]

type Scalar = 'f32' | 'u32' | 'i32'

// The scalar type, component count and padded column layout of a WGSL type
interface Shape {
  scalar: Scalar
  // words per column, then columns, then the padded column stride in words
  rows: number
  columns: number
  columnStride: number
}

const ARRAY = /^array<(.+),\s*(\d+)>$/

function shapeOf(type: string): Shape {
  const scalar = /^(f32|u32|i32)$/.exec(type)
  if (scalar != null)
    return { scalar: scalar[1] as Scalar, rows: 1, columns: 1, columnStride: 1 }
  const vec = /^vec([234])<(f32|u32|i32)>$/.exec(type)
  if (vec != null) {
    const n = Number(vec[1])
    return { scalar: vec[2] as Scalar, rows: n, columns: 1, columnStride: n }
  }
  const mat = /^mat([234])x([234])<f32>$/.exec(type)
  if (mat != null) {
    const columns = Number(mat[1])
    const rows = Number(mat[2])
    // vec3 columns are padded to vec4
    return { scalar: 'f32', rows, columns, columnStride: rows === 3 ? 4 : rows }
  }
  throw new Error(`unsupported WGSL type ${type}`)
}

function components(value: FieldValue, rows: number): number[] {
  if (typeof value === 'number') return [value]
  if (typeof value === 'boolean') return [value ? 1 : 0]
  if ('elements' in value) return Array.from(value.elements)
  if ('x' in value) {
    const v = [value.x, value.y, value.z ?? 0, value.w ?? 0]
    return v.slice(0, rows)
  }
  throw new Error('array value for a non-array field')
}

function writeWords(
  view: DataView,
  offset: number,
  shape: Shape,
  value: FieldValue
): void {
  const words = components(value, shape.rows)
  const put =
    shape.scalar === 'f32'
      ? (o: number, x: number) => view.setFloat32(o, x, true)
      : shape.scalar === 'u32'
        ? (o: number, x: number) => view.setUint32(o, x, true)
        : (o: number, x: number) => view.setInt32(o, x, true)
  // a vector shorter than its type (a Vec2 in a vec4 slot) leaves zeros
  for (let i = 0; i < words.length; i++) {
    const column = Math.floor(i / shape.rows)
    const row = i % shape.rows
    if (column >= shape.columns) break
    put(offset + (column * shape.columnStride + row) * 4, words[i]!)
  }
}

// Writes one field's value at its offset in `target`
export function packField(
  target: DataView,
  field: FieldInfo,
  value: FieldValue
): void {
  const array = ARRAY.exec(field.type)
  if (array == null) {
    if (Array.isArray(value))
      throw new Error(`${field.name}: array value for ${field.type}`)
    writeWords(target, field.offset, shapeOf(field.type), value)
    return
  }
  if (!Array.isArray(value))
    throw new Error(`${field.name}: ${field.type} needs an array value`)
  const element = shapeOf(array[1]!)
  const count = Number(array[2])
  // uniform address space: every array element is 16-byte aligned
  const elementSize =
    Math.ceil((element.columns * element.columnStride * 4) / 16) * 16
  const items = value as readonly FieldValue[]
  if (items.length > count)
    throw new Error(`${field.name}: ${items.length} values for ${field.type}`)
  for (let i = 0; i < items.length; i++)
    writeWords(target, field.offset + i * elementSize, element, items[i]!)
}
