// Turns the schedule's uniform writes into bytes computed from the CPU state,
// in place of state.json. No GPU: the runtime and the CPU test share this

import type {
  BufferInfo,
  Description,
  Step,
  SubmitStep,
  WriteStep
} from './description'
import { fieldValue, type FieldSite, type FieldSources } from './fieldValues'
import { packField } from './pack'

// three's QuadMesh is one triangle of three vertices, never indexed
function isQuad(submit: SubmitStep): boolean {
  const draws = submit.commands.filter(c => /^draw/.test(c.cmd))
  return (
    draws.length > 0 &&
    draws.every(c => c.cmd === 'draw' && (c['args'] as number[])[0] === 3)
  )
}

// The size of the pass's first colour target, null for the canvas: three's
// screenSize and viewport are the render target's when one is bound
function targetSize(d: Description, submit: SubmitStep): number[] | null {
  const begin = submit.commands.find(c => c.cmd === 'beginRenderPass')
  const colors = begin?.['colorAttachments'] as
    ({ texture: string } | null)[] | undefined
  const name = colors?.[0]?.texture
  const info = name == null ? undefined : d.textures[name]
  if (info == null || info.external != null) return null
  return info.size.slice(0, 2)
}

function pipelineOf(submit: SubmitStep): string {
  const set = submit.commands.find(c => c.cmd === 'setPipeline')
  return (set?.['pipeline'] as string | undefined) ?? ''
}

// The site of every write step: the repeat of its fields within the part, and
// the pass submitted next, whose camera and object the write is for
export function writeSites(
  d: Description,
  steps: Step[]
): (FieldSite | null)[] {
  const seen = new Map<string, number>()
  return steps.map((step, i) => {
    if (step.kind !== 'write') return null
    const key = `${step.buffer}:${step.offset}:${step.fields.join(',')}`
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    const next = steps
      .slice(i + 1)
      .find((s): s is SubmitStep => s.kind === 'submit')
    if (next == null) throw new Error(`write to ${step.buffer} with no submit`)
    return {
      buffer: step.buffer,
      occurrence,
      pipeline: pipelineOf(next),
      quad: isQuad(next),
      target: targetSize(d, next)
    }
  })
}

// Bytes for one write step: the step's fields packed into a scratch image of
// the whole buffer, then the step's byte range cut out of it
export function writeBytes(
  d: Description,
  step: WriteStep,
  site: FieldSite,
  sources: FieldSources
): Uint8Array {
  const info = bufferInfo(d, step.buffer)
  const image = new ArrayBuffer(info.size)
  const view = new DataView(image)
  for (const name of step.fields) {
    const field = info.fields!.find(f => f.name === name)
    if (field == null) throw new Error(`no field ${name} in ${step.buffer}`)
    packField(view, field, fieldValue(sources, name, site))
  }
  return new Uint8Array(image, step.offset, step.size)
}

function bufferInfo(d: Description, name: string): BufferInfo {
  const info = d.buffers[name]
  if (info?.fields == null) throw new Error(`${name} has no field map`)
  return info
}

// Which pass a whole-buffer image is for: the pass after the buffer's last
// write in a steady frame, else the first pass that binds it
export function bufferSite(d: Description, buffer: string): FieldSite {
  const steady = d.schedule.frames[1]!
  const sites = writeSites(d, steady)
  for (let i = steady.length - 1; i >= 0; i--) {
    const site = sites[i]
    if (site?.buffer !== buffer) continue
    const fields = (steady[i] as WriteStep).fields
    // the last draw's value is the one three leaves in the buffer
    if (fields.length > 0) return site
  }
  const groups = new Set(
    Object.entries(d.bindGroups)
      .filter(([, g]) => g.entries.some(e => e.buffer === buffer))
      .map(([name]) => name)
  )
  for (const part of [steady, d.schedule.linear, d.schedule.init]) {
    for (const step of part) {
      if (step.kind !== 'submit') continue
      const binds = step.commands.some(
        c => c.cmd === 'setBindGroup' && groups.has(c['bindGroup'] as string)
      )
      if (binds)
        return {
          buffer,
          occurrence: 0,
          pipeline: pipelineOf(step),
          quad: isQuad(step),
          target: targetSize(d, step)
        }
    }
  }
  throw new Error(`${buffer} is never bound`)
}

// Every field of a buffer, as three leaves it at the start of a frame
export function bufferImage(
  d: Description,
  buffer: string,
  sources: FieldSources,
  site = bufferSite(d, buffer)
): Uint8Array {
  const info = bufferInfo(d, buffer)
  const image = new ArrayBuffer(info.size)
  const view = new DataView(image)
  for (const field of info.fields!)
    packField(view, field, fieldValue(sources, field.name, site))
  return new Uint8Array(image)
}

// Buffers the runtime computes: every buffer with a field map
export function fieldBuffers(d: Description): string[] {
  return Object.entries(d.buffers)
    .filter(([, b]) => (b.fields?.length ?? 0) > 0)
    .map(([name]) => name)
}
