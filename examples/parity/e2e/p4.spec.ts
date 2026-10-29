// Phase 4 e2e. Opens with ADR-007 3.2b, B-SIDE ONLY by
// verdict: cloud shadow on the atmosphere LIGHT is a port addition, and side A
// faithfully has none. Gated on a receiver that demonstrably contributes pixels
// on both sides, since case 35 once scored 0.9831 while testing
// nothing Cite: ADR-007 3.2b

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page } from '@playwright/test'
import {
  RedFormat,
  RGBAFormat,
  type Mesh,
  type MeshBasicMaterial,
  type PerspectiveCamera,
  type PlaneGeometry,
  type Scene,
  type WebGLRenderTarget
} from 'three'
import type { RenderTarget } from 'three/webgpu'

import type { R3FSmokeWindow } from '../../r3f/src/smokeProbe'
import { caseByName } from '../cases/index'
import { DEBUG_VIEWS } from '../src/debugViews'
import { settledTitle, titleProblem } from '../src/e2eSupport/r3fTitle'
import {
  classifyContest,
  decodedDistance,
  depthTestWinner,
  logRelativeErrorBound
} from '../src/metrics/depthPrecision'
import {
  byteStats,
  changedPixels,
  meanAbsLuminanceDeltaOver,
  meanLuminanceOver,
  ndcBoxPixels,
  rayAltitudeRange,
  topFraction
} from '../src/metrics/regions'
import { MIN_SIGNAL_FRACTION } from '../src/metrics/shadedFraction'
import { computeSSIM } from '../src/metrics/ssim'
import {
  byteSpread,
  compareVolumes,
  fnv1a32
} from '../src/metrics/volumeReadback'
import type { SideAHandle } from '../src/sideA'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// The example dev servers' origins, owned by the config. The two
// literals these replace were what sent a smoke at whatever another worktree
// had listening, and the served-tree gate cannot catch a spec that never asks
const R3F_URL = process.env.PARITY_R3F_URL ?? 'http://localhost:5200'
const BASIC_URL = process.env.PARITY_BASIC_URL ?? 'http://localhost:5199'

async function setCasters(
  page: Page,
  on: boolean
): Promise<{ A: boolean[]; B: boolean[] | null }> {
  return page.evaluate(
    value => (window as ParityWindow).__parity.setShadow(value),
    on
  )
}

async function renderSideAndRead(
  page: Page,
  side: 'A' | 'B',
  warmup = 64
): Promise<{ data: number[]; width: number; height: number }> {
  await page.evaluate(
    async ({ renderSide, warmupFrames }) =>
      await (window as ParityWindow).__parity.renderOnce(renderSide, {
        time: 0,
        frame: 0,
        warmup: warmupFrames
      }),
    { renderSide: side, warmupFrames: warmup }
  )
  // readLinear is ASYNC (main.ts:772). Unawaited it yields a Promise whose
  // `.data` is undefined, and Array.from throws "undefined is not iterable",
  // which is what this file's first hardware run did, five times
  return page.evaluate(async readSide => {
    const r = await (window as ParityWindow).__parity.readLinear(readSide)
    return {
      data: Array.from(r.data),
      width: r.width,
      height: r.height
    }
  }, side)
}

async function renderAndRead(page: Page): Promise<number[]> {
  return (await renderSideAndRead(page, 'B')).data
}

async function setSphereVisible(
  page: Page,
  visible: boolean
): Promise<{ A: boolean; B: boolean | null }> {
  return page.evaluate(value => {
    const p = (window as ParityWindow).__parity
    const sideA = p.sideAHandle as SideAHandle
    sideA.sceneResult.sphere.visible = value
    if (p.sideBHandle != null) {
      p.sideBHandle.sceneResult.sphere.visible = value
    }
    return {
      A: sideA.sceneResult.sphere.visible,
      B: p.sideBHandle?.sceneResult.sphere.visible ?? null
    }
  }, visible)
}

async function sphereProjection(
  page: Page,
  side: 'A' | 'B'
): Promise<{ center: [number, number]; edges: Array<[number, number]> }> {
  return page.evaluate(renderSide => {
    const p = (window as ParityWindow).__parity
    const handle =
      renderSide === 'A' ? (p.sideAHandle as SideAHandle) : p.sideBHandle
    if (handle == null) throw new Error(`side ${renderSide} not available`)
    const { sphere } = handle.sceneResult
    const { camera } = handle
    sphere.updateWorldMatrix(true, false)
    camera.updateMatrixWorld(true)
    const center = sphere.position.clone()
    sphere.getWorldPosition(center)
    center.project(camera)
    const radius = sphere.geometry.boundingSphere?.radius ?? 500
    const axes = [
      [radius, 0, 0],
      [-radius, 0, 0],
      [0, radius, 0],
      [0, -radius, 0],
      [0, 0, radius],
      [0, 0, -radius]
    ] as const
    const edges = axes.map(([x, y, z]) => {
      const point = sphere.position
        .clone()
        .set(x, y, z)
        .applyMatrix4(sphere.matrixWorld)
        .project(camera)
      return [point.x, point.y] as [number, number]
    })
    return { center: [center.x, center.y], edges }
  }, side)
}

function receiverMask(
  visible: number[],
  hidden: number[],
  width: number,
  height: number,
  projection: { center: [number, number]; edges: Array<[number, number]> }
): number[] {
  const [centerX, centerY] = projection.center
  const cx = (centerX * 0.5 + 0.5) * width
  const cy = (0.5 - centerY * 0.5) * height
  const radius = Math.max(
    ...projection.edges.map(([x, y]) =>
      Math.hypot((x * 0.5 + 0.5) * width - cx, (0.5 - y * 0.5) * height - cy)
    )
  )
  const mask: number[] = []
  for (let i = 0; i < visible.length / 4; i++) {
    const x = (i % width) + 0.5
    const y = Math.floor(i / width) + 0.5
    if (Math.hypot(x - cx, y - cy) > radius) continue
    const offset = i * 4
    const diff = Math.max(
      Math.abs(visible[offset]! - hidden[offset]!),
      Math.abs(visible[offset + 1]! - hidden[offset + 1]!),
      Math.abs(visible[offset + 2]! - hidden[offset + 2]!)
    )
    if (diff > 1e-4) mask.push(i)
  }
  return mask
}

/**
 * floors from the 2026-10-05 measurement (fraction 0.625,
 * darkening 0.02999 on 96 pixels), about 2.5x and 6x under that signal
 * ADR-011 Amendment 13
 */
const RECEIVER_SHADED_FLOOR = 0.25
const RECEIVER_DARKENING_FLOOR = 0.005

function receiverShadowStats(
  shadowed: number[],
  unshadowed: number[],
  mask: number[]
): { fraction: number; meanOn: number; meanOff: number; darkening: number } {
  let shaded = 0
  let meanOn = 0
  let meanOff = 0
  for (const pixel of mask) {
    const on = pixelLuminance(shadowed, pixel)
    const off = pixelLuminance(unshadowed, pixel)
    meanOn += on
    meanOff += off
    if (off - on > 1e-4) shaded++
  }
  meanOn /= mask.length
  meanOff /= mask.length
  return {
    fraction: shaded / mask.length,
    meanOn,
    meanOff,
    darkening: meanOff - meanOn
  }
}

function pixelLuminance(data: number[], pixel: number): number {
  const offset = pixel * 4
  return (
    0.2126 * data[offset]! +
    0.7152 * data[offset + 1]! +
    0.0722 * data[offset + 2]!
  )
}

function maxAbsDiff(a: number[], b: number[]): number {
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d > max) max = d
  }
  return max
}

function meanLuminance(data: number[]): number {
  let sum = 0
  const n = data.length / 4
  for (let i = 0; i < n; i++) {
    sum +=
      0.2126 * data[i * 4]! +
      0.7152 * data[i * 4 + 1]! +
      0.0722 * data[i * 4 + 2]!
  }
  return sum / n
}

// cos(angle between each pixel's view ray and the sun), side B, row 0 at the
// top (the convention receiverMask above uses and the 3.2b test validates)
async function sunAlignment(
  page: Page,
  width: number,
  height: number
): Promise<number[]> {
  return page.evaluate(
    ({ w, h }) => {
      const b = (window as ParityWindow).__parity.sideBHandle
      if (b == null) throw new Error('side B not available')
      const { camera, cloudsContext } = b
      camera.updateMatrixWorld(true)
      const eye = camera.position.clone()
      camera.getWorldPosition(eye)
      const toWorld = cloudsContext.worldToECEFMatrix.clone().invert()
      const sun = cloudsContext.sunDirection.clone().transformDirection(toWorld)
      const ray = eye.clone()
      const out: number[] = []
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          ray
            .set(((x + 0.5) / w) * 2 - 1, 1 - ((y + 0.5) / h) * 2, 0.5)
            .unproject(camera)
            .sub(eye)
            .normalize()
          out.push(ray.dot(sun))
        }
      }
      return out
    },
    { w: width, h: height }
  )
}

async function graphVersion(page: Page): Promise<number> {
  return page.evaluate(() => {
    const b = (window as ParityWindow).__parity.sideBHandle
    if (b == null) throw new Error('side B not available')
    return b.cloudsContext.graphVersion
  })
}

