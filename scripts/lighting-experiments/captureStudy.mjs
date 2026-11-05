// Reuses the production parity page, its layer readback and browser launcher
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import {
  HalfFloatType,
  LinearFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat
} from 'three'

import { launchBenchmarkBrowser } from '../../examples/parity/scripts/benchmarks/browser.mjs'
import { makeFixture, MANIFEST } from './fixtures.mjs'
import { makePhaseWeights, makeSkyCache } from './skyCache.mjs'

const root = resolve(import.meta.dirname, '../..')
const out = resolve(process.argv[2] ?? 'test-results/lighting-study/smoke')
const shape = process.argv[3] ?? 'cumulus'
const width = Number(process.argv[4] ?? 320)
const height = Math.round((width * 9) / 16)
const port = 4197
const base = `http://127.0.0.1:${port}`
const viewAzimuth = Number(process.argv[5] ?? 0)
const sunElevation = Number(process.argv[6] ?? 45)
const thickness = Number(process.argv[7] ?? 1)
const skyMode = process.argv[8] ?? 'uniform'
if (
  !MANIFEST.viewAzimuths.includes(viewAzimuth) ||
  !MANIFEST.sunElevations.includes(sunElevation) ||
  !['uniform', 'hemispheres'].includes(skyMode)
)
  throw new Error('Unknown frozen lighting configuration')
