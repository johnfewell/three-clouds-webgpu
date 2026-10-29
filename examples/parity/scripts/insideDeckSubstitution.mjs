// Counterfactual diagnostic, not a parity capture or a production rendering mode
// TRACE_HISTORY=1 saves raw/resolved atlases over counted shadow updates
// REFERENCE_CADENCE=1 pins B to the reference's every-frame shadow update
// CHECK_CLEAR=1 substitutes the reference atlas immediately after its reset
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import { writeLinearReadbacks } from './captureLinear.mjs'
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
const checkClear = process.env.CHECK_CLEAR === '1'
const traceHistory = process.env.TRACE_HISTORY === '1'
const referenceCadence = process.env.REFERENCE_CADENCE === '1'
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
ensureFreshBuild('atlas-substitution', { requireGreenE2e: true })
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
  'test-results/atlas-substitution',
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
const sha = data => createHash('sha256').update(data).digest('hex')
const report = {
  complete: false,
  diagnosticOnly: true,
  checkClear,
  traceHistory,
  referenceCadence,
  provenance,
  scriptHash: sha(await readFile(fileURLToPath(import.meta.url))),
  assetHashes: {},
  results: []
}
for (const [name, path] of Object.entries(localAssets))
  report.assetHashes[name] = sha(await readFile(path))
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})
report.browser = browser.version()