// Sample-count view: R = march samples / 500 (clouds.frag:899), counted outside
// the gaps. A gap ray still reads >0 (the reference: 6.2 samples per gap ray,
// 2026-09-24), so skipping is a reduction
const countAt = (data: number[], pixel: number): number =>
  data[pixel * 4]! * 500

// No registry pose has rays wholly inside the DEFAULT gap, so BOTH cameras move
// to 5000 m on the equator looking along the horizon, where a band ~0.3-1.5 deg
// below it stays in the gap for the whole march (regions.test.ts 'gap-band')
const ER = 6378137
async function gapPoseRays(page: Page): Promise<{
  origin: [number, number, number]
  dirs: number[]
  maxRayDistance: number
  layers: Array<{ altitude: number; height: number; channel: string }>
  width: number
  height: number
}> {
  // Sizes the readback only, one frame so the target has been drawn
  const read = await renderSideAndRead(page, 'B', 1)
  const geometry = await page.evaluate(
    ({ w, h, er }) => {
      const p = (window as ParityWindow).__parity
      const b = p.sideBHandle
      if (b == null) throw new Error('side B not available')
      const { camera, cloudsContext } = b
      for (const c of [camera, (p.sideAHandle as SideAHandle).camera]) {
        c.position.set(0, er + 5000, 0)
        c.lookAt(250000, er + 5000, 0)
        c.updateMatrixWorld(true)
      }
      const toECEF = cloudsContext.worldToECEFMatrix
      const eye = camera.position.clone()
      const originECEF = eye.clone().applyMatrix4(toECEF)
      const ray = eye.clone()
      const dirs: number[] = []
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          ray
            .set(((x + 0.5) / w) * 2 - 1, 1 - ((y + 0.5) / h) * 2, 0.5)
            .unproject(camera)
            .sub(eye)
            .transformDirection(toECEF)
          dirs.push(ray.x, ray.y, ray.z)
        }
      }
      return {
        origin: originECEF.toArray(),
        dirs,
        maxRayDistance: cloudsContext.clouds.maxRayDistance,
        // Array.from, not .map: CloudLayers extends Array, and map() would
        // construct a CloudLayers from a length
        layers: Array.from(cloudsContext.cloudLayers, l => ({
          altitude: l.altitude,
          height: l.height,
          channel: l.channel
        }))
      }
    },
    { w: read.width, h: read.height, er: ER }
  )
  return { ...geometry, width: read.width, height: read.height }
}

// Log-depth precision (tests 5b, 5c). The arithmetic behind every
// number here is in src/metrics/depthPrecision.ts and test/depthPrecision.test.ts
const LOG_DEPTH_ARMS = [
  { label: 'log', caseName: 'log-depth', log: true },
  { label: 'linear', caseName: 'baseline-medium', log: false }
] as const
const EXTREME = { near: 1e-4, far: 1e8 }
const CONTEST = { near: 45_000, far: 45_045, size: 64 }
const OCCLUDER_DISTANCE = 45_000
const OCCLUDER_HALF_ANGLE = (12 * Math.PI) / 180

async function logDepthFlags(page: Page): Promise<{ A: boolean; B: boolean }> {
  return page.evaluate(() => {
    const p = (window as ParityWindow).__parity
    if (p.sideBHandle == null) throw new Error('side B not available')
    const a = p.sideAHandle as SideAHandle
    return {
      A: a.renderer.capabilities.logarithmicDepthBuffer,
      B: p.sideBHandle.renderer.logarithmicDepthBuffer
    }
  })
}

/**
 * Renders the two-quad depth contest on one side's own renderer into a private
 * size x size target at the EXTREME near/far, and returns its RGBA bytes
 * Red near quad (|ndc| < 0.5) drawn first, green far quad (whole view) second
 */
async function depthContest(page: Page, side: 'A' | 'B'): Promise<number[]> {
  return page.evaluate(
    async ({ renderSide, near, far, d1, d2, size }) => {
      const p = (window as ParityWindow).__parity
      const handle =
        renderSide === 'A' ? (p.sideAHandle as SideAHandle) : p.sideBHandle
      if (handle == null) throw new Error(`side ${renderSide} not available`)
      const { plane, scene: template } = handle.sceneResult
      const scene = new (template.constructor as new () => Scene)()
      const camera = (handle.camera as PerspectiveCamera).clone()
      camera.position.set(0, 0, 0)
      camera.quaternion.identity()
      camera.near = near
      camera.far = far
      camera.aspect = 1
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)
      const tanHalf = Math.tan((camera.fov * Math.PI) / 360)
      const Geometry = plane.geometry.constructor as new (
        w: number,
        h: number
      ) => PlaneGeometry
      const MeshClass = plane.constructor as new (
        g: PlaneGeometry,
        m: MeshBasicMaterial
      ) => Mesh
      const quad = (
        distance: number,
        halfNdc: number,
        rgb: [number, number, number],
        order: number
      ): void => {
        const material = (plane.material as MeshBasicMaterial).clone()
        material.color.setRGB(...rgb)
        const extent = 2 * distance * tanHalf * halfNdc
        const mesh = new MeshClass(new Geometry(extent, extent), material)
        mesh.position.set(0, 0, -distance)
        mesh.renderOrder = order
        mesh.frustumCulled = false
        scene.add(mesh)
      }
      quad(d1, 0.5, [1, 0, 0], 1)
      quad(d2, 1.5, [0, 1, 0], 2)

      if (renderSide === 'A') {
        const a = handle as SideAHandle
        const renderer = a.renderer
        const Target = a.composer.inputBuffer.constructor as new (
          w: number,
          h: number
        ) => WebGLRenderTarget
        const target = new Target(size, size)
        const previous = renderer.getRenderTarget()
        renderer.setRenderTarget(target)
        renderer.render(scene, camera)
        const pixels = new Uint8Array(size * size * 4)
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels)
        renderer.setRenderTarget(previous)
        target.dispose()
        return Array.from(pixels)
      }
      const b = p.sideBHandle!
      const Target = b.linearRT.constructor as new (
        w: number,
        h: number
      ) => RenderTarget
      // 64 px * 4 bytes = 256-byte rows, so the readback carries no row padding
      const target = new Target(size, size)
      const previous = b.renderer.getRenderTarget()
      b.renderer.setRenderTarget(target)
      b.renderer.render(scene, camera)
      b.renderer.setRenderTarget(previous)
      const pixels = await b.renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        size,
        size
      )
      target.dispose()
      return Array.from(pixels as ArrayLike<number>)
    },
    {
      renderSide: side,
      near: EXTREME.near,
      far: EXTREME.far,
      d1: CONTEST.near,
      d2: CONTEST.far,
      size: CONTEST.size
    }
  )
}

/**
 * Side B: sets the scene camera to the EXTREME near/far and adds a hidden black
 * camera-facing occluder OCCLUDER_DISTANCE down the view axis. Returns the
 * occluder's half-extent in NDC
 */
async function addOccluder(
  page: Page
): Promise<{ halfNdcX: number; halfNdcY: number }> {
  return page.evaluate(
    ({ near, far, distance, halfAngle }) => {
      const b = (window as ParityWindow).__parity.sideBHandle
      if (b == null) throw new Error('side B not available')
      const camera = b.camera as PerspectiveCamera
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)
      const { plane, scene } = b.sceneResult
      const material = (plane.material as MeshBasicMaterial).clone()
      material.color.setRGB(0, 0, 0)
      const extent = 2 * distance * Math.tan(halfAngle)
      const Geometry = plane.geometry.constructor as new (
        w: number,
        h: number
      ) => PlaneGeometry
      const MeshClass = plane.constructor as new (
        g: PlaneGeometry,
        m: MeshBasicMaterial
      ) => Mesh
      const occluder = new MeshClass(new Geometry(extent, extent), material)
      const forward = camera.getWorldDirection(camera.position.clone())
      occluder.position.copy(camera.position).addScaledVector(forward, distance)
      occluder.quaternion.copy(camera.quaternion)
      occluder.name = 'vtr9-occluder'
      occluder.frustumCulled = false
      occluder.visible = false
      scene.add(occluder)
      const t = Math.tan(halfAngle) / Math.tan((camera.fov * Math.PI) / 360)
      return { halfNdcY: t, halfNdcX: t / camera.aspect }
    },
    {
      near: EXTREME.near,
      far: EXTREME.far,
      distance: OCCLUDER_DISTANCE,
      halfAngle: OCCLUDER_HALF_ANGLE
    }
  )
}

async function setOccluderVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate(value => {
    const b = (window as ParityWindow).__parity.sideBHandle
    const occluder = b?.sceneResult.scene.getObjectByName('vtr9-occluder')
    if (occluder == null) throw new Error('occluder not added')
    occluder.visible = value
  }, visible)
}

/**
 * The shape volume each side is actually sampling (procedural or baked), read
 * back as its red channel: size^3 bytes, x fastest, then y, then z. Side A
 * attaches each GL texture layer to a scratch framebuffer, side B copies each
 * z-slice to a buffer. Base64 keeps the 2 MB transfer compact
 */