const upperSky = [1, 0.5, 0.25]
const lowerSky = skyMode === 'uniform' ? upperSky : [0.1, 0.2, 0.8]
const refined = process.argv[9] === 'refined'
const primaryStep = refined ? 5 : MANIFEST.primaryStep
const shadowSteps = refined ? 256 : MANIFEST.shadowSteps
const cacheSize = refined ? 64 : 32
const fixture = makeFixture(shape, thickness)
fixture.numerics = { primaryStep, shadowSteps, cacheSize }
fixture.lighting = { viewAzimuth, sunElevation, upperSky, lowerSky, skyMode }
const skyCache = makeSkyCache(
  fixture,
  upperSky,
  lowerSky,
  cacheSize,
  shadowSteps
)
const phaseWeights = makePhaseWeights()
console.log(
  JSON.stringify({ skyCacheBuildMilliseconds: skyCache.buildMilliseconds })
)
const digest = path =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
const servedRoot = realpathSync(
  resolve(root, 'examples/parity/node_modules/three-clouds-webgpu')
)
if (servedRoot !== root) throw new Error(`Wrong served library: ${servedRoot}`)
const buildHash = digest(resolve(root, 'build/shared.js'))
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'fixture.bin'), new Uint8Array(fixture.data.buffer))
writeFileSync(
  resolve(out, 'fixture.json'),
  JSON.stringify({ ...fixture, data: undefined, manifest: MANIFEST }, null, 2)
)
await new Promise((accept, reject) => {
  const socket = createServer()
  socket.on('error', reject)
  socket.listen(port, '127.0.0.1', () => socket.close(accept))
})
const server = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort'
  ],
  { cwd: resolve(root, 'examples/parity'), stdio: ['ignore', 'pipe', 'pipe'] }
)
let serverLog = ''
server.stdout.on('data', data => {
  serverLog += data
})
server.stderr.on('data', data => {
  serverLog += data
})
let browser
const errors = []
try {
  const deadline = Date.now() + 60000
  while (true) {
    try {
      if ((await fetch(base)).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error('Vite did not become ready')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  browser = await launchBenchmarkBrowser({ channel: 'chrome', headless: false })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1
  })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/favicon.ico'))
      return route.fulfill({ status: 204 })
    if (url.pathname.endsWith('/stars.bin'))
      return route.fulfill({
        path: resolve(
          root,
          'node_modules/@takram/three-atmosphere/assets/stars.bin'
        )
      })
    if (url.pathname.endsWith('/stbn.bin'))
      return route.fulfill({
        path: resolve(root, 'test/fixtures/experimental/stbn.bin')
      })
    if (url.origin === base || ['data:', 'blob:'].includes(url.protocol))
      return route.continue()
    errors.push(`Unexpected network: ${url.origin}${url.pathname}`)
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(
    `${base}/?case=baseline-medium&e2e=1&w=${width}&h=${height}`,
    { waitUntil: 'domcontentloaded' }
  )
  await page.waitForFunction(() => window.__parity?.sideBHandle != null, null, {
    timeout: 180000
  })
  const state = await page.evaluate(
    async config => {
      const probe = window.__parity
      const side = probe.sideBHandle
      const ctx = side.cloudsContext
      const camera = side.camera
      const Texture = ctx.shapeTexture.constructor
      const volume = new Texture(
        new Uint16Array(config.data),
        config.size,
        config.size,
        config.size
      )
      volume.type = config.HalfFloatType
      volume.format = config.RedFormat
      volume.minFilter = volume.magFilter = config.LinearFilter
      volume.generateMipmaps = false
      volume.unpackAlignment = 1
      volume.needsUpdate = true
      volume.name = 'lighting-study-density'
      window.__studyVolume = volume
      window.__studyOriginalData = volume.image.data.slice()
      const makeTexture = (data, width, height, depth) => {
        const t = new Texture(new Uint16Array(data), width, height, depth)
        t.type = config.HalfFloatType
        t.format = config.RGBAFormat
        t.minFilter = t.magFilter = config.LinearFilter
        t.generateMipmaps = false
        t.unpackAlignment = 1
        t.needsUpdate = true
        return t
      }
      window.__studySkyCache = config.skyCache.volumes.map(data =>
        makeTexture(
          data,
          config.skyCache.size,
          config.skyCache.size,
          config.skyCache.size
        )
      )
      window.__studyWeights = config.phaseWeights.tables.map(data => {
        const t = makeTexture(
          data,
          config.phaseWeights.width,
          config.phaseWeights.height,
          1
        )
        t.wrapS = config.RepeatWrapping
        return t
      })
      ctx.worldToECEFMatrix.identity()
      ctx.correctAltitude = true
      const azimuth = (config.lighting.viewAzimuth * Math.PI) / 180
      camera.position.set(
        Math.sin(azimuth) * 6000,
        6379587,
        Math.cos(azimuth) * 6000
      )
      camera.lookAt(0, 6379587, 0)
      camera.fov = 36
      camera.near = 1
      camera.far = 10000000
      camera.aspect = config.width / config.height
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)
      const elevation = (config.lighting.sunElevation * Math.PI) / 180
      ctx.sunDirection.set(0, Math.sin(elevation), Math.cos(elevation))
      window.__studySky = config.lighting
      ctx.experimental = Object.fromEntries(
        Object.keys(ctx.experimental).map(key => [key, false])
      )
      ctx.cloudShape = {
        ...ctx.cloudShape,
        baseShadowStrength: 0,
        horizonCoverageAmount: 0,
        windSkewEast: 0,
        windSkewNorth: 0,
        erosionShape: 0
      }
      ctx.haze = false
      ctx.lightShafts = false
      ctx.groundBounceScale = 0
      ctx.powderScale = 0
      ctx.shapeDetail = false
      ctx.turbulence = false
      ctx.temporalUpscale = false
      ctx.resolutionScale = 1
      ctx.scatteringCoefficient = 1
      ctx.absorptionCoefficient = 0
      ctx.skyLightScale = 1
      ctx.scatterAnisotropy1 = 0.7
      ctx.scatterAnisotropy2 = -0.2
      ctx.scatterAnisotropyMix = 0.5
      ctx.accuratePhaseFunction = false
      ctx.multiScatteringOctaves = 1
      Object.assign(ctx.clouds, {
        minStepSize: config.numerics.primaryStep,
        maxStepSize: config.numerics.primaryStep,
        perspectiveStepScale: 1,
        maxIterationCount: 3000,
        maxRayDistance: 15000,
        minDensity: 0,
        minExtinction: 0,
        minTransmittance: 0.00001
      })
      ctx.stbnTexture.image.data.fill(64)
      ctx.stbnTexture.needsUpdate = true
      ctx.cloudLayers.forEach((layer, index) => {
        layer.altitude = 750
        layer.height = index === 0 ? 1450 : 0
        layer.shadow = false
      })
      ctx.lightingStudy = {
        density: volume,
        minimum: config.minimum,
        maximum: config.maximum,
        sunIrradiance: [1, 1, 1],
        upperSky: [0, 0, 0],
        lowerSky: [0, 0, 0],
        shadowSteps: config.numerics.shadowSteps
      }
      await probe.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 2,
        resetHistory: true
      })
      const uniforms = ctx.cameraUniforms
      return {
        width: config.width,
        height: config.height,
        inverseProjectionMatrix:
          uniforms.inverseProjectionMatrix.value.toArray(),
        inverseViewMatrix: uniforms.inverseViewMatrix.value.toArray(),
        worldToECEF: ctx.worldToECEFMatrix.elements.slice(),
        cameraPositionECEF: uniforms.cameraPositionECEF.value.toArray(),
        altitudeCorrection: ctx.altitudeCorrection.toArray(),
        sunDirection: ctx.sunDirection.toArray(),
        clouds: { ...ctx.clouds },
        layers: ctx.cloudLayers.map(layer => ({
          altitude: layer.altitude,
          height: layer.height,
          shadow: layer.shadow
        })),
        phase: [
          ctx.scatterAnisotropy1,
          ctx.scatterAnisotropy2,
          ctx.scatterAnisotropyMix
        ],
        scatteringCoefficient: ctx.scatteringCoefficient,
        absorptionCoefficient: ctx.absorptionCoefficient,
        temporalUpscale: ctx.temporalUpscale,
        experimental: { ...ctx.experimental },
        lightingStudy: { ...ctx.lightingStudy, density: undefined },
        graphVersion: ctx.graphVersion,
        gpu: side.renderer.backend.isWebGPUBackend,
        userAgent: navigator.userAgent
      }
    },
    {
      ...fixture,
      data: Array.from(fixture.data),
      width,
      height,
      HalfFloatType,
      RedFormat,
      RGBAFormat,
      RepeatWrapping,
      LinearFilter,
      skyCache: {
        ...skyCache,
        volumes: skyCache.volumes.map(data => Array.from(data))
      },
      phaseWeights: {
        ...phaseWeights,
        tables: phaseWeights.tables.map(data => Array.from(data))
      }
    }
  )
  if (state.temporalUpscale || !state.gpu || !state.lightingStudy)
    throw new Error('Study did not execute the requested graph')
  writeFileSync(resolve(out, 'state.json'), JSON.stringify(state, null, 2))
  const runtimeArms = []
  for (const arm of [
    'single',
    'baseline',
    'diffusion',
    'sky',
    'directional-sky',
    'cached-sky',
    'combined',
    'zero',
    'empty'
  ]) {
    const layer = await page.evaluate(async arm => {
      const probe = window.__parity
      const ctx = probe.sideBHandle.cloudsContext
      if (arm === 'empty') {
        window.__studyVolume.image.data.fill(0)
        window.__studyVolume.needsUpdate = true
      }
      ctx.multiScatteringOctaves = arm === 'single' ? 1 : 8
      ctx.experimental = { directionalSkylight: arm === 'directional-sky' }
      const sky = ['sky', 'directional-sky', 'cached-sky', 'combined'].includes(
        arm
      )
        ? window.__studySky.upperSky
        : [0, 0, 0]
      const sun = ['sky', 'directional-sky', 'cached-sky', 'zero'].includes(arm)
        ? [0, 0, 0]
        : [1, 1, 1]
      ctx.lightingStudy = {
        ...ctx.lightingStudy,
        sunIrradiance: sun,
        upperSky: sky,
        lowerSky: ['sky', 'directional-sky', 'cached-sky', 'combined'].includes(
          arm
        )
          ? window.__studySky.lowerSky
          : [0, 0, 0],
        sunModel: ['diffusion', 'combined'].includes(arm)
          ? 'diffusion'
          : 'octaves',
        skyCache: ['cached-sky', 'combined'].includes(arm)
          ? window.__studySkyCache
          : undefined,
        phaseWeights: ['cached-sky', 'combined'].includes(arm)
          ? window.__studyWeights
          : undefined,
        cachePhase: ['cached-sky', 'combined'].includes(arm)
          ? [0.7, -0.2, 0.5]
          : undefined
      }
      await probe.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 1,
        resetHistory: true
      })
      const result = await probe.readLayer()
      return {
        width: result.width,
        height: result.height,
        data: Array.from(result.data),
        runtime: {
          arm,
          graphVersion: ctx.graphVersion,
          octaves: ctx.multiScatteringOctaves,
          directionalSkylight: ctx.experimental.directionalSkylight,
          sunModel: ctx.lightingStudy.sunModel,
          sunIrradiance: ctx.lightingStudy.sunIrradiance,
          upperSky: ctx.lightingStudy.upperSky,
          lowerSky: ctx.lightingStudy.lowerSky,
          cacheVolumes: ctx.lightingStudy.skyCache?.length ?? 0,
          phase: [
            ctx.scatterAnisotropy1,
            ctx.scatterAnisotropy2,
            ctx.scatterAnisotropyMix
          ],
          shadowSteps: ctx.lightingStudy.shadowSteps
        }
      }
    }, arm)
    if (layer.width !== width || layer.height !== height)
      throw new Error('Wrong layer resolution')
    runtimeArms.push(layer.runtime)
    const array = Float32Array.from(layer.data)
    writeFileSync(resolve(out, `${arm}.bin`), new Uint8Array(array.buffer))
    let occupied = 0,
      sum = 0
    for (let i = 0; i < array.length; i += 4) {
      if (array[i + 3] > 0.001) occupied++
      sum += array[i] + array[i + 1] + array[i + 2]
    }
    console.log(
      JSON.stringify({ arm, occupied, mean: sum / (width * height * 3) })
    )
    if (
      (arm === 'empty' ? occupied !== 0 : !occupied) ||
      !Number.isFinite(sum) ||
      (['zero', 'empty'].includes(arm) ? sum !== 0 : sum <= 0)
    )
      throw new Error('Inactive or invalid light arm')
  }
  if (process.env.STUDY_LIFECYCLE === '1') {
    const lifecycle = await page.evaluate(async () => {
      const { measureLightingStudyLifecycle } =
        await import('/src/e2eSupport/lightingStudyLifecycle.ts')
      const probe = window.__parity
      window.__studyVolume.image.data.set(window.__studyOriginalData)
      window.__studyVolume.needsUpdate = true
      const study = {
        ...probe.sideBHandle.cloudsContext.lightingStudy,
        sunModel: 'diffusion',
        sunIrradiance: [1, 1, 1],
        upperSky: window.__studySky.upperSky,
        lowerSky: window.__studySky.lowerSky,
        skyCache: window.__studySkyCache,
        phaseWeights: window.__studyWeights,
        cachePhase: [0.7, -0.2, 0.5]
      }
      return measureLightingStudyLifecycle(probe, study)
    })
    writeFileSync(
      resolve(out, 'lifecycle.json'),
      JSON.stringify(lifecycle, null, 2)
    )
    if (
      lifecycle.cycles.some(
        cycle =>
          cycle.after.textures !== lifecycle.baseline.textures ||
          cycle.after.bytes !== lifecycle.baseline.bytes ||
          cycle.disposals.some(value => value !== 1)
      )
    )
      throw new Error('Study resource lifecycle failed')
  }
  await page.screenshot({ path: resolve(out, 'page.png') })
  const servedHash = digest(resolve(servedRoot, 'build/shared.js'))
  if (buildHash !== servedHash) throw new Error('Build changed during capture')
  writeFileSync(
    resolve(out, 'provenance.json'),
    JSON.stringify(
      {
        runtimeArms,
        buildHash,
        servedHash,
        servedRoot,
        fixtureHash: fixture.hash,
        buildInputs: JSON.parse(
          readFileSync(resolve(root, 'build/package-provenance.json'))
        ).buildInputs,
        instrumentHash: digest(new URL(import.meta.url)),
        manifestHash: createHash('sha256')
          .update(JSON.stringify(MANIFEST))
          .digest('hex'),
        errors,
        timingQualification: 'UNQUIET; correctness capture only'
      },
      null,
      2
    )
  )
  if (errors.length) throw new Error(`Browser errors: ${errors.join('\n')}`)
} finally {
  if (browser) await browser.close()
  server.kill('SIGTERM')
  writeFileSync(resolve(out, 'server.log'), serverLog)
  writeFileSync(resolve(out, 'console.json'), JSON.stringify(errors, null, 2))
}
