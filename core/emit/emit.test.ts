// The emitter's contract, checked on the fake device with no GPU: the default
// graph comes out fully named, every uniform buffer's field map fits the
// buffer, and the description replays to the same command stream three made

import { log } from '../../test/helpers/log'
import type { Description, State } from './describe'
import { emitDescription, type EmitResult } from './emit'
import { installFakeGpu, type GpuTrace } from './fakeGpu'
import { parseStructs, structLayout } from './wgslLayout'

let emitted: EmitResult

beforeAll(async () => {
  emitted = await emitDescription({ caseName: 'baseline-medium' })
}, 300_000)

describe('the default graph description', () => {
  it('names every uniform: no nodeUniformN, NodeBuffer_N or WorkgroupArray_N', () => {
    const { description, naming } = emitted
    const modules = Object.entries(description.modules)
    // A check over zero modules would pass by not looking
    expect(modules.length).toBeGreaterThan(10)
    const anonymous = modules.flatMap(([name, m]) =>
      [
        ...m.code.matchAll(
          /\b(nodeUniform\d+|NodeBuffer_\d+|WorkgroupArray_\d+)\b/g
        )
      ].map(x => `${name}: ${x[1]}`)
    )
    log('naming', {
      modules: modules.length,
      namedByEmitter: naming.assigned.length,
      unnamedInSource: naming.anonymous.length,
      anonymousInWGSL: anonymous.length
    })
    expect(naming.anonymous).toEqual([])
    expect(anonymous).toEqual([])
  })

  it('gives every uniform buffer a field map that fits the buffer three made', () => {
    const rows = Object.entries(emitted.description.buffers)
      .filter(([, b]) => b.fields != null)
      .map(([name, b]) => {
        const fields = b.fields!
        const last = fields[fields.length - 1]!
        const end = last.offset + last.size
        return {
          name,
          size: b['size'] as number,
          fields: fields.length,
          end,
          unique: new Set(fields.map(f => f.name)).size === fields.length
        }
      })
    log('field maps', rows)
    expect(rows.length).toBeGreaterThan(10)
    for (const r of rows) {
      expect(r.unique).toBe(true)
      // three sizes a uniform buffer to its struct, rounded up to 16 bytes
      expect(r.size).toBe(Math.ceil(r.end / 16) * 16)
    }
  })

  it('carries the init the frames depend on: uploads, mips and the four LUTs', () => {
    const init = emitted.description.schedule.init
    const pipelines = init.flatMap(s =>
      s.kind === 'submit'
        ? s.commands.flatMap(c =>
            c['cmd'] === 'setPipeline' ? [c['pipeline'] as string] : []
          )
        : []
    )
    const uploads = init.flatMap(s =>
      s.kind === 'writeTexture' || s.kind === 'copyExternalImage'
        ? [s.texture]
        : []
    )
    log('init', { uploads: uploads.join(' '), passes: pipelines.length })
    expect(uploads.sort()).toEqual([
      'localWeather',
      'shape',
      'shapeDetail',
      'stbn'
    ])
    expect(pipelines.filter(p => p.startsWith('compute_'))).toEqual([
      'compute_transmittance',
      'compute_multipleScattering',
      'compute_scattering',
      'compute_irradiance'
    ])
    // the local weather mip chain: 512 square, levels 1 to 9
    expect(pipelines.filter(p => p.startsWith('mipmap')).length).toBe(9)
  })
})

describe('emitting twice in one process', () => {
  // The naming hooks live on three's prototypes. A second emit must name
  // with its own textures, not the first run's (the emitter produces 5 cases)
  it('names the second emit exactly as the first', async () => {
    const again = await emitDescription({ caseName: 'baseline-medium' })
    const differing = Object.keys(emitted.description.modules).filter(
      name =>
        again.description.modules[name]?.code !==
        emitted.description.modules[name]!.code
    )
    log('second emit', {
      modules: Object.keys(again.description.modules).length,
      differing: differing.length,
      unnamedTextures: Object.values(again.description.modules).filter(m =>
        m.code.includes('unnamedTexture')
      ).length
    })
    expect(differing).toEqual([])
  }, 300_000)
})

