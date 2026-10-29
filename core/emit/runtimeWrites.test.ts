// Every uniform byte the runtime writes, computed from the CPU state by field
// name, against the bytes three wrote for the same case (state.json). A field
// that drifts here renders a different frame on the GPU

import { REVISION } from 'three'

import { log } from '../../test/helpers/log'
import { framePart, type Description } from '../src/runtime/description'
import { resizeTextures } from '../src/runtime/runtime'
import { RuntimeSession, type SessionSetup } from '../src/runtime/session'
import {
  bufferImage,
  fieldBuffers,
  writeBytes,
  writeSites
} from '../src/runtime/writes'
import { caseSetup } from './caseSetup'
import { emitDescription, type EmitResult } from './emit'

// The app's own scene object: its material and lights are not the core's
const APP_BUFFERS = new Set(['ground.object'])

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

interface Mismatch {
  where: string
  field: string
  ours: string
  three: string
}

function floats(bytes: Uint8Array): string {
  const copy = bytes.slice()
  return Array.from(new Float32Array(copy.buffer, 0, copy.length >> 2))
    .map(x => (Object.is(x, -0) ? '-0' : String(x)))
    .join(',')
}

// Compares two images of one buffer field by field, over the byte range
function compareFields(
  d: Description,
  where: string,
  buffer: string,
  start: number,
  ours: Uint8Array,
  three: Uint8Array,
  out: Mismatch[]
): number {
  let compared = 0
  for (const f of d.buffers[buffer]!.fields!) {
    const from = f.offset - start
    if (from < 0 || from + f.size > ours.length) continue
    compared++
    const a = ours.subarray(from, from + f.size)
    const b = three.subarray(from, from + f.size)
    if (a.some((x, i) => x !== b[i]))
      out.push({ where, field: f.name, ours: floats(a), three: floats(b) })
  }
  return compared
}

// Four graphs: the default, quarter-res temporal upscale at another pose,
// light shafts with a low sun, and the ultra preset with turbulence
const CASES = [
  'baseline-medium',
  'temporal-on-orbit',
  'shafts-low-sun',
  'preset-ultra'
]
const emitted = new Map<string, EmitResult>()

beforeAll(async () => {
  for (const caseName of CASES)
    emitted.set(caseName, await emitDescription({ caseName }))
}, 300_000)

function runCase(
  caseName: string,
  warmup: number,
  edit?: (setup: SessionSetup) => void
) {
  const { state, sideB, description } = emitted.get(caseName)!
  // the emitter's own type is loose JSON, the runtime's is the contract
  const d = description as unknown as Description
  const setup = caseSetup(sideB)
  edit?.(setup)
  const session = new RuntimeSession(setup)
  const mismatches: Mismatch[] = []
  let compared = 0
  const created: string[] = []
  // the emitter's protocol: build and settle, reset, then the frames
  for (let k = 0; k < warmup; k++) {
    session.update()
    session.afterRender()
  }
  session.resetHistory()
  const computed = fieldBuffers(d).filter(b => !APP_BUFFERS.has(b))
  for (let k = 0; k < 3; k++) {
    const sources = session.update()
    if (k === 0) {
      for (const buffer of computed) {
        const three = state.initial.frames[buffer] ?? state.initial.init[buffer]
        // created later (the linear pass): its writes are compared there
        if (three == null) {
          created.push(buffer)
          continue
        }
        const ours = bufferImage(d, buffer, sources)
        compared += compareFields(
          d,
          'initial',
          buffer,
          0,
          ours,
          b64(three),
          mismatches
        )
      }
    }
    const parts: [string, number][] = [[`frame ${k}`, framePart(k)]]
    for (const [where, part] of parts) {
      const steps = d.schedule.frames[part]!
      const payloads = state.writes.frames[part]!
      compared += compareSteps(d, where, steps, payloads, sources, mismatches)
    }
    session.afterRender()
  }
  // the linear readback follows the last frame with its values
  compared += compareSteps(
    d,
    'linear',
    d.schedule.linear,
    state.writes.linear,
    session.sources,
    mismatches
  )
  return { compared, mismatches, computed, created }
}

function compareSteps(
  d: Description,
  where: string,
  steps: Description['schedule']['linear'],
  payloads: string[],
  sources: RuntimeSession['sources'],
  out: Mismatch[]
): number {
  const sites = writeSites(d, steps)
  let w = 0
  let compared = 0
  steps.forEach((step, i) => {
    if (step.kind !== 'write') return
    const three = b64(payloads[w++]!)
    const ours = writeBytes(d, step, sites[i]!, sources)
    compared += compareFields(
      d,
      `${where} #${i}`,
      step.buffer,
      step.offset,
      ours,
      three,
      out
    )
  })
  if (w !== payloads.length)
    throw new Error(`${where}: used ${w} of ${payloads.length} payloads`)
  return compared
}

describe.each(CASES)('runtime uniform writes equal three for %s', name => {
  it('every computed field, initial images and every scheduled write', () => {
    const { compared, mismatches, computed, created } = runCase(name, 4)
    log('runtime writes', {
      buffers: computed.length,
      createdLater: created.join(' '),
      fieldsCompared: compared,
      mismatches: mismatches.length
    })
    for (const m of mismatches.slice(0, 40)) log('mismatch', { ...m })
    // a comparison over nothing would pass vacuously. three 0.185.1 writes
    // 266-285 fields per case and r186, sharing more uniforms, 242-259
    expect(computed.length).toBeGreaterThan(15)
    expect(compared).toBeGreaterThan(REVISION.startsWith('186') ? 200 : 250)
    expect(mismatches).toEqual([])
  })

  it('sees a one-ulp change of one input (positive control)', () => {
    const { mismatches } = runCase(name, 4, setup => {
      const c = setup.inputs['coverage'] as number
      setup.inputs['coverage'] = c + c * 2 ** -23
    })
    const fields = [...new Set(mismatches.map(m => m.field))]
    log('control', { mismatches: mismatches.length, fields: fields.join(' ') })
    expect(fields).toEqual(['parameter_coverage'])
  })

  it('sees the wrong camera on a shared render group (positive control)', () => {
    const { mismatches } = runCase(name, 4, setup => {
      setup.camera.near *= 1.5
    })
    const fields = new Set(mismatches.map(m => m.field))
    log('near control', { mismatches: mismatches.length })
    expect(fields.has('cameraProjectionMatrix')).toBe(true)
  })
})

describe('resize', () => {
  it('baseline-medium resized to 320x180 is orbit-140km, texture for texture', async () => {
    // the same knobs at another size and pose: only the sizes may differ
    const small = await emitDescription({ caseName: 'orbit-140km' })
    const big = emitted.get('baseline-medium')!.description
    const info = structuredClone((big as unknown as Description).textures)
    const resized = resizeTextures(info, 320, 180)
    const want = (small.description as unknown as Description).textures
    log('resize', {
      resized: resized.length,
      textures: Object.keys(want).length
    })
    expect(resized.length).toBeGreaterThan(5)
    expect(info).toEqual(want)
    // and nothing else in the graph differs, WGSL included
    const rest = (x: unknown) => {
      const { textures: _t, source: _s, ...r } = x as Description
      return r
    }
    expect(rest(big)).toEqual(rest(small.description))
  })
})
