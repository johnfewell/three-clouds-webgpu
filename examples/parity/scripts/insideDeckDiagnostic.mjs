// Read-only shadow atlas diagnostic. Never writes accepted parity evidence.
// READ_RAW=1 selects pre-resolve data; READ_VELOCITY=1 selects motion vectors
// PIN_AERIAL_FRAME=1 is an explicit clock counterfactual, not the baseline
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import {
  captureProvenance,
  refuseUnlessServedIsAncestor,
  refuseUnlessServedIsBuilt,
  refuseUnlessServedIsSelf
} from './captureProvenance.mjs'
import { ensureFreshBuild } from './freshBuild.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const example = join(root, 'examples/parity')
const base = process.env.PARITY_URL ?? 'http://127.0.0.1:4174'
const caseName = process.env.PARITY_CASE ?? 'shafts-inside-deck'
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
ensureFreshBuild('inside-deck-diagnostic', { requireGreenE2e: true })
const provenance = captureProvenance({
  projectRoot: root,
  exampleRoot: example,
  packageName: 'three-clouds-webgpu'
})
refuseUnlessServedIsBuilt(provenance, 'three-clouds-webgpu')
refuseUnlessServedIsSelf(provenance, root)
refuseUnlessServedIsAncestor(provenance, provenance.git.commit, root)
const output = join(
  root,
  'test-results/inside-deck',
  new Date().toISOString().replaceAll(':', '-')
)
await mkdir(output, { recursive: true })
const localAssets = {
  'stars.bin': join(
    example,
    'node_modules/@takram/three-atmosphere/assets/stars.bin'
  ),
  'stbn.bin': join(root, 'test/fixtures/experimental/stbn.bin')
}
const assetHashes = {}
for (const [name, path] of Object.entries(localAssets)) {
  assetHashes[name] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})