async function readShapeVolume(
  page: Page,
  side: 'A' | 'B'
): Promise<{ size: number; format: number; bytes: Uint8Array }> {
  const result = await page.evaluate(
    async ({ readSide, red, rgba }) => {
      const p = (window as ParityWindow).__parity
      type Volume = {
        isTexture?: boolean
        format: number
        image: { width: number }
      }
      const unwrap = (source: unknown): Volume => {
        if (source == null)
          throw new Error(`side ${readSide} has no shape texture`)
        const s = source as Volume & { texture?: Volume }
        return s.isTexture === true ? s : s.texture!
      }
      const toBase64 = (bytes: Uint8Array): string => {
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        return btoa(s)
      }

      if (readSide === 'A') {
        const a = p.sideAHandle as SideAHandle
        const texture = unwrap(a.clouds.shapeTexture)
        const size = texture.image.width
        const renderer = a.renderer
        const gl = renderer.getContext() as WebGL2RenderingContext
        const handle = (
          renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }
        ).__webglTexture
        if (handle == null)
          throw new Error('side A shape has no GL texture yet')
        const framebuffer = gl.createFramebuffer()
        const slice = new Uint8Array(size * size * 4)
        const out = new Uint8Array(size * size * size)
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        try {
          for (let z = 0; z < size; z++) {
            gl.framebufferTextureLayer(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              handle,
              0,
              z
            )
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
              throw new Error(
                `side A shape layer ${z} is not readable (${status})`
              )
            }
            gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, slice)
            for (let i = 0; i < size * size; i++) {
              out[z * size * size + i] = slice[i * 4]!
            }
          }
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.deleteFramebuffer(framebuffer)
          renderer.resetState()
        }
        return { size, format: texture.format, bytes: toBase64(out) }
      }

      const b = p.sideBHandle
      if (b == null) throw new Error('side B not available')
      const texture = unwrap(b.cloudsContext.shapeTexture)
      const size = texture.image.width
      const bytesPerTexel =
        texture.format === red ? 1 : texture.format === rgba ? 4 : 0
      if (bytesPerTexel === 0) {
        throw new Error(
          `side B shape format ${texture.format} is not R8 or RGBA8`
        )
      }
      // copyTextureToBuffer pads each row to 256 bytes (WebGPUTextureUtils)
      const bytesPerRow = Math.ceil((size * bytesPerTexel) / 256) * 256
      const backend = b.renderer.backend as unknown as {
        copyTextureToBuffer: (
          t: unknown,
          x: number,
          y: number,
          w: number,
          h: number,
          z: number
        ) => Promise<ArrayBufferView>
      }
      const out = new Uint8Array(size * size * size)
      for (let z = 0; z < size; z++) {
        const view = await backend.copyTextureToBuffer(
          texture,
          0,
          0,
          size,
          size,
          z
        )
        const raw = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength
        )
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            out[(z * size + y) * size + x] =
              raw[y * bytesPerRow + x * bytesPerTexel]!
          }
        }
      }
      return { size, format: texture.format, bytes: toBase64(out) }
    },
    { readSide: side, red: RedFormat, rgba: RGBAFormat }
  )
  return {
    size: result.size,
    format: result.format,
    bytes: new Uint8Array(Buffer.from(result.bytes, 'base64'))
  }
}

/**
 * Side A's sample counts with interval skipping OFF. The reference's
 * DEBUG_MARCH_INTERVALS only disables skipping and is meant to be combined with
 * DEBUG_SHOW_SAMPLE_COUNT (clouds.frag:501-507, :898-905), which the harness's
 * one-view-at-a-time 'marchIntervals' does not do, so both defines are set on
 * the march material directly. Returns the defines as read back
 */
async function setSideASkippingOff(
  page: Page
): Promise<{ sampleCount: boolean; marchIntervals: boolean }> {
  return page.evaluate(() => {
    const a = (window as ParityWindow).__parity.sideAHandle as SideAHandle
    const material = a.clouds.cloudsPass.currentMaterial
    material.defines ??= {}
    material.defines.DEBUG_MARCH_INTERVALS = '1'
    material.needsUpdate = true
    return {
      sampleCount: material.defines.DEBUG_SHOW_SAMPLE_COUNT != null,
      marchIntervals: material.defines.DEBUG_MARCH_INTERVALS != null
    }
  })
}

async function setState(
  page: Page,
  partial: Record<string, unknown>
): Promise<void> {
  await page.evaluate(p => (window as ParityWindow).__parity.set(p), partial)
}

async function consoleErrors(page: Page): Promise<string[]> {
  return await page.evaluate(
    () => (window as ParityWindow).__parity.errors ?? []
  )
}

// A debug view that rendered nothing would be a flat buffer. Variance is the
// cheapest honest "is there an image here" check
function luminanceStdDev(data: number[]): number {
  const n = data.length / 4
  let sum = 0
  const lum = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lum[i] =
      0.2126 * data[i * 4]! +
      0.7152 * data[i * 4 + 1]! +
      0.0722 * data[i * 4 + 2]!
    sum += lum[i]!
  }
  const mean = sum / n
  let acc = 0
  for (let i = 0; i < n; i++) acc += (lum[i]! - mean) ** 2
  return Math.sqrt(acc / n)
}

function assertFinitePixels(
  read: { data: number[]; width: number; height: number },
  side: 'A' | 'B'
): void {
  expect(
    read.data.length,
    `side ${side} scene readback must contain pixels`
  ).toBe(read.width * read.height * 4)
  expect(
    read.data.every(Number.isFinite),
    `side ${side} scene readback must contain only finite values`
  ).toBe(true)
}

async function readCloudlessScenes(page: Page): Promise<{
  A: { data: number[]; width: number; height: number }
  B: { data: number[]; width: number; height: number }
}> {
  return page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    p.set({ enabled: false })

    const read = async (side: 'A' | 'B') => {
      await p.renderOnce(side, { time: 0, frame: 0, warmup: 64 })
      const result = await p.readSceneLinear(side)
      return {
        width: result.width,
        height: result.height,
        data: Array.from(result.data)
      }
    }

    return { A: await read('A'), B: await read('B') }
  })
}

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'p4')
})

test.describe('Phase 4 — scene/atmosphere readback', () => {
  test('clouds-off full-frame scenes agree without a vacuous plate', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')

    await expect(
      page.evaluate(async () => {
        await (window as ParityWindow).__parity.readSceneLinear('A')
      })
    ).rejects.toThrow('requires clouds to be disabled')
    await expect(
      page.evaluate(async () => {
        await (window as ParityWindow).__parity.readSceneLinear('B')
      })
    ).rejects.toThrow('requires clouds to be disabled')

    const reads = await readCloudlessScenes(page)

    expect(reads.A.width).toBeGreaterThan(0)
    expect(reads.A.height).toBeGreaterThan(0)
    expect([reads.B.width, reads.B.height]).toEqual([
      reads.A.width,
      reads.A.height
    ])
    assertFinitePixels(reads.A, 'A')
    assertFinitePixels(reads.B, 'B')

    const meanA = meanLuminance(reads.A.data)
    const meanB = meanLuminance(reads.B.data)
    const stdA = luminanceStdDev(reads.A.data)
    const stdB = luminanceStdDev(reads.B.data)
    const relativeMeanError = Math.abs(meanA - meanB) / Math.max(meanA, meanB)
    const ssim = computeSSIM(
      Float32Array.from(reads.A.data),
      Float32Array.from(reads.B.data),
      reads.A.width,
      reads.A.height
    )
    console.log(
      JSON.stringify({
        sceneLinear: {
          dimensions: [reads.A.width, reads.A.height],
          A: { mean: meanA, std: stdA },
          B: { mean: meanB, std: stdB },
          relativeMeanError,
          ssim
        }
      })
    )

    expect(meanA, 'side A scene must be lit').toBeGreaterThan(1e-3)
    expect(meanB, 'side B scene must be lit').toBeGreaterThan(1e-3)
    expect(stdA, 'side A scene must not be flat').toBeGreaterThan(1e-4)
    expect(stdB, 'side B scene must not be flat').toBeGreaterThan(1e-4)

    // ADR-013 A2/A4: A reads the LUT, B marches the same integral, converged at
    // SSIM 0.976-0.985. 0.95 and 10 % leave method headroom while rejecting
    // unrelated plates and the old 86 % mismatch
    expect(ssim, `clouds-off scene SSIM ${ssim}`).toBeGreaterThanOrEqual(0.95)
    expect(
      relativeMeanError,
      `clouds-off scene means differ by ${(relativeMeanError * 100).toFixed(2)}% ` +
        `(A=${meanA}, B=${meanB})`
    ).toBeLessThanOrEqual(0.1)
  })
})

