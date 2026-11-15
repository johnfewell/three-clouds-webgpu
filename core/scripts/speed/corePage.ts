// The core's bench page: the runtime on an emitted description, the same
// startup as core/scripts/runtime-proof/page.js, presenting to a real canvas
// Needs a description and state from core/scripts/emit-runtime.mjs --width --height
import * as R from '../../src/runtime/index'
import { firstFrames, marks, timedFrames, vsyncLoop } from './measure.js'

const params = new URLSearchParams(location.search)
const base = params.get('generated')!
const dpr = Number(params.get('dpr') ?? '1')
const json = async (name: string) =>
  (await fetch(`${base}/${name}`)).json() as Promise<never>
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

type Description = Parameters<typeof R.createRuntime>[0]['description']
interface State {
  initial: { init: Record<string, string>; frames: Record<string, string> }
}
// bytes the core does not compute (geometry, star catalogue, the scene
// object), exactly as the proof page sends them
function staticBuffers(d: Description, state: State) {
  const out: Record<string, Uint8Array> = {}
  const initial = { ...state.initial.init, ...state.initial.frames }
  for (const [name, b] of Object.entries(d.buffers)) {
    const fields = (b as { fields?: unknown[] }).fields
    if ((fields?.length ?? 0) > 0 && name !== 'ground.object') continue
    if (initial[name] == null) throw new Error(`no bytes for ${name}`)
    out[name] = b64(initial[name])
  }
  return out
}

const adapter = (await navigator.gpu.requestAdapter())!
const description: Description = await json('description.json')
const state: State = await json('state.json')
const setup: ConstructorParameters<typeof R.RuntimeSession>[0] =
  await json('setup.json')
marks.loaded = performance.now()
const wanted = (
  description as unknown as { device: { requiredFeatures: GPUFeatureName[] } }
).device.requiredFeatures.filter(f => adapter.features.has(f))
const device = await adapter.requestDevice({ requiredFeatures: wanted })

const [width, height] = (
  description.textures as unknown as Record<string, { size: number[] }>
).canvas!.size as [number, number]
const canvas = document.createElement('canvas')
canvas.width = width
canvas.height = height
canvas.style.width = `${width / dpr}px`
canvas.style.height = `${height / dpr}px`
document.body.append(canvas)
const context = canvas.getContext('webgpu')!
context.configure({
  device,
  format: 'bgra8unorm',
  alphaMode: 'premultiplied',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
})

const session = new R.RuntimeSession(setup)
for (let k = 0; k < 4; k++) {
  session.update()
  session.afterRender()
}
session.resetHistory()
const tCreate = performance.now()
const runtime = R.createRuntime({
  device: device as never,
  description,
  staticBuffers: staticBuffers(description, state),
  upload: R.browserUpload(
    device.queue as never,
    description.textures,
    '/assets'
  )
})
marks.createRuntimeMs = performance.now() - tCreate
await runtime.init(session.update())
marks.ready = performance.now()

let k = 0
const frame = (i: number) => {
  void i
  const sources = session.update()
  runtime.frame(k++, sources, context.getCurrentTexture() as never)
  session.afterRender()
}
await firstFrames(device, frame, 5)

window.__speed = {
  side: 'core',
  marks,
  canvas: { width: canvas.width, height: canvas.height },
  async timed(warmup: number, samples: number) {
    session.resetHistory()
    k = 0
    return timedFrames({ device, frame, warmup, samples })
  },
  async free(warmup: number, seconds: number) {
    return vsyncLoop({ device, frame, warmup, seconds, start: 0 })
  },
  compile: () =>
    (window as unknown as { __speedInstrument: unknown }).__speedInstrument
}
