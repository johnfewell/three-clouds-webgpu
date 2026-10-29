// The graph description, version 1, as core/DESCRIPTION.md defines it. Plain
// data the runtime reads, with no three and no GPU types

export interface FieldInfo {
  name: string
  type: string
  offset: number
  size: number
}

export interface BufferInfo {
  size: number
  usage: number
  struct?: string
  fields?: FieldInfo[]
}

export interface TextureInfo {
  size: number[]
  format: string
  dimension?: string
  mipLevelCount?: number
  sampleCount?: number
  usage: number
  viewFormats?: string[]
  external?: 'canvas'
  content?: { file?: string; generated?: string }
}

export interface BindGroupEntryInfo {
  binding: number
  sampler?: string
  texture?: string
  view?: Record<string, unknown>
  buffer?: string
  offset?: number
  size?: number
}

export interface StageInfo {
  module: string
  entryPoint?: string
  [key: string]: unknown
}

export interface PipelineInfo {
  kind: 'render' | 'compute'
  layout: string[] | 'auto'
  vertex?: StageInfo
  fragment?: StageInfo
  compute?: StageInfo
  primitive?: Record<string, unknown>
  depthStencil?: Record<string, unknown>
  multisample?: Record<string, unknown>
}

export interface Command {
  cmd: string
  [key: string]: unknown
}

export interface WriteStep {
  kind: 'write'
  buffer: string
  offset: number
  size: number
  fields: string[]
}

export interface SubmitStep {
  kind: 'submit'
  commands: Command[]
}

export interface UploadStep {
  kind: 'writeTexture' | 'copyExternalImage'
  texture: string
  args: unknown
}

export type Step = WriteStep | SubmitStep | UploadStep

export interface Description {
  format: string
  version: number
  source: Record<string, unknown>
  device: { requiredFeatures: string[] }
  modules: Record<string, { stage: string; sha256: string; code: string }>
  textures: Record<string, TextureInfo>
  samplers: Record<string, Record<string, unknown>>
  buffers: Record<string, BufferInfo>
  bindGroupLayouts: Record<string, unknown[]>
  bindGroups: Record<string, { layout: string; entries: BindGroupEntryInfo[] }>
  pipelines: Record<string, PipelineInfo>
  schedule: { init: Step[]; frames: Step[][]; linear: Step[] }
}

export const DESCRIPTION_FORMAT = 'three-clouds-core/description'

export function checkDescription(d: Description): Description {
  if (d.format !== DESCRIPTION_FORMAT || d.version !== 1)
    throw new Error(`unsupported description ${d.format} v${d.version}`)
  if (d.schedule.frames.length !== 3)
    throw new Error(`expected 3 frame parts, got ${d.schedule.frames.length}`)
  return d
}

// frames[0] follows a reset, then the two ping-pong parities alternate
export function framePart(k: number): number {
  return k === 0 ? 0 : k % 2 === 1 ? 1 : 2
}