test.describe('Phase 4 — ADR-007 3.2b (port addition, side B only)', () => {
  test('cloud shadows reach the visible atmosphere-light receiver', async ({
    page
  }) => {
    await loadCase(page, 'shadow-sphere')

    const flagsOff = await setCasters(page, false)
    expect(flagsOff.A.every(flag => !flag)).toBe(true)
    expect(flagsOff.B?.every(flag => !flag)).toBe(true)
    const visibleOff = await setSphereVisible(page, true)
    expect(visibleOff).toEqual({ A: true, B: true })
    const unshadowedA = await renderSideAndRead(page, 'A')
    const unshadowedB = await renderSideAndRead(page, 'B')
    const projectionA = await sphereProjection(page, 'A')
    const projectionB = await sphereProjection(page, 'B')

    const hidden = await setSphereVisible(page, false)
    expect(hidden).toEqual({ A: false, B: false })
    const hiddenA = await renderSideAndRead(page, 'A', 4)
    const hiddenB = await renderSideAndRead(page, 'B', 4)

    const maskA = receiverMask(
      unshadowedA.data,
      hiddenA.data,
      unshadowedA.width,
      unshadowedA.height,
      projectionA
    )
    const maskB = receiverMask(
      unshadowedB.data,
      hiddenB.data,
      unshadowedB.width,
      unshadowedB.height,
      projectionB
    )
    expect(
      maskA.length,
      'side A must render the light-reactive sphere'
    ).toBeGreaterThan(64)
    expect(
      maskB.length,
      'side B must render the light-reactive sphere'
    ).toBeGreaterThan(64)

    const visibleOn = await setSphereVisible(page, true)
    expect(visibleOn).toEqual({ A: true, B: true })
    const flagsOn = await setCasters(page, true)
    expect(flagsOn.A.every(Boolean)).toBe(true)
    expect(flagsOn.B?.every(Boolean)).toBe(true)
    const shadowedA = await renderSideAndRead(page, 'A')
    const shadowedB = await renderSideAndRead(page, 'B')

    const receiptA = receiverShadowStats(
      shadowedA.data,
      unshadowedA.data,
      maskA
    )
    const receiptB = receiverShadowStats(
      shadowedB.data,
      unshadowedB.data,
      maskB
    )
    console.log(
      JSON.stringify({
        receiverPixels: { A: maskA.length, B: maskB.length },
        shadedFraction: { A: receiptA, B: receiptB },
        flagsOff,
        flagsOn
      })
    )

    // measured floors, not a token above zero. At this pose side B
    // is fraction 0.625 and darkening 0.02999. ADR-011 Amendment 13
    expect(
      receiptB.fraction,
      `3.2b must shade most of side B's visible receiver; measured 0.625`
    ).toBeGreaterThanOrEqual(RECEIVER_SHADED_FLOOR)
    expect(
      receiptB.darkening,
      `3.2b must darken side B's visible receiver; ` +
        `on=${receiptB.meanOn.toFixed(6)} off=${receiptB.meanOff.toFixed(6)}`
    ).toBeGreaterThan(RECEIVER_DARKENING_FLOOR)
    // And the premise the capture receipt now rests on: side A has NO
    // consumer here, so its receiver must NOT darken. If it ever does, case
    // 35 is not the lights-mode case any more and the b-only policy is wrong
    expect(
      receiptA.fraction,
      `side A must NOT shade its receiver: the reference has no 3.2b consumer`
    ).toBeLessThanOrEqual(MIN_SIGNAL_FRACTION)
    expect(
      receiptA.darkening,
      `side A must NOT darken its receiver: the reference has no 3.2b consumer`
    ).toBeLessThanOrEqual(RECEIVER_DARKENING_FLOOR)
  })

  test('case 35 is a lights-mode case, so A/B parity cannot cover 3.2b', async ({
    page
  }) => {
    // Pins the premise of the B-side-only assertion above: if case 35 ever
    // stops being the lights-mode case, that reasoning no longer holds and
    // this should fail loudly
    await loadCase(page, 'shadow-sphere')
    // `__parity.lighting` never existed, so its `== null` arm passed for every
    // case until typing the probe made it a compile error. The
    // effective mode is main.ts:279's: the ?lighting= override, else the case's
    const lighting = await page.evaluate(() => {
      const p = (window as ParityWindow).__parity
      return p.params.lighting ?? p.pc.lighting ?? null
    })
    expect(
      lighting,
      `case 35 must run in lights mode; harness reported ${String(lighting)}`
    ).toBe('lights')
  })
})

// ── goo items 1, 2, 3: the phase-4 feature knobs ──────────────
// CLOSED features: the knobs exist on both sides and `__parity.set` reaches
// them as PARITY_KEYS entries (unlike `debug`, which needs a case load)

test.describe('Phase 4 — feature knobs', () => {
  test('1. haze changes the render below the deck, and is inert from orbit', async ({
    page
  }) => {
    // below-deck-1km, NOT the haze-on case: case 42 sits at ORBIT_60KM, above
    // the ground-level haze, so both first-run poses measured at the fp16
    // floor (3 and 1 ULPs). The case name had done the reasoning, not the pose
    await loadCase(page, 'below-deck-1km')
    await setState(page, { haze: true })
    const on = await renderAndRead(page)
    await setState(page, { haze: false })
    const off = await renderAndRead(page)
    const nearDiff = maxAbsDiff(on, off)
    expect(
      nearDiff,
      'haze on vs off must change the render on a case posed inside the haze'
    ).toBeGreaterThan(1e-4)

    // The reference early-outs below density 1e-7, so from 140 km haze adds
    // nothing. Relative to below-deck: the first run read one half-float ULP,
    // and a bar below that only asserts fp16 is fp32
    await loadCase(page, 'orbit-140km')
    await setState(page, { haze: true })
    const farOn = await renderAndRead(page)
    await setState(page, { haze: false })
    const farOff = await renderAndRead(page)
    const farDiff = maxAbsDiff(farOn, farOff)

    // In side A's HalfFloat ULP (1.220703125e-4): `farDiff < nearDiff / 10`
    // demanded 0.61 ULP, passing only the inert-knob zero. From orbit
    // at the floor, below the deck several quanta above
    const HALF_FLOAT_ULP = 2 ** -13
    expect(
      nearDiff,
      `below the deck haze must move the plate by several quanta ` +
        `(measured ${nearDiff}, ULP ${HALF_FLOAT_ULP})`
    ).toBeGreaterThan(3 * HALF_FLOAT_ULP)
    expect(
      farDiff,
      `from orbit the haze march early-outs, so its effect must be ` +
        `indistinguishable from the quantisation floor ` +
        `(orbit ${farDiff}, below-deck ${nearDiff}, ULP ${HALF_FLOAT_ULP})`
    ).toBeLessThanOrEqual(HALF_FLOAT_ULP)
  })

  // Test 1 compares two compiled programs (haze is graph-shape), so it cannot
  // demand bit-identity. This keeps ONE program and varies only the density:
  // from 140 km both arms take the early-out, so the readbacks match exactly
  test('1b. from orbit, haze is bit-identical to zero haze density (the early-out)', async ({
    page
  }) => {
    const ULP = 2 ** -13
    // Positive control: below the deck the density uniform must reach the
    // shader, or the orbit identity below would hold for an inert knob
    await loadCase(page, 'below-deck-1km')
    await setState(page, { haze: true })
    const nearDefault = await renderAndRead(page)
    await setState(page, { clouds: { hazeDensityScale: 0 } })
    const nearZero = await renderAndRead(page)
    const nearDiff = maxAbsDiff(nearDefault, nearZero)

    await loadCase(page, 'orbit-140km')
    await setState(page, { haze: true })
    const farDefault = await renderAndRead(page)
    const farRepeat = await renderAndRead(page)
    await setState(page, { clouds: { hazeDensityScale: 0 } })
    const farZero = await renderAndRead(page)
    const repeatDiff = maxAbsDiff(farDefault, farRepeat)
    const hazeDiff = maxAbsDiff(farDefault, farZero)
    console.log(
      JSON.stringify({ hazeEarlyOut: { nearDiff, hazeDiff, repeatDiff } })
    )

    expect(
      nearDiff,
      'hazeDensityScale did not move the plate below the deck — the knob is ' +
        'inert, so the orbit identity would be vacuous'
    ).toBeGreaterThan(3 * ULP)
    expect(
      hazeDiff,
      `from orbit haze must contribute exactly nothing: default vs zero density ` +
        `differ by ${hazeDiff}, a same-config repeat by ${repeatDiff}`
    ).toBeLessThanOrEqual(repeatDiff)
  })

  // Clause 2 names below-deck-1km and the deck UNDERSIDE. Masking to cloud
  // pixels (all underside from below) stops sky and ground diluting the mean,
  // which test 2's whole-plate reading at this pose did 17x
  test('2b. ground bounce brightens the deck underside at below-deck-1km', async ({
    page
  }) => {
    await loadCase(page, 'below-deck-1km')
    const flags = await setCasters(page, true)
    expect(flags.B?.every(Boolean), 'side B cloud shadows must be on').toBe(
      true
    )
    await setState(page, { clouds: { maxIterationCountToGround: 3 } })

    await setState(page, { groundBounceScale: 1 })
    const low = await renderAndRead(page)
    await setState(page, { enabled: false })
    const cloudless = await renderAndRead(page)
    await setState(page, { enabled: true })
    const underside = changedPixels(low, cloudless, 1e-3)

    await setState(page, { groundBounceScale: 100 })
    const high = await renderAndRead(page)
    const highRepeat = await renderAndRead(page)
    const mLow = meanLuminanceOver(low, underside)
    const mHigh = meanLuminanceOver(high, underside)
    const noise = Math.abs(meanLuminanceOver(highRepeat, underside) - mHigh)
    const fraction = underside.length / (low.length / 4)
    console.log(
      JSON.stringify({
        groundBounceUnderside: { fraction, mLow, mHigh, noise }
      })
    )

    expect(
      fraction,
      'too few cloud pixels at below-deck-1km — there is no underside to measure'
    ).toBeGreaterThan(0.05)
    expect(
      mHigh - mLow,
      `ground bounce 1 -> 100 must brighten the underside beyond the repeat ` +
        `noise; moved ${(mHigh - mLow).toExponential(3)}, noise ${noise.toExponential(3)}`
    ).toBeGreaterThan(Math.max(noise * 3, 0))
  })

  test('2. ground bounce brightens the undersides, and responds to the knob', async ({
    page
  }) => {
    // Ground bounce needs `height < shadowTopHeight && mipLevel < 0.5`
    // (primaryMarch.ts:242, clouds.frag:561). Asserts MONOTONICITY, not
    // linearity: transmittance saturates the readback. Non-zero scales only
    await loadCase(page, 'ground-bounce-on')
    const meanAt = async (v: number): Promise<number> => {
      await setState(page, { groundBounceScale: v })
      return meanLuminance(await renderAndRead(page))
    }
    const [m0, m1, m8, m100] = [
      await meanAt(0),
      await meanAt(1),
      await meanAt(8),
      await meanAt(100)
    ]

    // The run-to-run floor, measured rather than assumed
    const repeat = await meanAt(100)
    const noise = Math.abs(repeat - m100)

    expect(
      m1 - m0,
      `enabling ground bounce must brighten the deck underside; moved ${(m1 - m0).toExponential(3)}`
    ).toBeGreaterThan(noise * 5)
    expect(
      m8 - m1,
      `raising the scale must brighten it further; 1->8 moved ${(m8 - m1).toExponential(3)}, noise ${noise.toExponential(3)}`
    ).toBeGreaterThan(noise * 5)
    expect(
      m100 - m8,
      `and further again; 8->100 moved ${(m100 - m8).toExponential(3)}`
    ).toBeGreaterThan(0)
  })

  test('3. the Draine phase function rebuilds and changes the silver lining', async ({
    page
  }) => {
    await loadCase(page, 'draine-phase')
    const draineRead = await renderSideAndRead(page, 'B')
    const draine = draineRead.data
    // accuratePhaseFunction is a GRAPH-SHAPE key: applyToB re-applies it
    // through the top-level setter so graphVersion bumps and the node graph
    // rebuilds. Asserted directly below rather than inferred from the diff
    const versionBefore = await graphVersion(page)
    await setState(page, { clouds: { accuratePhaseFunction: false } })
    const versionAfter = await graphVersion(page)
    const hg = await renderAndRead(page)
    const hgRepeat = await renderAndRead(page)
    expect(
      maxAbsDiff(draine, hg),
      'Draine vs HG must change the forward-scattering lobe'
    ).toBeGreaterThan(1e-4)
    expect(
      versionAfter,
      'turning accuratePhaseFunction off must bump graphVersion so the phase ' +
        'variant is recompiled; without it the toggle is inert at runtime'
    ).toBeGreaterThan(versionBefore)

    // The silver lining is forward scattering, so the clause asks for the
    // change where rays look toward the sun: the 5% of pixels most aligned
    // with it (the frame edge nearest the sun if the sun is off-screen)
    const cosines = await sunAlignment(
      page,
      draineRead.width,
      draineRead.height
    )
    const sunward = topFraction(cosines, 0.05)
    const delta = meanAbsLuminanceDeltaOver(draine, hg, sunward)
    const noise = meanAbsLuminanceDeltaOver(hg, hgRepeat, sunward)
    console.log(
      JSON.stringify({
        draineSunward: {
          pixels: sunward.length,
          maxCos: cosines[sunward[0]!],
          delta,
          noise,
          graphVersion: [versionBefore, versionAfter]
        }
      })
    )
    expect(
      delta,
      `Draine vs HG must change the sun-ward pixels beyond a same-config ` +
        `repeat; delta ${delta.toExponential(3)}, noise ${noise.toExponential(3)}`
    ).toBeGreaterThan(Math.max(noise * 3, 0))
  })
})

