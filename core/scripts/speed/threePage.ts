// The three package's bench page: side B built the way the core's
// description was emitted (core/emit/sideBGraph.ts), on a real canvas, with
// no WebGL reference side booting beside it
import { caseByName } from '../../../examples/parity/cases/index'
import {
  applyToB,
  buildCaseParityState,
  caseToParityCase,
  PHASE0_CASES
} from '../../../examples/parity/src/parityState'
import { createSideB } from '../../../examples/parity/src/sideB'
import { firstFrames, marks, timedFrames, vsyncLoop } from './measure.js'

const params = new URLSearchParams(location.search)
const caseName = params.get('case') ?? 'baseline-medium'
const width = Number(params.get('w'))
const height = Number(params.get('h'))
const dpr = Number(params.get('dpr') ?? '1')

const cd = caseByName(caseName)
const found =
  PHASE0_CASES.find(c => c.name === caseName) ??
  (cd == null ? null : caseToParityCase(cd))
if (found == null) throw new Error(`unknown case ${caseName}`)
const pc = { ...found, width, height }
const canvas = document.createElement('canvas')
document.body.append(canvas)
const sideB = await createSideB({ canvas, lighting: pc.lighting })
sideB.applyCase(pc)
const baseState = cd == null ? null : buildCaseParityState(cd)
if (baseState != null) applyToB(baseState, sideB)
// physical pixels as the core renders them, shown at the page's DPR
canvas.style.width = `${width / dpr}px`
canvas.style.height = `${height / dpr}px`
// the bench times every pass itself, the same way on both pages
const backend = (
  sideB.renderer as unknown as {
    backend: { device: GPUDevice; trackTimestamp: boolean }
  }
).backend
backend.trackTimestamp = false
const device = backend.device
marks.ready = performance.now()

const frame = (i: number) => {
  void i
  sideB.cloudsContext.frame = pc.frame
  sideB.render()
}
sideB.resetTemporalHistory()
await firstFrames(device, frame, 5)

declare global {
  interface Window {
    __speed: Record<string, unknown>
  }
}
window.__speed = {
  side: 'three',
  marks,
  canvas: { width: canvas.width, height: canvas.height },
  async timed(warmup: number, samples: number) {
    sideB.resetTemporalHistory()
    return timedFrames({ device, frame, warmup, samples })
  },
  // A knob arm: the case's state, a preset, then dotted paths. mapSize is a
  // fresh vector, since a preset's own Vector2 is shared with the preset table
  configure(arm: { preset?: string; set?: [string, unknown][] }) {
    const ctx = sideB.cloudsContext as unknown as Record<string, unknown> & {
      shadow: {
        mapSize: {
          constructor: new (x: number, y: number) => unknown
          x: number
          y: number
        }
      }
      graphVersion: number
    }
    const fresh = (x: number, y: number) =>
      new ctx.shadow.mapSize.constructor(x, y)
    ctx.shadow.mapSize = fresh(
      ctx.shadow.mapSize.x,
      ctx.shadow.mapSize.y
    ) as never
    if (baseState != null) applyToB(baseState, sideB)
    if (arm.preset != null) {
      ctx['qualityPreset'] = arm.preset
      ctx.shadow.mapSize = fresh(
        ctx.shadow.mapSize.x,
        ctx.shadow.mapSize.y
      ) as never
    }
    for (const [path, value] of arm.set ?? []) {
      const keys = path.split('.')
      let target = ctx as Record<string, unknown>
      for (const k of keys.slice(0, -1))
        target = target[k] as Record<string, unknown>
      const last = keys.at(-1)!
      if (!(last in target)) throw new Error(`no knob ${path}`)
      target[last] =
        last === 'mapSize' ? fresh(...(value as [number, number])) : value
    }
    const read = (path: string) =>
      path
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], ctx)
    return {
      graphVersion: ctx.graphVersion,
      readBack: Object.fromEntries(
        (arm.set ?? []).map(([path]) => [
          path,
          JSON.parse(JSON.stringify(read(path)))
        ])
      )
    }
  },
  async free(warmup: number, seconds: number) {
    return vsyncLoop({ device, frame, warmup, seconds, start: 0 })
  },
  compile: () =>
    (window as unknown as { __speedInstrument: unknown }).__speedInstrument
}
