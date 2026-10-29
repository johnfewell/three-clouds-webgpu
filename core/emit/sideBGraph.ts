// Drives the parity harness's side B through one graph build, a history reset
// and a short frame sequence on the fake device, the same protocol the spike
// recorded on hardware, so the trace holds every pass of a default frame

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImageLoader } from 'three'

import { caseByName } from '../../examples/parity/cases/index'
import {
  applyToB,
  buildCaseParityState,
  caseToParityCase,
  PHASE0_CASES
} from '../../examples/parity/src/parityState'
import { createSideB } from '../../examples/parity/src/sideB'
import { createFakeCanvas, type GpuTrace } from './fakeGpu'

export interface SideBRunOptions {
  caseName: string
  assetsDir: string
  atmosphereAssetsDir: string
  frames: number
  maxWarmup: number
  // filled with the assets' roles before the first build, for WGSL names
  textureRoles: Map<object, string>
}

// PNG width and height from the IHDR chunk. The image content never reaches
// the description, only its size and format
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function installAssetLoaders(assetsDir: string, atmosphereAssetsDir: string) {
  // the browser fetches the star catalogue from the atmosphere package's
  // GitHub media URL. The package ships the same file
  const file = (url: string) =>
    url.includes('/packages/atmosphere/assets/')
      ? readFileSync(join(atmosphereAssetsDir, url.replace(/^.*\//, '')))
      : readFileSync(join(assetsDir, url.replace(/^.*\/assets\//, '')))
  const realFetch = globalThis.fetch
  // the stars catalogue is an inline data: URL in the atmosphere package
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('data:')) return realFetch(input, init)
    return Promise.resolve(new Response(file(url)))
  }
  const proto = ImageLoader.prototype as unknown as {
    load: (url: string, onLoad: (image: unknown) => void) => unknown
  }
  proto.load = function load(url, onLoad) {
    const image = { ...pngSize(file(url)), url, fake: true }
    queueMicrotask(() => onLoad(image))
    return image
  }
}

export async function runSideB(trace: GpuTrace, opts: SideBRunOptions) {
  installAssetLoaders(opts.assetsDir, opts.atmosphereAssetsDir)
  const cd = caseByName(opts.caseName)
  const pc =
    PHASE0_CASES.find(c => c.name === opts.caseName) ??
    (cd == null ? null : caseToParityCase(cd))
  if (pc == null) throw new Error(`unknown case ${opts.caseName}`)
  const canvas = createFakeCanvas(trace, pc.width, pc.height)
  trace.mark('create')
  const sideB = await createSideB({
    canvas: canvas as unknown as HTMLCanvasElement,
    lighting: pc.lighting
  })
  sideB.applyCase(pc)
  if (cd != null) applyToB(buildCaseParityState(cd), sideB)
  for (const [texture, role] of assetRoles(sideB))
    opts.textureRoles.set(texture, role)
  const nodeFrame = (
    sideB.renderer as unknown as {
      _nodes: { nodeFrame: { frameId: number; update: () => void } }
    }
  )._nodes.nodeFrame
  // a browser frame boundary: three advances FRAME-type nodes once per frame
  // and loaders (the star catalogue) settle between frames
  const nextFrame = async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    nodeFrame.update()
  }
  // Settle: the LUT precompute and the first pipelines are spread over the
  // first frames. A frame that creates nothing and dispatches nothing is the
  // steady state the description is read from
  const busy = (from: number) =>
    trace.ops
      .slice(from)
      .some(o =>
        /createRenderPipeline|createComputePipeline|createShaderModule|dispatchWorkgroups/.test(
          o.op
        )
      )
  trace.mark('build')
  let settled = 0
  for (let k = 0; k < opts.maxWarmup && settled < 2; k++) {
    const from = trace.ops.length
    sideB.cloudsContext.frame = pc.frame
    sideB.render()
    await nextFrame()
    settled = busy(from) ? 0 : settled + 1
  }
  if (settled < 2) throw new Error('the graph did not settle')
  trace.mark('reset')
  sideB.resetTemporalHistory()
  for (let k = 0; k < opts.frames; k++) {
    trace.mark(`frame-${k}`)
    sideB.cloudsContext.frame = pc.frame
    sideB.render()
    // the linear readback shares the last frame's node frame, as the parity
    // readLinear does, so the FRAME-type passes do not run again
    if (k < opts.frames - 1) await nextFrame()
  }
  trace.mark('linear')
  sideB.renderLinear()
  trace.mark('end')
  return { sideB, pc, textureNames: textureNames(sideB) }
}

type SideB = Awaited<ReturnType<typeof createSideB>>

// where each asset texture's content comes from: a file in the parity assets
// folder, or generated from a recipe the description names
export const ASSET_CONTENT: Record<string, Record<string, string>> = {
  shape: { file: 'shape.bin' },
  shapeDetail: { file: 'shape_detail.bin' },
  localWeather: { file: 'local_weather.png' },
  turbulence: { file: 'turbulence.png' },
  stbn: { generated: 'hashJitter' }
}

// three leaves the loaded assets and the readback target unnamed
function assetRoles(sideB: SideB): [object, string][] {
  const ctx = sideB.cloudsContext
  const named: [string, object | null | undefined][] = [
    ['shape', ctx.shapeTexture],
    ['shapeDetail', ctx.shapeDetailTexture],
    ['localWeather', ctx.localWeatherTexture],
    ['turbulence', ctx.turbulenceTexture],
    ['stbn', ctx.stbnTexture],
    ['linear', sideB.linearRT.texture],
    ['linearDepth', sideB.linearRT.depthTexture]
  ]
  return named.flatMap(([name, t]) => (t == null ? [] : [[t, name]]))
}

// the same roles for the GPU textures three made from them
function textureNames(sideB: SideB) {
  const backend = sideB.renderer.backend as unknown as {
    get: (o: object) => { texture?: { id: number } }
  }
  const out = new Map<number, string>()
  for (const [texture, name] of assetRoles(sideB)) {
    const gpu = texture == null ? undefined : backend.get(texture).texture
    if (gpu != null) out.set(gpu.id, name)
  }
  return out
}