describe('the description replays to the command stream three made', () => {
  // What the queue executes, in its order: each write with its offset and
  // size, and each submit's commands with their plain arguments. Encoding
  // order is not compared, three interleaves it with its writes
  function queueStream(trace: GpuTrace, from: number, to: number): string[] {
    const ownerOf = new Map<number, number>()
    const commands = new Map<number, string[]>()
    const encoderOf = new Map<number, number>()
    // a trailing undefined is the API default, as if it were left out
    const plain = (args: unknown[]) => {
      const kept = [...args]
      while (kept.length > 0 && kept[kept.length - 1] == null) kept.pop()
      return JSON.stringify(
        kept.map(a =>
          a != null && typeof a === 'object' && '$r' in a ? '*' : a
        )
      )
    }
    for (const o of trace.ops) {
      const m = o.op.match(
        /^GPU(CommandEncoder|RenderPassEncoder|ComputePassEncoder)\.(\w+)$/
      )
      if (m == null) continue
      const encoder =
        m[1] === 'CommandEncoder' ? o.self : (ownerOf.get(o.self) ?? -1)
      if (m[2]!.startsWith('begin') && o.ret != null)
        ownerOf.set(o.ret, encoder)
      if (m[2] === 'finish' && o.ret != null) encoderOf.set(o.ret, encoder)
      else {
        const list = commands.get(encoder) ?? []
        list.push(m[2]!.startsWith('begin') ? m[2]! : `${m[2]}${plain(o.args)}`)
        commands.set(encoder, list)
      }
    }
    return trace.ops.slice(from, to).flatMap(o => {
      if (o.op === 'GPUQueue.writeBuffer') {
        const [, offset, bytes] = o.args as [unknown, number, Uint8Array]
        return [`write@${offset}+${bytes.length}`]
      }
      if (o.op !== 'GPUQueue.submit') return []
      return (o.args[0] as { $r: number }[]).flatMap(
        cb => commands.get(encoderOf.get(cb.$r) ?? -1) ?? []
      )
    })
  }

  async function replayTrace(
    description: Description,
    state: State,
    frames: number
  ) {
    const trace = installFakeGpu()
    const adapter = await (
      navigator as unknown as {
        gpu: {
          requestAdapter: () => Promise<{
            requestDevice: (d: object) => Promise<unknown>
          }>
        }
      }
    ).gpu.requestAdapter()
    const device = await adapter.requestDevice({})
    const g = globalThis as Record<string, unknown>
    g['Image'] = class {
      decode() {
        return Promise.resolve()
      }
    }
    const fetchBefore = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(new Response(new Uint8Array(4 << 20)))
    try {
      const { createReplay } = (await import('./replay/replay.js')) as {
        createReplay: (...a: unknown[]) => Promise<{
          frame: (k: number) => Promise<void>
          linear: () => Promise<void>
        }>
      }
      const replay = await createReplay(device, description, state, 'assets')
      const marks: number[] = []
      for (let k = 0; k < frames; k++) {
        marks.push(trace.ops.length)
        await replay.frame(k)
      }
      marks.push(trace.ops.length)
      await replay.linear()
      marks.push(trace.ops.length)
      return { trace, marks }
    } finally {
      globalThis.fetch = fetchBefore
    }
  }

  it('frames 0 to 3 and the linear readback match three op for op', async () => {
    const { description, state, trace: original } = emitted
    const { trace, marks } = await replayTrace(description, state, 4)
    const at = (label: string) =>
      original.ops.findIndex(o => o.op === 'mark' && o.args[0] === label)
    const theirs = [0, 1, 2, 3].map(k =>
      queueStream(
        original,
        at(`frame-${k}`),
        at(k < 3 ? `frame-${k + 1}` : 'linear')
      )
    )
    theirs.push(queueStream(original, at('linear'), at('end')))
    const ours = marks
      .slice(0, -1)
      .map((m, i) => queueStream(trace, m, marks[i + 1]!))
    log(
      'command streams',
      ours.map((s, i) => ({
        part: i,
        ours: s.length,
        three: theirs[i]!.length
      }))
    )
    expect(ours[0]!.length).toBeGreaterThan(50)
    expect(ours).toEqual(theirs)
  }, 120_000)
})

describe('wgslLayout', () => {
  it('lays out a uniform struct by WGSL host-shareable rules', () => {
    // offsets worked by hand: vec3 aligns to 16, a mat3 is three vec4 columns,
    // an array element strides 16 in the uniform address space
    const code = `struct S {
      a : f32,
      b : vec3<f32>,
      c : vec2<f32>,
      d : mat3x3<f32>,
      e : array<vec2<f32>, 3>,
      f : u32
    };`
    const layout = structLayout('S', parseStructs(code))
    const offsets = layout.fields.map(f => [f.name, f.offset, f.size])
    log('layout', { offsets: JSON.stringify(offsets), size: layout.size })
    expect(offsets).toEqual([
      ['a', 0, 4],
      ['b', 16, 12],
      ['c', 32, 8],
      ['d', 48, 48],
      ['e', 96, 48],
      ['f', 144, 4]
    ])
    expect(layout.size).toBe(160)
  })
})
