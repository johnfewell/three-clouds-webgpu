// The runtime's bookkeeping on a recording device: which schedule part a
// frame runs, which buffers it refuses, and what a resize re-creates. The GPU
// proof (core/scripts/prove-runtime.mjs) covers the pixels

import { log } from '../../../test/helpers/log'
import type { Description, Step } from './description'
import type { GpuDevice } from './gpu'
import { createRuntime } from './runtime'
import { RuntimeSession } from './session'

interface Call {
  op: string
  label?: string
  size?: number[]
}

interface Labelled {
  label?: string
}

function recordingDevice(calls: Call[]): GpuDevice {
  const object = (op: string) => (d: Record<string, unknown>) => {
    calls.push({ op, label: d['label'] as string | undefined })
    return {}
  }
  const pass = {
    setPipeline: () => calls.push({ op: 'setPipeline' }),
    setBindGroup: () => calls.push({ op: 'setBindGroup' }),
    setVertexBuffer: () => undefined,
    setIndexBuffer: () => undefined,
    draw: (...args: number[]) => calls.push({ op: 'draw', size: args }),
    drawIndexed: () => undefined,
    dispatchWorkgroups: () => undefined,
    setViewport: () => undefined,
    setScissorRect: () => undefined,
    end: () => undefined
  }
  return {
    createTexture: d => {
      calls.push({
        op: 'createTexture',
        label: d['label'] as string,
        size: d['size'] as number[]
      })
      return { createView: () => ({}), destroy: () => undefined }
    },
    createSampler: object('createSampler'),
    createBuffer: d => ({ label: d['label'] as string }),
    createShaderModule: object('createShaderModule'),
    createBindGroupLayout: object('createBindGroupLayout'),
    createPipelineLayout: object('createPipelineLayout'),
    createRenderPipeline: d => {
      calls.push({ op: 'createRenderPipeline', label: d['label'] as string })
      return { getBindGroupLayout: () => ({}) }
    },
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: object('createBindGroup'),
    createCommandEncoder: () => ({
      beginRenderPass: d => {
        const color = (d['colorAttachments'] as unknown[]).length
        calls.push({ op: 'beginRenderPass', size: [color] })
        return pass
      },
      beginComputePass: () => pass,
      finish: () => ({})
    }),
    queue: {
      writeBuffer: (buffer, _offset, data) =>
        calls.push({
          op: 'writeBuffer',
          label: (buffer as Labelled).label,
          size: Array.from(new Float32Array(data.slice().buffer))
        }),
      submit: () => calls.push({ op: 'submit' })
    }
  }
}

// A one-pass graph: `part` labels which schedule part drew
function draw(target: string, part: number): Step {
  return {
    kind: 'submit',
    commands: [
      { cmd: 'beginRenderPass', colorAttachments: [{ texture: target }] },
      { cmd: 'setPipeline', pipeline: 'p' },
      { cmd: 'setBindGroup', index: 0, bindGroup: 'g' },
      { cmd: 'draw', args: [3, 1, 0, part] },
      { cmd: 'end' }
    ]
  }
}

function description(): Description {
  return {
    format: 'three-clouds-core/description',
    version: 1,
    source: {},
    device: { requiredFeatures: [] },
    modules: { m: { stage: 'vertex', sha256: '', code: '' } },
    textures: {
      canvas: {
        size: [4, 2],
        format: 'bgra8unorm',
        usage: 16,
        external: 'canvas'
      },
      full: { size: [4, 2, 1], format: 'rgba16float', usage: 20 },
      atlas: { size: [8, 8, 3], format: 'rgba16float', usage: 20 }
    },
    samplers: {},
    buffers: {
      geometry: { size: 24, usage: 44 },
      u: {
        size: 8,
        usage: 72,
        fields: [
          { name: 'three_screenSize', type: 'vec2<f32>', offset: 0, size: 8 }
        ]
      }
    },
    bindGroupLayouts: { l: [] },
    bindGroups: {
      g: {
        layout: 'l',
        entries: [
          { binding: 0, texture: 'full', view: {} },
          { binding: 1, buffer: 'u' }
        ]
      }
    },
    pipelines: {
      p: { kind: 'render', layout: ['l'], vertex: { module: 'm' } }
    },
    schedule: {
      init: [],
      frames: [[draw('full', 0)], [draw('full', 1)], [draw('canvas', 2)]],
      linear: []
    }
  }
}

const session = () =>
  new RuntimeSession({
    inputs: {},
    atmosphere: {},
    camera: {
      fov: 50,
      aspect: 2,
      near: 1,
      far: 10,
      zoom: 1,
      matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    },
    size: { width: 4, height: 2, cssWidth: 4, cssHeight: 2, pixelRatio: 1 },
    app: { fields: {}, objects: {} }
  })

const geometry = { geometry: new Uint8Array(24) }
const upload = () => Promise.resolve()

describe('runtime bookkeeping', () => {
  it('frame k runs the reset part once, then alternates the two parities', () => {
    const calls: Call[] = []
    const device = recordingDevice(calls)
    const runtime = createRuntime({
      device,
      description: description(),
      staticBuffers: geometry,
      upload
    })
    const sources = session().update()
    const parts: number[] = []
    for (let k = 0; k < 6; k++) {
      const before = calls.length
      runtime.frame(k, sources)
      // the draw's last argument is the part's label
      const drawn = calls.slice(before).filter(c => c.op === 'draw')
      parts.push(...drawn.map(c => c.size![3]!))
    }
    log('parts', { parts: parts.join(' ') })
    expect(parts).toEqual([0, 1, 2, 1, 2, 1])
  })

  it('refuses a buffer that has neither bytes nor a field map', () => {
    expect(() =>
      createRuntime({
        device: recordingDevice([]),
        description: description(),
        staticBuffers: {},
        upload
      })
    ).toThrow(/no bytes and no field map: geometry/)
  })

  it('a resize re-creates the canvas-sized textures and their bind groups', () => {
    const calls: Call[] = []
    const runtime = createRuntime({
      device: recordingDevice(calls),
      description: description(),
      staticBuffers: geometry,
      upload
    })
    const sources = session().update()
    runtime.frame(1, sources)
    const before = calls.length
    runtime.resize(6, 3)
    runtime.frame(1, sources)
    const after = calls.slice(before)
    const created = after
      .filter(c => c.op === 'createTexture')
      .map(c => `${c.label} ${c.size!.join('x')}`)
    const groups = after.filter(c => c.op === 'createBindGroup').length
    log('resize', { created: created.join(', '), bindGroups: groups })
    expect(created.sort()).toEqual(['canvas 6x3', 'full 6x3x1'])
    expect(groups).toBe(1)
  })

  it('three_screenSize follows the render target through a resize', () => {
    const calls: Call[] = []
    const runtime = createRuntime({
      device: recordingDevice(calls),
      description: description(),
      staticBuffers: geometry,
      upload
    })
    const sources = session().update()
    const written = () => {
      const before = calls.length
      runtime.frame(1, sources)
      return calls.slice(before).find(c => c.label === 'u')!.size!
    }
    const sizes = [written()]
    runtime.resize(6, 3)
    sizes.push(written())
    log('screenSize', {
      before: sizes[0]!.join('x'),
      after: sizes[1]!.join('x')
    })
    expect(sizes).toEqual([
      [4, 2],
      [6, 3]
    ])
  })
})