// ── goo item 6: the debug views ───────────────────────────────

test.describe('Phase 4 — debug views', () => {
  // The five the registry defines, cases 47-51. Until 070d1f6 four of them
  // rendered the BEAUTY pass on both sides and scored a pass, so "renders
  // something" is exactly the thing that was broken
  const DEBUG_CASES = [
    'debug-cascades',
    'debug-shadow-map',
    'debug-checker-uv',
    'debug-sample-count',
    'debug-front-depth'
  ] as const

  for (const name of DEBUG_CASES) {
    test(`6. ${name} renders on side B without console errors`, async ({
      page
    }) => {
      await loadCase(page, name)
      const data = await renderAndRead(page)
      const sd = luminanceStdDev(data)
      const errors = await consoleErrors(page)
      expect(errors, `${name} must render without console errors`).toEqual([])
      expect(
        sd,
        `${name} produced a flat buffer — the view rendered nothing`
      ).toBeGreaterThan(1e-5)
    })
  }

  test('6b. the debug views differ from each other', async ({ page }) => {
    // Guards the failure mode that actually occurred: several views collapsing
    // to the same output. Each rendering "something" is not enough if they all
    // render the SAME something
    const reads: number[][] = []
    for (const name of DEBUG_CASES) {
      await loadCase(page, name)
      reads.push(await renderAndRead(page))
    }
    for (let i = 1; i < reads.length; i++) {
      expect(
        maxAbsDiff(reads[0]!, reads[i]!),
        `${DEBUG_CASES[i]} is identical to ${DEBUG_CASES[0]} — collapsed views`
      ).toBeGreaterThan(1e-4)
    }
  })

  // All nine debug values on BOTH sides via the probe, each also differing from
  // 'none' (non-blank alone passes the beauty pass). Exempt: side A's
  // marchIntervals (draws nothing itself) and still-frame velocity (zero)
  test('6c. all nine debug values render on both sides and replace the beauty pass', async ({
    page
  }) => {
    test.setTimeout(300_000)
    await loadCase(page, 'shafts-low-sun')
    const reads: Record<string, Record<'A' | 'B', number[]>> = {}
    for (const view of DEBUG_VIEWS) {
      await setState(page, { debug: view })
      const a = await renderSideAndRead(page, 'A')
      const b = await renderSideAndRead(page, 'B')
      assertFinitePixels(a, 'A')
      assertFinitePixels(b, 'B')
      reads[view] = { A: a.data, B: b.data }
    }
    expect(
      DEBUG_VIEWS,
      'the library enumerates nine debug values'
    ).toHaveLength(9)
    expect(
      await consoleErrors(page),
      'debug views logged console errors'
    ).toEqual([])

    const rows = DEBUG_VIEWS.map(view => ({
      view,
      stdA: luminanceStdDev(reads[view]!.A),
      stdB: luminanceStdDev(reads[view]!.B),
      vsNoneA: maxAbsDiff(reads[view]!.A, reads.none!.A),
      vsNoneB: maxAbsDiff(reads[view]!.B, reads.none!.B)
    }))
    console.log(JSON.stringify({ debugViewsBothSides: rows }))
    for (const row of rows) {
      for (const side of ['A', 'B'] as const) {
        expect(
          side === 'A' ? row.stdA : row.stdB,
          `${row.view} rendered a flat buffer on side ${side}`
        ).toBeGreaterThan(1e-5)
        if (row.view === 'none' || row.view === 'velocity') continue
        if (side === 'A' && row.view === 'marchIntervals') continue
        expect(
          side === 'A' ? row.vsNoneA : row.vsNoneB,
          `${row.view} is identical to the beauty pass on side ${side} — ` +
            `the view selected nothing`
        ).toBeGreaterThan(1e-4)
      }
    }
  })
})

// ── goo item 8: the WebGL2 backend ────────────────────────────

// The p4 suite's clauses 4, 5, 7 and 10 had no tests while `--grep p4`
// stayed green. Each test below asserts the feature CHANGES something against a
// baseline, loading the feature's case rather than toggling

test.describe('Phase 4 — generated textures', () => {
  // NOT an A/B parity assertion: case 45's difference is a recorded FAIL with
  // an unknown mechanism. The suite asserts the generated path
  // renders AND differs from the baked one
  test('4. procedural textures render, and differ from the baked path', async ({
    page
  }) => {
    await loadCase(page, 'procedural-textures')
    const generated = await renderAndRead(page)
    expect(
      luminanceStdDev(generated),
      'the procedural case rendered a flat buffer — the generators did not reach the frame'
    ).toBeGreaterThan(1e-4)

    await loadCase(page, 'baseline-medium')
    const baked = await renderAndRead(page)
    expect(
      maxAbsDiff(generated, baked),
      'generated and baked textures produced identical frames — case 45 is vacuous'
    ).toBeGreaterThan(1e-4)
  })

  // side B's generated 128^3 shape vs side A's,
  // every slice, to one byte. Controls: each volume has structure, baked A
  // equals baked B exactly, and baked differs from procedural on each side
  test('4b. the generated 128^3 shape volume matches side A to 1/255, every slice', async ({
    page
  }) => {
    test.setTimeout(240_000)
    const readBoth = async (caseName: string) => {
      await loadCase(page, caseName)
      // One frame per side so each has generated / uploaded its shape texture
      await renderSideAndRead(page, 'A', 1)
      await renderSideAndRead(page, 'B', 1)
      return {
        A: await readShapeVolume(page, 'A'),
        B: await readShapeVolume(page, 'B')
      }
    }
    const generated = await readBoth('procedural-textures')
    const baked = await readBoth('baseline-medium')

    const generatedAB = compareVolumes(generated.A.bytes, generated.B.bytes)
    const bakedAB = compareVolumes(baked.A.bytes, baked.B.bytes)
    const summary = {
      size: { A: generated.A.size, B: generated.B.size },
      format: { A: generated.A.format, B: generated.B.format },
      generated: {
        ...generatedAB,
        checksum: {
          A: fnv1a32(generated.A.bytes),
          B: fnv1a32(generated.B.bytes)
        },
        spread: {
          A: byteSpread(generated.A.bytes),
          B: byteSpread(generated.B.bytes)
        }
      },
      baked: {
        ...bakedAB,
        checksum: { A: fnv1a32(baked.A.bytes), B: fnv1a32(baked.B.bytes) }
      }
    }
    console.log(JSON.stringify({ proceduralShapeReadback: summary }))

    expect(
      summary.size,
      'the shape volume must be 128^3 on both sides'
    ).toEqual({
      A: 128,
      B: 128
    })
    for (const side of ['A', 'B'] as const) {
      expect(
        summary.generated.spread[side].distinct,
        `side ${side}'s generated shape read back as (nearly) constant — the ` +
          `readback is not reading the generated volume`
      ).toBeGreaterThan(16)
      expect(
        summary.generated.checksum[side],
        `side ${side}: the procedural and baked reads are the same bytes — the ` +
          `readback did not follow the configured texture`
      ).not.toBe(summary.baked.checksum[side])
    }
    expect(
      bakedAB.maxAbs,
      'the baked shape is the same file on both sides, yet the two readbacks ' +
        'differ — the instrument, not the generator, is wrong'
    ).toBe(0)
    expect(
      generatedAB.maxAbs,
      `the generated shape differs by more than 1/255 somewhere ` +
        `(${generatedAB.differing} of ${generatedAB.texels} texels differ)`
    ).toBeLessThanOrEqual(1)
  })
})