async function measure({ checkClear, traceHistory, referenceCadence }) {
  const { DataArrayTexture, DataUtils, HalfFloatType, LinearFilter } =
    await import('/node_modules/three/build/three.module.js')
  const metrics = await import('/src/metrics/index.ts')
  const p = window.__parity
  // Case load pins B to the reference cadence, and the other arm is the
  // port's default of 2, set explicitly so it does not inherit the pin
  p.sideBHandle.cloudsContext.shadow.updateInterval = referenceCadence ? 1 : 2
  for (const side of ['A', 'B'])
    await p.renderOnce(side, { time: 0, frame: 0, warmup: 64 })
  const a = p.sideAHandle
  const b = p.sideBHandle
  const reference = await p.readLinear('A')
  // Build the linear graph before freezing so the experiment cannot freeze a placeholder
  await p.readLinear('B')
  const cp = b.cloudsPass
  const originalUpdate = cp.updateBefore
  const originalTexture = cp.cloudShadow.mapNode.value
  cp.updateBefore = () => undefined
  const encode = data =>
    new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result.split(',')[1])
      reader.readAsDataURL(new Blob([data]))
    })
  const digest = async data =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
      .map(x => x.toString(16).padStart(2, '0'))
      .join('')
  const cloudHashes = async () => {
    const layer = await p.readLayer()
    const lengths = await p.readShadowLength()
    if (!layer.data.length || !lengths?.data?.length)
      throw new Error('Missing frozen cloud buffers')
    return {
      layer: await digest(layer.data),
      lengths: await digest(lengths.data)
    }
  }
  const frozen = await cloudHashes()
  const originalSetTarget = b.renderer.setRenderTarget
  const cloudTargets = new Set(
    [
      cp.layerRT,
      cp.shadowRT,
      cp.shadowHistoryRT,
      cp.shadowResolveRT,
      cp.shadowVelocityRT,
      cp.historyRT
    ].filter(Boolean)
  )
  let cloudWrites = 0
  b.renderer.setRenderTarget = function (target, ...args) {
    if (cloudTargets.has(target)) cloudWrites++
    return originalSetTarget.call(this, target, ...args)
  }
  const textures = []
  const observations = []
  try {
    const atlasB = await p.readShadowAtlas()
    const sp = a.clouds.shadowPass
    const rt = sp.temporalPass ? sp.historyRenderTarget : sp.currentRenderTarget
    if (
      rt.width !== atlasB.width ||
      rt.height !== atlasB.height ||
      sp.shadow.cascadeCount !== atlasB.depth
    )
      throw new Error('Atlas dimensions differ')
    const matrixA = a.aerial.uniforms
      .get('shadowMatrices')
      .value.flatMap(x => x.toArray())
      .map(Math.fround)
    if (matrixA.some((value, i) => value !== cp.cloudShadow.matrices.value[i]))
      throw new Error('Cascade matrices differ')
    const gl = a.renderer.getContext()
    const preexistingGlErrors = []
    for (
      let error = gl.getError();
      error !== gl.NO_ERROR;
      error = gl.getError()
    ) {
      preexistingGlErrors.push(error)
      if (preexistingGlErrors.length > 8) throw new Error('Unbounded GL errors')
    }
    let resetError = null
    if (checkClear) {
      a.resetTemporalHistory()
      resetError = gl.getError()
    }
    const readReferenceTarget = target => {
      const savedRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
      const savedDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
      const framebuffer = gl.createFramebuffer()
      const layers = []
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        const texture = a.renderer.properties.get(target.texture).__webglTexture
        if (!texture) throw new Error('Missing GL atlas')
        for (let layer = 0; layer < atlasB.depth; layer++) {
          gl.framebufferTextureLayer(
            gl.READ_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            texture,
            0,
            layer
          )
          gl.readBuffer(gl.COLOR_ATTACHMENT0)
          if (
            gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !==
            gl.FRAMEBUFFER_COMPLETE
          )
            throw new Error('Incomplete atlas framebuffer')
          const data = new Float32Array(target.width * target.height * 4)
          gl.readPixels(
            0,
            0,
            target.width,
            target.height,
            gl.RGBA,
            gl.FLOAT,
            data
          )
          if (gl.getError() !== gl.NO_ERROR)
            throw new Error('GL atlas read failed')
          layers.push(data)
        }
      } finally {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, savedRead)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, savedDraw)
        gl.deleteFramebuffer(framebuffer)
      }
      return layers
    }
    const layersA = readReferenceTarget(rt)
    if (!atlasB.depth) throw new Error('Empty atlas')
    if (traceHistory) {
      b.renderer.setRenderTarget = originalSetTarget
      cp.updateBefore = originalUpdate
      const originalAUpdate = sp.update
      const originalBRender = cp.shadowMesh.render
      let updatesA = 0
      let cascadeDrawsB = 0
      sp.update = function (...args) {
        updatesA++
        return originalAUpdate.apply(this, args)
      }
      cp.shadowMesh.render = function (...args) {
        cascadeDrawsB++
        return originalBRender.apply(this, args)
      }
      const trace = []
      const readPortTarget = async target => {
        const layers = []
        for (let layer = 0; layer < atlasB.depth; layer++) {
          const buffer = await b.renderer.readRenderTargetPixelsAsync(
            target,
            0,
            0,
            target.width,
            target.height,
            0,
            layer
          )
          const data =
            buffer instanceof Uint16Array
              ? Float32Array.from(buffer, DataUtils.fromHalfFloat)
              : buffer
          if (data.length !== target.width * target.height * 4)
            throw new Error('Invalid port atlas readback')
          layers.push(data)
        }
        return layers
      }
      const compareLayers = (left, right) =>
        left.map((data, layer) => {
          const other = right[layer]
          const channels = []
          for (let channel = 0; channel < 4; channel++) {
            let sumA = 0,
              sumB = 0,
              sumError = 0,
              maxError = 0
            for (let i = channel; i < data.length; i += 4) {
              const valueA = data[i]
              const valueB =
                other[i] * (channel === 0 ? b.cloudsContext.bottomRadius : 1)
              if (!Number.isFinite(valueA) || !Number.isFinite(valueB))
                throw new Error('Nonfinite trace data')
              sumA += valueA
              sumB += valueB
              sumError += Math.abs(valueA - valueB)
              maxError = Math.max(maxError, Math.abs(valueA - valueB))
            }
            channels.push({
              meanA: sumA / (data.length / 4),
              meanB: sumB / (data.length / 4),
              mae: sumError / (data.length / 4),
              maxError
            })
          }
          return channels
        })
      try {
        a.resetTemporalHistory()
        const clearError = gl.getError()
        b.resetTemporalHistory()
        for (let step = 1; step <= 65; step++) {
          for (const side of ['A', 'B'])
            await p.renderOnce(side, {
              time: 0,
              frame: 0,
              warmup: 0,
              resetHistory: false
            })
          if (![1, 2, 4, 8, 16, 32, 65].includes(step)) continue
          const rawA = readReferenceTarget(sp.currentRenderTarget)
          const resolvedA = readReferenceTarget(sp.historyRenderTarget)
          const rawB = await readPortTarget(cp.shadowRT)
          const resolvedB = (await p.readShadowAtlas()).layers.map(
            layer => layer.data
          )
          cp.updateBefore = () => undefined
          const plateA = await p.readLinear('A')
          const plateB = await p.readLinear('B')
          cp.updateBefore = originalUpdate
          const buffers = {}
          for (const [name, layers] of Object.entries({
            rawA,
            resolvedA,
            rawB,
            resolvedB
          })) {
            buffers[name] = await Promise.all(layers.map(encode))
          }
          trace.push({
            step,
            updatesA,
            updatesB: cascadeDrawsB / atlasB.depth,
            raw: compareLayers(rawA, rawB),
            resolved: compareLayers(resolvedA, resolvedB),
            ssim: metrics.computeSSIM(
              plateA.data,
              plateB.data,
              plateA.width,
              plateA.height,
              4
            ),
            buffers
          })
        }
        return {
          trace,
          clearError,
          preexistingGlErrors,
          updateInterval: b.cloudsContext.shadow.updateInterval
        }
      } finally {
        sp.update = originalAUpdate
        cp.shadowMesh.render = originalBRender
      }
    }
    const quantization = {}
    const makeTexture = (layers, name) => {
      const count = atlasB.width * atlasB.height * atlasB.depth * 4
      const words = new Uint16Array(count)
      let totalError = 0
      let maxError = 0
      let index = 0
      for (const data of layers) {
        for (let i = 0; i < data.length; i++, index++) {
          let value = data[i]
          if (name === 'A' && i % 4 === 0) value /= b.cloudsContext.bottomRadius
          if (name === 'zero' && (i % 4 === 1 || i % 4 === 2)) value = 0
          if (!Number.isFinite(value)) throw new Error('Nonfinite source atlas')
          words[index] = DataUtils.toHalfFloat(value)
          const error = Math.abs(DataUtils.fromHalfFloat(words[index]) - value)
          totalError += error
          maxError = Math.max(maxError, error)
        }
      }
      if (index !== count) throw new Error('Incomplete atlas transfer')
      quantization[name] = { mean: totalError / count, max: maxError }
      if (name === 'B' && maxError !== 0)
        throw new Error('B roundtrip is lossy')
      const texture = new DataArrayTexture(
        words,
        atlasB.width,
        atlasB.height,
        atlasB.depth
      )
      texture.type = HalfFloatType
      texture.minFilter = LinearFilter
      texture.magFilter = LinearFilter
      texture.generateMipmaps = false
      texture.needsUpdate = true
      textures.push(texture)
      return texture
    }
    const replacements = {
      native: originalTexture,
      B: makeTexture(
        atlasB.layers.map(x => x.data),
        'B'
      ),
      A: makeTexture(layersA, 'A'),
      zero: makeTexture(
        atlasB.layers.map(x => x.data),
        'zero'
      )
    }
    let nativePlate
    for (const arm of [
      'native',
      'B',
      'A',
      'native',
      'B',
      'A',
      'native',
      'B',
      'A',
      'zero',
      'native'
    ]) {
      cp.cloudShadow.mapNode.value = replacements[arm]
      const plate = await p.readLinear('B')
      if (
        plate.width !== reference.width ||
        plate.height !== reference.height ||
        !plate.data.length
      )
        throw new Error('Invalid plate')
      nativePlate ??= plate.data
      const de = metrics.computeDeltaE(
        reference.data,
        plate.data,
        plate.width,
        plate.height,
        4
      )
      let meanAbsoluteChange = 0
      for (let i = 0; i < plate.data.length; i++)
        meanAbsoluteChange +=
          Math.abs(plate.data[i] - nativePlate[i]) / plate.data.length
      observations.push({
        arm,
        width: plate.width,
        height: plate.height,
        ssim: metrics.computeSSIM(
          reference.data,
          plate.data,
          plate.width,
          plate.height,
          4
        ),
        deP95: de.deP95,
        meanAbsoluteChange,
        b64: await encode(plate.data)
      })
    }
    const after = await cloudHashes()
    if (
      after.layer !== frozen.layer ||
      after.lengths !== frozen.lengths ||
      cloudWrites !== 0
    )
      throw new Error('Cloud buffers changed during surface substitution')
    const sourceA = layersA.map(data => ({
      nonzero: data.reduce((sum, value) => sum + Number(value !== 0), 0),
      values: data.length
    }))
    return {
      observations,
      a64: await encode(reference.data),
      frozen,
      after,
      cloudWrites,
      quantization,
      preexistingGlErrors,
      resetError,
      sourceA,
      updateInterval: b.cloudsContext.shadow.updateInterval
    }
  } finally {
    b.renderer.setRenderTarget = originalSetTarget
    cp.cloudShadow.mapNode.value = traceHistory
      ? cp.cloudShadow.map
      : originalTexture
    cp.updateBefore = originalUpdate
    for (const texture of textures) texture.dispose()
  }
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
  await page.goto(`${base}/?case=shafts-inside-deck&e2e=1`)
  await page.waitForFunction(() => window.__parity != null)
  const result = await page.evaluate(measure, {
    checkClear,
    traceHistory,
    referenceCadence
  })
  assert.deepEqual(errors, [])
  if (traceHistory) {
    report.result = result
    assert.equal(result.trace.length, 7)
    for (const row of result.trace) {
      for (const [name, buffers] of Object.entries(row.buffers)) {
        for (const [layer, data] of buffers.entries())
          await writeFile(
            join(output, `${row.step}-${name}-${layer}.f32`),
            Buffer.from(data, 'base64')
          )
      }
      delete row.buffers
      console.log(JSON.stringify(row))
    }
    for (const row of result.trace) {
      assert.equal(row.updatesA, row.step)
      assert.equal(row.updatesB, Math.ceil(row.step / result.updateInterval))
    }
  } else {
    for (const [index, row] of result.observations.entries()) {
      assert(Number.isFinite(row.ssim) && Number.isFinite(row.deP95))
      const dir = join(output, `${index}-${row.arm}`)
      await mkdir(dir)
      writeLinearReadbacks(dir, { ...row, a64: result.a64 })
      row.hash = sha(Buffer.from(row.b64, 'base64'))
      delete row.b64
      console.log(JSON.stringify(row))
    }
    delete result.a64
    report.result = result
    const native = result.observations
      .filter(row => row.arm === 'native')
      .map(row => row.ssim)
    const tolerance = Math.max(
      1e-6,
      5 * (Math.max(...native) - Math.min(...native))
    )
    const control = result.observations.filter(row => row.arm === 'B')
    report.controls = {
      tolerance,
      roundtrip: control.every(
        row => Math.abs(row.ssim - native[0]) <= tolerance
      ),
      positive:
        result.observations.find(row => row.arm === 'zero').meanAbsoluteChange >
        1e-4
    }
    assert(report.controls.roundtrip, 'B-to-B transfer failed')
    assert(report.controls.positive, 'Shadow-free positive control is inert')
  }
  report.complete = true
} catch (error) {
  report.failure = String(error)
  throw error
} finally {
  report.errors = errors
  await browser.close()
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  console.log(output)
}