const pinAerialFrame = process.env.PIN_AERIAL_FRAME === '1'
const velocity = process.env.READ_VELOCITY === '1'
const raw = process.env.READ_RAW === '1' || velocity
const report = {
  complete: false,
  diagnosticOnly: true,
  raw,
  velocity,
  pinAerialFrame,
  caseName,
  scriptHash: createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  provenance,
  assetHashes,
  browser: browser.version()
}
const errors = []
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    const name = url.pathname.split('/').at(-1)
    if (localAssets[name]) return route.fulfill({ path: localAssets[name] })
    if (url.pathname.endsWith('/favicon.ico'))
      return route.fulfill({ status: 204, body: '' })
    if (
      url.origin === new URL(base).origin ||
      ['blob:', 'data:'].includes(url.protocol)
    )
      return route.continue()
    errors.push(`Blocked egress: ${url.origin}${url.pathname}`)
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.setDefaultTimeout(120000)
  await page.goto(`${base}/?case=${encodeURIComponent(caseName)}&e2e=1`)
  await page.waitForFunction(() => window.__parity != null)
  const result = await page.evaluate(
    async ({ pinAerialFrame, raw, velocity, caseName }) => {
      const { cases } = await import('/cases/index.ts')
      const pc = cases.find(value => value.name === caseName)
      if (!pc) throw new Error(`Unknown parity case: ${caseName}`)
      const warmup = pc.warmup ?? 64
      const p = window.__parity
      if (pinAerialFrame) {
        const aerial = p.sideAHandle.aerial
        const update = aerial.update
        aerial.update = function (...args) {
          this.uniforms.get('frame').value =
            p.sideAHandle.clouds.frameOverride - 1
          return update.apply(this, args)
        }
      }
      for (const side of ['A', 'B'])
        await p.renderOnce(side, { time: 0, frame: 0, warmup })
      const linearA = await p.readLinear('A')
      const linearB = await p.readLinear('B')
      if (
        linearA.width !== linearB.width ||
        linearA.height !== linearB.height ||
        !linearA.data.length ||
        linearA.data.length !== linearB.data.length
      )
        throw new Error('Invalid linear readback dimensions')
      const metrics = await import('/src/metrics/index.ts')
      const delta = metrics.computeDeltaE(
        linearA.data,
        linearB.data,
        linearA.width,
        linearA.height,
        4
      )
      const score = {
        ssim: metrics.computeSSIM(
          linearA.data,
          linearB.data,
          linearA.width,
          linearA.height,
          4
        ),
        deMean: delta.deMean,
        deP95: delta.deP95
      }
      const encode = data =>
        new Promise(resolve => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result.split(',')[1])
          reader.readAsDataURL(new Blob([data]))
        })
      const a = p.sideAHandle
      const b = p.sideBHandle
      const shadow = a.clouds.shadowPass
      const rt =
        !raw && shadow.temporalPass
          ? shadow.historyRenderTarget
          : shadow.currentRenderTarget
      const gl = a.renderer.getContext()
      const texture = a.renderer.properties.get(rt.texture).__webglTexture
      if (!texture) throw new Error('GL atlas not uploaded')
      const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
      const previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
      const preexistingGlErrors = []
      for (
        let error = gl.getError();
        error !== gl.NO_ERROR;
        error = gl.getError()
      ) {
        preexistingGlErrors.push(error)
        if (preexistingGlErrors.length > 8)
          throw new Error('Unbounded preexisting GL errors')
      }
      const framebuffer = gl.createFramebuffer()
      const layersA = []
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        for (let layer = 0; layer < shadow.shadow.cascadeCount; layer++) {
          gl.framebufferTextureLayer(
            gl.READ_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            texture,
            0,
            layer + (velocity ? shadow.shadow.cascadeCount : 0)
          )
          gl.readBuffer(gl.COLOR_ATTACHMENT0)
          if (
            gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !==
            gl.FRAMEBUFFER_COMPLETE
          )
            throw new Error('Incomplete atlas framebuffer')
          const data = new Float32Array(rt.width * rt.height * 4)
          gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.FLOAT, data)
          const error = gl.getError()
          if (error !== gl.NO_ERROR)
            throw new Error(`GL atlas read failed: ${error}`)
          layersA.push(await encode(data))
        }
      } finally {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw)
        gl.deleteFramebuffer(framebuffer)
      }
      if (!layersA.length) throw new Error('No atlas layers')
      // textureIndex 1 = the depth velocity: it is the shadow
      // march target's second attachment, not a target of its own
      const readRawLayers = async (target, depth, textureIndex = 0) => {
        const { DataUtils } =
          await import('/node_modules/three/build/three.module.js')
        const layers = []
        for (let layer = 0; layer < depth; layer++) {
          const data = await b.renderer.readRenderTargetPixelsAsync(
            target,
            0,
            0,
            target.width,
            target.height,
            textureIndex,
            layer
          )
          layers.push(
            data instanceof Uint16Array
              ? Float32Array.from(data, DataUtils.fromHalfFloat)
              : data
          )
        }
        return layers
      }
      const atlasB = await p.readShadowAtlas()
      let layersB = atlasB.layers.map(layer => layer.data)
      if (raw) {
        layersB = await readRawLayers(
          b.cloudsPass.shadowRT,
          atlasB.depth,
          velocity ? 1 : 0
        )
      }
      const uniformValues = uniforms =>
        Object.fromEntries(
          Object.entries(uniforms).flatMap(([key, uniform]) => {
            const v = uniform.value
            if (typeof v === 'number' || typeof v === 'boolean')
              return [[key, v]]
            if (v?.toArray) return [[key, v.toArray()]]
            if (Array.isArray(v) && v[0]?.toArray)
              return [[key, v.map(x => x.toArray())]]
            return []
          })
        )
      return {
        score,
        time: 0,
        frame: 0,
        warmup,
        layout: {
          format: 'RGBA float32',
          rows: 'increasing light-space v, no screen-space row flip',
          A: velocity
            ? [
                'frontDepthMetres',
                'velocityXTexels',
                'velocityYTexels',
                'unused'
              ]
            : ['frontDepthMetres', 'meanExtinction', 'maxOpticalDepth', 'tail'],
          B: velocity
            ? ['frontDepthUnit', 'velocityXTexels', 'velocityYTexels', 'unused']
            : ['frontDepthUnit', 'meanExtinction', 'maxOpticalDepth', 'tail']
        },
        A: {
          width: rt.width,
          height: rt.height,
          depth: layersA.length,
          temporalPass: shadow.temporalPass,
          layers: layersA,
          preexistingGlErrors,
          uniforms: uniformValues(shadow.currentMaterial.uniforms),
          aerialUniforms: uniformValues(Object.fromEntries(a.aerial.uniforms))
        },
        B: {
          width: atlasB.width,
          height: atlasB.height,
          depth: atlasB.depth,
          temporalPass: atlasB.temporalPass,
          layers: await Promise.all(layersB.map(encode)),
          bottomRadius: b.cloudsContext.bottomRadius,
          matrices: Array.from(b.cloudsPass.cloudShadow.matrices.value),
          inverseMatrices: Array.from(
            b.cloudsPass.cloudShadow.inverseMatrices.value
          )
        }
      }
    },
    { pinAerialFrame, raw, velocity, caseName }
  )
  assert.deepEqual(errors, [])
  assert(result.A.depth > 0 && result.A.depth === result.B.depth)
  assert.equal(result.A.width, result.B.width)
  assert.equal(result.A.height, result.B.height)
  for (const value of Object.values(result.score))
    assert(Number.isFinite(value))
  for (const side of ['A', 'B']) {
    const atlas = result[side]
    atlas.readbacks = []
    for (let layer = 0; layer < atlas.layers.length; layer++) {
      const data = Buffer.from(atlas.layers[layer], 'base64')
      assert.equal(data.length, atlas.width * atlas.height * 16)
      const floats = new Float32Array(
        data.buffer,
        data.byteOffset,
        data.length / 4
      )
      assert(floats.every(Number.isFinite), 'Non-finite atlas readback')
      assert(
        floats.some(value => value !== 0),
        'Empty atlas readback'
      )
      await writeFile(join(output, `${side}-${layer}.f32`), data)
      atlas.readbacks.push({
        file: `${side}-${layer}.f32`,
        sha256: createHash('sha256').update(data).digest('hex')
      })
    }
    delete atlas.layers
  }
  report.result = result
  report.complete = true
} finally {
  report.errors = errors
  await browser.close()
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  console.log(output)
}