test.describe('Phase 4 — log depth', () => {
  // A SMOKE TEST THAT DOES NOT SATISFY THE CLAUSE: log depth is a round trip,
  // so no colour assertion can falsify it. Precision is its own (5b, 5c)
  // This catches a failed construction, an erroring side or a black frame
  test('5. the log-depth case boots both sides and renders (SMOKE ONLY)', async ({
    page
  }) => {
    await loadCase(page, 'log-depth')
    expect(
      await consoleErrors(page),
      'log-depth booted with console errors'
    ).toEqual([])

    const data = await renderAndRead(page)
    expect(
      luminanceStdDev(data),
      'log-depth rendered a flat buffer'
    ).toBeGreaterThan(1e-4)
  })

  // ── precision, both directions ──
  // Two case loads (log-depth, baseline-medium), each asserting its flag. At
  // near 1e-4, far 1e8, 45 km, perspective depth rounds to 1.0, log to ~0.73
  for (const arm of LOG_DEPTH_ARMS) {
    for (const side of ['A', 'B'] as const) {
      // Renderer precision: two quads 45 m apart at 45 km, red near drawn
      // first, green far over a larger area. LessEqual ties go to the later
      // draw, so the centre shows WHICH SURFACE THE DEPTH BUFFER JUDGED NEARER
      test(`5b. ${arm.label} depth on side ${side}: ${arm.log ? 'keeps' : 'loses'} the order of two surfaces 45 m apart at 45 km`, async ({
        page
      }) => {
        await loadCase(page, arm.caseName)
        expect(
          await logDepthFlags(page),
          `the ${arm.label} arm is not running the renderers it claims`
        ).toEqual({ A: arm.log, B: arm.log })

        const predicted = depthTestWinner(
          arm.log ? (side === 'A' ? 'webglLog' : 'log') : 'linear',
          CONTEST.near,
          CONTEST.far,
          EXTREME.near,
          EXTREME.far
        )
        const rgba = await depthContest(page, side)
        const contest = classifyContest(rgba, CONTEST.size)
        console.log(
          JSON.stringify({
            depthContest: { arm: arm.label, side, predicted, ...contest }
          })
        )

        expect(
          contest.ringFar,
          'the far quad did not render — the contest measured nothing'
        ).toBeGreaterThan(0.99)
        if (arm.log) {
          expect(
            contest.centerNear,
            'log depth must keep the near surface in front (hundreds of steps apart)'
          ).toBeGreaterThan(0.99)
        } else {
          expect(
            contest.centerNear,
            'linear depth must tie both surfaces at 1.0 and hand the pixel to the ' +
              'later (far) draw; the near surface winning means the extreme did not bite'
          ).toBeLessThan(0.01)
        }
        expect(predicted).toBe(arm.log ? 'near' : 'far')
      })
    }

    // Side B's decode: a black occluder 45 km out must hide the decks (leak ~0
    // with log, of the effect's order with linear). Side A is not asserted: it
    // decodes through an fp32 perspective depth (clouds.frag:815)
    test(`5c. ${arm.label} depth on side B: the clouds march ${arm.log ? 'stops at' : 'runs through'} an occluder at 45 km`, async ({
      page
    }) => {
      test.setTimeout(240_000)
      await loadCase(page, arm.caseName)
      expect(
        await logDepthFlags(page),
        `the ${arm.label} arm is not running the renderers it claims`
      ).toEqual({ A: arm.log, B: arm.log })
      const frame = await addOccluder(page)

      const cloudEffect = async (visible: boolean): Promise<number> => {
        await setOccluderVisible(page, visible)
        await setState(page, { enabled: true })
        const on = await renderSideAndRead(page, 'B')
        await setState(page, { enabled: false })
        const off = await renderSideAndRead(page, 'B')
        const box = ndcBoxPixels(
          on.width,
          on.height,
          frame.halfNdcX * 0.8,
          frame.halfNdcY * 0.8
        )
        return meanAbsLuminanceDeltaOver(on.data, off.data, box)
      }
      const reference = await cloudEffect(false)
      const leak = await cloudEffect(true)
      const decoded = decodedDistance(
        arm.log ? 'log' : 'linear',
        OCCLUDER_DISTANCE,
        EXTREME.near,
        EXTREME.far
      )
      console.log(
        JSON.stringify({
          occluderLeak: {
            arm: arm.label,
            reference,
            leak,
            ratio: leak / reference,
            predictedDecodedDistance: decoded,
            logErrorBoundMetres:
              OCCLUDER_DISTANCE *
              logRelativeErrorBound(EXTREME.near, EXTREME.far)
          }
        })
      )

      expect(
        reference,
        'no clouds behind the occluder footprint — nothing to hide'
      ).toBeGreaterThan(1e-3)
      if (arm.log) {
        expect(
          leak / reference,
          'log depth: clouds leaked through an occluder the decode places within cm of 45 km'
        ).toBeLessThan(0.05)
      } else {
        expect(
          leak / reference,
          'linear depth: the occluder still hid the clouds although its depth rounds to the clear value'
        ).toBeGreaterThan(0.25)
      }
    })
  }
})

test.describe('Phase 4 — four layers', () => {
  test('7. a fourth cloud layer changes the render', async ({ page }) => {
    await loadCase(page, 'layers-4')
    const four = await renderAndRead(page)
    expect(
      luminanceStdDev(four),
      'layers-4 rendered a flat buffer'
    ).toBeGreaterThan(1e-4)

    await loadCase(page, 'baseline-medium')
    const three = await renderAndRead(page)
    expect(
      maxAbsDiff(four, three),
      'four layers produced the same frame as three — the fourth layer is inert'
    ).toBeGreaterThan(1e-4)
  })

  // Measured here (2026-09-24): per gap ray the reference took 6.23 samples,
  // B 8.67 skipping and 441.9 not, reductions ~0.986 (A) and 0.980 (B). Bound
  // B >= 0.95 x A. The skip-on/off ratio (~1.39 B/A) is logged, not asserted
  test('7b. interval skipping in the [2200, 7500] m gap removes at least 95% of the reference reduction on side B', async ({
    page
  }) => {
    test.setTimeout(240_000)
    await loadCase(page, 'baseline-medium')
    await setState(page, { debug: 'sampleCount' })
    const geometry = await gapPoseRays(page)
    const skippingA = await renderSideAndRead(page, 'A')
    const skippingB = await renderSideAndRead(page, 'B')
    const definesA = await setSideASkippingOff(page)
    const marchingA = await renderSideAndRead(page, 'A')
    // B's 'marchIntervals' draws sample counts with skipping disabled. (It also
    // resets A's defines, which are done being read above.)
    await setState(page, { debug: 'marchIntervals' })
    const marchingB = await renderSideAndRead(page, 'B')
    expect(
      definesA,
      "side A's skip-off read needs both sample-count and march-interval defines"
    ).toEqual({ sampleCount: true, marchIntervals: true })

    // The clause is about CloudLayers.DEFAULT: layer two tops out at 2200 m,
    // layer three starts at 7500 m, layer four is empty (src/CloudLayers.ts)
    // Another layer set would make the gap below the wrong gap
    const [, deck, cirrus, empty] = geometry.layers
    expect(
      [deck!.altitude + deck!.height, cirrus!.altitude, empty!.height],
      'side B is not running CloudLayers.DEFAULT'
    ).toEqual([2200, 7500, 0])

    // metres, covering the ER-vs-bottomRadius curvature difference
    const MARGIN = 300
    const gap: number[] = []
    const lowDeck: number[] = []
    for (let p = 0; p < geometry.width * geometry.height; p++) {
      const d = geometry.dirs
      const range = rayAltitudeRange(
        geometry.origin,
        [d[p * 3]!, d[p * 3 + 1]!, d[p * 3 + 2]!],
        geometry.maxRayDistance,
        ER
      )
      if (range.min > 2200 + MARGIN && range.max < 7500 - MARGIN) gap.push(p)
      else if (range.min < 2200 - MARGIN) lowDeck.push(p)
    }
    const mean = (data: number[], pixels: number[]) =>
      pixels.reduce((s, p) => s + countAt(data, p), 0) / pixels.length
    const all = Array.from(
      { length: geometry.width * geometry.height },
      (_, i) => i
    )
    const side = (skipping: number[], marching: number[]) => {
      const gapSkipping = mean(skipping, gap)
      const gapMarching = mean(marching, gap)
      return {
        gapSkipping,
        gapMarching,
        gapReduction: 1 - gapSkipping / gapMarching,
        lowDeckSkipping: mean(skipping, lowDeck),
        frameReduction: 1 - mean(skipping, all) / mean(marching, all)
      }
    }
    const A = side(skippingA.data, marchingA.data)
    const B = side(skippingB.data, marchingB.data)
    const ratios = {
      reductionBoverA: B.gapReduction / A.gapReduction,
      residualBoverA:
        B.gapSkipping / B.gapMarching / (A.gapSkipping / A.gapMarching)
    }
    console.log(
      JSON.stringify({
        intervalSkipping: {
          gapPixels: gap.length,
          lowDeckPixels: lowDeck.length,
          A,
          B,
          ...ratios
        }
      })
    )

    expect(
      gap.length,
      'no ray lies wholly in the gap from this pose — nothing tests skipping'
    ).toBeGreaterThan(100)
    expect(
      lowDeck.length,
      'no ray reaches the low deck — no positive control'
    ).toBeGreaterThan(100)
    for (const [name, s] of [
      ['A', A],
      ['B', B]
    ] as const) {
      expect(
        s.gapMarching,
        `side ${name}: the gap rays take no samples with skipping disabled, so ` +
          `there is no reduction to measure`
      ).toBeGreaterThanOrEqual(1)
      expect(
        s.lowDeckSkipping,
        `side ${name}: rays through the low deck read zero samples — the ` +
          `readback is not showing sample counts`
      ).toBeGreaterThanOrEqual(1)
    }
    expect(
      B.gapReduction,
      `side B's interval skipping removes a smaller share of the gap samples ` +
        `than 0.95 x the reference's (B ${B.gapReduction.toFixed(4)}, ` +
        `A ${A.gapReduction.toFixed(4)})`
    ).toBeGreaterThanOrEqual(0.95 * A.gapReduction)
  })

  // cloudLayers[1] is the dense 'g' deck, whose channel decides which samples
  // find density, so a change must show in the counts. The pass polls it and
  // bumps graphVersion, read after a render
  test('7c. changing layer 2 (cloudLayers[1]) channel bumps graphVersion and changes the readback', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    await setState(page, { debug: 'sampleCount' })
    const before = await renderSideAndRead(page, 'B')
    const versionBefore = await graphVersion(page)
    const previous = await page.evaluate(() => {
      const b = (window as ParityWindow).__parity.sideBHandle
      if (b == null) throw new Error('side B not available')
      const layer = b.cloudsContext.cloudLayers[1]!
      const was = layer.channel
      layer.channel = was === 'r' ? 'b' : 'r'
      return was
    })
    const after = await renderSideAndRead(page, 'B')
    const versionAfter = await graphVersion(page)
    const diff = maxAbsDiff(before.data, after.data)
    console.log(
      JSON.stringify({
        layerChannelChange: {
          previous,
          graphVersion: [versionBefore, versionAfter],
          maxAbsDiff: diff
        }
      })
    )

    expect(previous, "CloudLayers.DEFAULT's second layer reads 'g'").toBe('g')
    expect(
      versionAfter,
      'the channel change did not bump graphVersion — the swizzle is not rebuilt'
    ).toBeGreaterThan(versionBefore)
    expect(
      diff,
      'the channel change did not change the sample-count readback'
    ).toBeGreaterThan(1e-3)
  })
})

async function settledFrame(page: Page, enabled: boolean): Promise<number[]> {
  const start = await page.evaluate(value => {
    const probe = (window as R3FSmokeWindow).__r3fSmoke!
    probe.cloudsEnabled = value
    return probe.frames
  }, enabled)
  await page.waitForFunction(
    frame => ((window as R3FSmokeWindow).__r3fSmoke?.frames ?? 0) >= frame + 64,
    start,
    { timeout: 45_000 }
  )
  const png = await page.locator('canvas').screenshot()
  await test.info().attach(`r3f-clouds-${enabled ? 'on' : 'off'}`, {
    body: png,
    contentType: 'image/png'
  })
  // Decode a browser screenshot, not drawImage(WebGPU canvas), which can
  // return black. Inspect the sky band so ground shadows cannot stand in
  // for clouds actually reaching the composite
  return page.evaluate(async encoded => {
    const image = new Image()
    image.src = 'data:image/png;base64,' + encoded
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 80
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0, 128, 80)
    return Array.from(ctx.getImageData(0, 0, 128, 40).data).filter(
      (_, i) => i % 4 !== 3
    )
  }, png.toString('base64'))
}

function assertCloudPixels(
  on: number[],
  stable: number[],
  off: number[]
): void {
  expect(on.length).toBeGreaterThan(0)
  expect(stable).toHaveLength(on.length)
  expect(off).toHaveLength(on.length)
  const mean = on.reduce((sum, value) => sum + value, 0) / on.length
  const variance =
    on.reduce((sum, value) => sum + (value - mean) ** 2, 0) / on.length
  const difference = (other: number[]) =>
    on.reduce((sum, value, i) => sum + Math.abs(value - other[i]!), 0) /
    on.length
  const drift = difference(stable)
  const cloudEffect = difference(off)
  const offMean = off.reduce((sum, value) => sum + value, 0) / off.length
  console.log('[r3f smoke]', { mean, variance, drift, cloudEffect, offMean })
  expect(mean, 'blank or saturated sky').toBeGreaterThan(10)
  expect(mean, 'blank or saturated sky').toBeLessThan(250)
  expect(variance, 'uniform sky').toBeGreaterThan(5)
  expect(
    offMean,
    'disabling clouds must leave a visible atmosphere'
  ).toBeGreaterThan(10)
  expect(
    cloudEffect,
    'cloud toggle must change sky beyond temporal drift'
  ).toBeGreaterThan(Math.max(1, drift * 3))
}

test.describe('Phase 4 — examples/r3f smoke', () => {
  test('9a. smoke pixel assertions reject blank and cloud-free output', () => {
    expect(() => assertCloudPixels([], [], [])).toThrow()
    const blank = Array<number>(300).fill(0)
    expect(() => assertCloudPixels(blank, blank, blank)).toThrow()
    const skyOnly = Array.from({ length: 300 }, (_, i) => 80 + (i % 100))
    expect(() => assertCloudPixels(skyOnly, skyOnly, blank)).toThrow()
    expect(() => assertCloudPixels(skyOnly, skyOnly, skyOnly)).toThrow()
  })

  // The React Three Fiber consumer example, booted on its own dev server on :5200
  //. Like examples/basic, it is served in dev mode in both CI and
  // local runs to smoke-test what a consumer actually runs
  for (const viewport of [
    { width: 800, height: 600 },
    { width: 390, height: 844 }
  ]) {
    test(`9. examples/r3f boots and renders without console errors (${viewport.width}x${viewport.height})`, async ({
      page
    }) => {
      const errors: string[] = []
      const externalRequests: string[] = []
      await page.route('**/*', async route => {
        if (new URL(route.request().url()).hostname === 'localhost') {
          await route.continue()
        } else {
          // Never record provider URLs: a local .env may contain credentials
          externalRequests.push(new URL(route.request().url()).hostname)
          await route.abort()
        }
      })
      page.on('console', m => {
        if (m.type() === 'error') errors.push(m.text())
      })
      page.on('pageerror', e => errors.push(String(e)))

      test.setTimeout(180_000)
      await page.setViewportSize(viewport)
      await page.goto(`${R3F_URL}/?e2e=1`)
      const title = await settledTitle(page, 60_000)
      expect(
        titleProblem(title, 60_000, R3F_URL),
        `title "${title}"`
      ).toBeNull()

      await page.waitForSelector('canvas', { timeout: 30_000 })

      const size = await page.evaluate(() => {
        const c = document.querySelector('canvas')
        return c == null ? null : { w: c.width, h: c.height }
      })
      expect(size, 'examples/r3f rendered no canvas').not.toBeNull()
      expect(size!.w, 'canvas has zero width').toBeGreaterThan(0)
      expect(size!.h, 'canvas has zero height').toBeGreaterThan(0)

      await page.waitForFunction(
        () => ((window as R3FSmokeWindow).__r3fSmoke?.frames ?? 0) > 0,
        undefined,
        { timeout: 45_000 }
      )
      const on = await settledFrame(page, true)
      const stable = await settledFrame(page, true)
      const off = await settledFrame(page, false)
      assertCloudPixels(on, stable, off)
      expect(externalRequests, 'smoke must use local assets only').toEqual([])
      expect(errors, 'examples/r3f logged console errors').toEqual([])
    })
  }
})

test.describe('Phase 4 — examples/r3f optional tiles view (credentialed)', () => {
  // Test 9 aborts every non-local request, so the provider-backed ?tiles=1
  // view needs this smoke: it runs only when examples/r3f/.env.local names
  // VITE_ION_TOKEN (never read), and records counts, no hostnames or URLs
  const envLocal = resolve(import.meta.dirname, '../../r3f/.env.local')
  const tokenNamed =
    process.env.VITE_ION_TOKEN != null ||
    (existsSync(envLocal) &&
      /^VITE_ION_TOKEN=\S/m.test(readFileSync(envLocal, 'utf8')))
  const redact = (text: string): string =>
    text
      .replace(/https?:\/\/\S+/g, '<url>')
      .replace(/[A-Za-z0-9_.-]{40,}/g, '<token>')

  test('9c. the ?tiles=1 view streams, settles and renders clouds over it', async ({
    page
  }) => {
    test.skip(
      !tokenNamed,
      'no VITE_ION_TOKEN in examples/r3f/.env.local: the credentialed tiles smoke is optional'
    )
    test.setTimeout(240_000)
    const errors: string[] = []
    let externalRequests = 0
    let failedRequests = 0
    page.on('request', request => {
      if (new URL(request.url()).hostname !== 'localhost') externalRequests++
    })
    page.on('requestfailed', () => {
      failedRequests++
    })
    page.on('console', m => {
      if (m.type() === 'error') errors.push(redact(m.text()))
    })
    page.on('pageerror', e => errors.push(redact(String(e))))

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`${R3F_URL}/?tiles=1&e2e=1`)
    const title = await settledTitle(page, 60_000)
    expect(titleProblem(title, 60_000, R3F_URL), `title "${title}"`).toBeNull()
    await page.waitForSelector('canvas', { timeout: 30_000 })
    await page.waitForFunction(
      () => ((window as R3FSmokeWindow).__r3fSmoke?.frames ?? 0) > 0,
      undefined,
      { timeout: 45_000 }
    )

    // Settled: the renderer's queues are empty and the counters stop moving
    // across three consecutive samples 30 frames apart
    const settled = await page.waitForFunction(
      () => {
        const window_ = window as R3FSmokeWindow & {
          __tilesSettle?: { last: string; streak: number }
        }
        const tiles = window_.__r3fSmoke?.tiles
        if (tiles == null) return false
        // The queues, not tiles-load-end: an aborted download can leave that
        // event unfired while the view is complete and still
        const quiet =
          tiles.queued + tiles.downloading + tiles.parsing === 0 &&
          tiles.visible > 0
        const key = JSON.stringify([
          tiles.visible,
          tiles.active,
          tiles.inCache,
          tiles.meshes
        ])
        const settle = (window_.__tilesSettle ??= { last: '', streak: 0 })
        if (quiet && key === settle.last && tiles.sampledAtFrame > 0) {
          settle.streak++
        } else {
          settle.streak = quiet ? 1 : 0
        }
        settle.last = key
        return settle.streak >= 3 ? tiles : false
      },
      undefined,
      { timeout: 150_000, polling: 500 }
    )
    const tiles = (await settled.jsonValue()) as NonNullable<
      NonNullable<R3FSmokeWindow['__r3fSmoke']>['tiles']
    >
    console.log(
      '[r3f tiles]',
      JSON.stringify({ ...tiles, externalRequests, failedRequests })
    )

    const on = await settledFrame(page, true)
    const stable = await settledFrame(page, true)
    const off = await settledFrame(page, false)
    assertCloudPixels(on, stable, off)

    expect(tiles.failed, 'tiles failed to load').toBe(0)
    expect(tiles.loadErrors, 'load-error events').toBe(0)
    expect(tiles.visible, 'no visible tiles').toBeGreaterThan(0)
    expect(tiles.meshes, 'no tile meshes in the group').toBeGreaterThan(0)
    expect(failedRequests, 'failed requests').toBe(0)
    expect(
      externalRequests,
      'the tiles view loads from the provider, so at least one external request'
    ).toBeGreaterThan(0)
    expect(errors, 'examples/r3f (tiles) logged console errors').toEqual([])
  })
})

test.describe('Phase 4 — examples/basic smoke', () => {
  // The consumer-facing example, booted as a consumer runs it (its own dev
  // server on :5199). A build-only smoke would pass while it rendered nothing,
  // the gap WEBGPU.md's snippet test exists to close
  test('10. examples/basic boots and renders without console errors', async ({
    page
  }) => {
    const errors: string[] = []
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', e => errors.push(String(e)))

    // PROVE WHICH APP ANSWERED before counting anything, since a
    // foreign server that draws a canvas and logs nothing passes every check
    // The title says WHICH example, not which TREE: that is the gate's job
    await page.goto(`${BASIC_URL}/`)
    const title = await page.title()
    expect(
      title,
      `${BASIC_URL} answered with "${title}" — that is not examples/basic. ` +
        `Something else is bound to this port; the smoke below would have ` +
        `graded it.`
    ).toContain('basic example')

    await page.waitForSelector('canvas', { timeout: 30_000 })

    // The canvas must acquire a WebGPU context and reach a non-zero size:
    // "the page loaded" is not "the example ran"
    const size = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      return c == null ? null : { w: c.width, h: c.height }
    })
    expect(size, 'examples/basic rendered no canvas').not.toBeNull()
    expect(size!.w, 'canvas has zero width').toBeGreaterThan(0)
    expect(size!.h, 'canvas has zero height').toBeGreaterThan(0)

    // Give the async init (renderer.init, baked texture loads) time to fail if
    // it is going to
    await page.waitForTimeout(4000)
    expect(errors, 'examples/basic logged console errors').toEqual([])

    // Read pixels, as test 9 does: a silent canvas can draw nothing (the
    // example once did). Decoded from a screenshot, since drawImage
    // of a WebGPU canvas can return black. Proves a lit, structured frame
    const png = await page.locator('canvas').screenshot()
    await test
      .info()
      .attach('basic-frame', { body: png, contentType: 'image/png' })
    const rgb = await page.evaluate(async encoded => {
      const image = new Image()
      image.src = 'data:image/png;base64,' + encoded
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 80
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0, 128, 80)
      return Array.from(ctx.getImageData(0, 0, 128, 80).data).filter(
        (_, i) => i % 4 !== 3
      )
    }, png.toString('base64'))
    const { mean, variance } = byteStats(rgb)
    console.log('[basic smoke]', { mean, variance })
    expect(mean, 'examples/basic drew a black frame').toBeGreaterThan(10)
    expect(mean, 'examples/basic drew a saturated frame').toBeLessThan(250)
    expect(
      variance,
      'examples/basic drew a uniform frame — the clear colour, not a scene'
    ).toBeGreaterThan(5)
  })
})

test.describe('Phase 4 — WebGL2 backend', () => {
  // The documented refusal (src/CloudsPassNode.ts:582, WEBGPU.md:373). Any other
  // error used to satisfy this test, so a WebGL2 boot failing for an unrelated
  // reason read as the documented contract
  const UNSUPPORTED_MESSAGE =
    'three-clouds-webgpu: the WebGL2 backend of WebGPURenderer is not yet ' +
    'verified. Use the native WebGPU backend, or see WEBGPU.md for the ' +
    'support matrix.'

  // Both routes into forceWebGL (main.ts:532): the case's own `backend` field,
  // and the ?backend=webgl2 URL override on an ordinary case
  const routes: Array<{
    label: string
    caseName: string
    extra: Record<string, string>
  }> = [
    { label: 'case 54', caseName: 'webgl2-backend', extra: {} },
    {
      label: '?backend=webgl2',
      caseName: 'baseline-medium',
      extra: { backend: 'webgl2' }
    }
  ]
  for (const entry of routes) {
    test(`8. ${entry.label}: side B refuses WebGL2 with the documented message, or renders like side A`, async ({
      page
    }) => {
      // The case carries `backend: 'webgl2'`, which had no consumer until
      // dc2355c: it booted the default WebGPU side and rendered the neutral
      // baseline, scoring a pass for a backend it never exercised
      await loadCase(page, entry.caseName, entry.extra)
      const status = await page.evaluate(() => {
        const p = (window as ParityWindow).__parity
        return {
          hasSideB: p.sideBHandle != null,
          urlBackend: p.params.backend,
          errors: p.errors ?? []
        }
      })
      expect(
        status.urlBackend === 'webgl2' ||
          caseByName(entry.caseName)?.backend === 'webgl2',
        'this route does not request the WebGL2 backend, so it tests nothing'
      ).toBe(true)
      if (!status.hasSideB) {
        expect(
          status.errors.some(e => e.includes(UNSUPPORTED_MESSAGE)),
          `side B is absent, so it must report the documented refusal; got: ` +
            status.errors.join(' | ')
        ).toBe(true)
        return
      }
      // A booting WebGL2 side B must render the case like the WebGL reference
      const a = await renderSideAndRead(page, 'A')
      const b = await renderSideAndRead(page, 'B')
      const ssim = computeSSIM(
        Float32Array.from(a.data),
        Float32Array.from(b.data),
        a.width,
        a.height
      )
      console.log(
        JSON.stringify({ webgl2Render: { route: entry.label, ssim } })
      )
      expect(
        ssim,
        'the WebGL2 backend booted but does not render like side A'
      ).toBeGreaterThanOrEqual(0.9)
    })
  }
})
