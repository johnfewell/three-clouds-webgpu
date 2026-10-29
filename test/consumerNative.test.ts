import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPhaseCadence } from '../examples/parity/scripts/consumer-native/cadence.mjs'
import {
  inspectDeviceDisposal,
  sampleStoppedFrames,
  waitForDeviceDisposal
} from '../examples/parity/scripts/consumer-native/disposal.mjs'
import { observeDevice } from '../examples/parity/scripts/consumer-native/observer.mjs'
import {
  assertContribution,
  assertVisible,
  comparePixels,
  LIMITS,
  type PixelImage
} from '../examples/parity/scripts/consumer-native/pixels.mjs'
import {
  assertDevelopmentReplay,
  assertHardware,
  hash,
  scenarios,
  verifyFiles,
  verifyPreparedRecipe,
  verifyReceipt,
  verifyRecipeNames,
  type Digest
} from '../examples/parity/scripts/consumer-native/proof.mjs'
import {
  createPhaseSampler,
  RECURRENCE_LIMITS
} from '../examples/parity/scripts/consumer-native/sampler.mjs'
import { staticServer } from '../examples/parity/scripts/consumer-native/servers.mjs'
import {
  createResponseRecorder,
  detectDevelopmentModules,
  type ObservedResponse
} from '../examples/parity/scripts/consumer-native/transport.mjs'
import {
  pinRecipeThree,
  selectThree
} from '../scripts/release/qualify-consumer.mjs'
import { log } from './helpers/log'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'clouds-native-test-'))
  roots.push(root)
  return root
}

function digest(root: string, contents: Record<string, string>): Digest {
  const files = Object.fromEntries(
    Object.entries(contents)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([name, content]) => {
        writeFileSync(join(root, name), content)
        return [
          name,
          { sha256: hash(content), bytes: Buffer.byteLength(content) }
        ]
      })
  )
  return { files, sha256: hash(JSON.stringify(files)) }
}

function pixels(offset = 0): PixelImage {
  const data = new Uint8Array(200 * 100 * 3)
  for (let index = 0; index < data.length; index++)
    data[index] = 30 + (index % 100) + offset
  return { width: 200, height: 100, channels: 3, data }
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

describe('conditional HTTP evidence', () => {
  const bytes = Buffer.from('console.log("exact installed module")')
  function setup() {
    const evidence = {
      responses: [] as Record<string, unknown>[],
      aborted: [] as string[],
      developmentModules: { react: false, reconciler: false }
    }
    const files = { 'entry.js': { sha256: hash(bytes), bytes: bytes.length } }
    const scenario = {
      development: false,
      build: { base: '/nested/', files: { files } }
    }
    return {
      evidence,
      record: createResponseRecorder(scenario, evidence)
    }
  }
  function response(
    status: number,
    options: {
      url?: string
      etag?: string | null
      conditional?: string
      body?: Promise<Buffer>
    } = {}
  ): ObservedResponse {
    const headers: Record<string, string> = {
      'content-type': 'text/javascript'
    }
    if (options.etag !== null) headers.etag = options.etag ?? 'W/"exact"'
    const requestHeaders = {
      'if-none-match': options.conditional ?? 'W/"exact"'
    }
    const request = { headers: () => requestHeaders }
    return {
      url: () => options.url ?? 'http://localhost/nested/entry.js',
      status: () => status,
      finished: () => Promise.resolve(null),
      body: vi.fn(async () => options.body ?? bytes),
      headers: () => headers,
      request: () => request
    }
  }

  it('links a 304 to completed, manifest-checked 200 bytes without inventing a body', async () => {
    const { record, evidence } = setup()
    let release!: (value: Buffer) => void
    const body = new Promise<Buffer>(resolve => {
      release = resolve
    })
    const initial = record(response(200, { body }))
    const cached = response(304)
    const revalidated = record(cached)
    await Promise.resolve()
    expect(evidence.responses).toEqual([])
    release(bytes)
    await Promise.all([initial, revalidated])
    expect(evidence.responses[0]).toMatchObject({
      status: 200,
      sha256: hash(bytes),
      bytes: bytes.length
    })
    expect(evidence.responses[1]).toEqual({
      url: 'http://localhost/nested/entry.js',
      status: 304,
      etag: 'W/"exact"',
      conditional: 'W/"exact"',
      revalidatedFrom: 0
    })
    expect(cached.body).not.toHaveBeenCalled()
    log('native revalidation evidence', { bodyReads: 1, revalidatedFrom: 0 })
  })

  it('accepts Vite-style headerless 304 only through the known request validator', async () => {
    const { record, evidence } = setup()
    await record(response(200))
    await record(response(304, { etag: null }))
    expect(evidence.responses[1]).toEqual({
      url: 'http://localhost/nested/entry.js',
      status: 304,
      etag: null,
      conditional: 'W/"exact"',
      revalidatedFrom: 0
    })
    await expect(
      record(response(304, { etag: null, conditional: 'W/"other"' }))
    ).rejects.toThrow('unproven HTTP 304')
    const missing = setup()
    await missing.record(response(200, { etag: null }))
    await expect(missing.record(response(304, { etag: null }))).rejects.toThrow(
      'unproven HTTP 304'
    )
  })

  it('rejects absent prior bytes, a different URL or changed/missing validators', async () => {
    const { record } = setup()
    await expect(record(response(304))).rejects.toThrow('unproven HTTP 304')
    await record(response(200))
    for (const options of [
      { url: 'http://localhost/nested/other.js' },
      { etag: 'W/"changed"' },
      { conditional: 'W/"changed"' },
      { conditional: '' },
      { etag: '' }
    ])
      await expect(record(response(304, options))).rejects.toThrow(
        'unproven HTTP 304'
      )
    log('native revalidation refusals', { negativeControls: 6 })
  })

  it('still rejects changed payloads and unsuccessful HTTP statuses', async () => {
    const { record, evidence } = setup()
    await expect(
      record(response(200, { body: Promise.resolve(Buffer.from('tampered')) }))
    ).rejects.toThrow('browser response differs from build')
    await expect(record(response(304))).rejects.toThrow('unproven HTTP 304')
    for (const status of [301, 404, 500])
      await expect(record(response(status))).rejects.toThrow(`HTTP ${status}`)
    expect(evidence.responses).toEqual([])
  })
})

describe('observed disposal completion', () => {
  function setup() {
    const events: Record<string, unknown>[] = [
      { type: 'device', id: 1, vendor: 'apple', fallback: false },
      { type: 'canvas', device: 1 }
    ]
    const bus = new EventEmitter()
    const subscribe = (listener: () => void) => {
      bus.on('event', listener)
      return () => {
        bus.off('event', listener)
      }
    }
    const emit = (event: Record<string, unknown>) => {
      events.push(event)
      bus.emit('event')
    }
    return { events, bus, subscribe, emit }
  }

  it('waits beyond the old sleep for both matching destroy and destroyed loss', async () => {
    vi.useFakeTimers()
    const { events, subscribe, bus, emit } = setup()
    const completion = waitForDeviceDisposal(subscribe, events, 10000)
    await vi.advanceTimersByTimeAsync(2500)
    expect(bus.listenerCount('event')).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    emit({ type: 'destroy', id: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(bus.listenerCount('event')).toBe(1)
    expect(inspectDeviceDisposal(events)).toBeNull()
    emit({ type: 'lost', id: 1, reason: 'destroyed' })
    await expect(completion).resolves.toMatchObject({
      deviceId: 1,
      destructionCount: 1,
      loss: { id: 1, reason: 'destroyed' }
    })
    expect(bus.listenerCount('event')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    log('native disposal completion', {
      elapsedBeforeDestroy: 2500,
      signals: 2
    })
  })

  it('recognizes completion already observed before waiting', async () => {
    const { events, subscribe, bus, emit } = setup()
    emit({ type: 'lost', id: 1, reason: 'destroyed' })
    emit({ type: 'destroy', id: 1 })
    await expect(
      waitForDeviceDisposal(subscribe, events)
    ).resolves.toMatchObject({
      deviceId: 1
    })
    expect(bus.listenerCount('event')).toBe(0)
  })

  it('times out missing completion and refuses foreign, duplicate or unexpected loss', async () => {
    vi.useFakeTimers()
    const { events, subscribe, bus, emit } = setup()
    const completion = waitForDeviceDisposal(subscribe, events, 20)
    const refusal = expect(completion).rejects.toThrow('timed out waiting')
    emit({ type: 'destroy', id: 1 })
    await vi.advanceTimersByTimeAsync(20)
    await refusal
    expect(bus.listenerCount('event')).toBe(0)
    for (const [event, expected] of [
      [{ type: 'destroy', id: 2 }, 'does not match'],
      [{ type: 'lost', id: 1, reason: 'unknown' }, 'unexpected device loss']
    ] as const) {
      const current = setup()
      const waiting = waitForDeviceDisposal(current.subscribe, current.events)
      current.emit(event)
      await expect(waiting).rejects.toThrow(expected)
      expect(current.bus.listenerCount('event')).toBe(0)
    }
    expect(() =>
      inspectDeviceDisposal([...events, { type: 'destroy', id: 1 }])
    ).toThrow('exactly one final device destruction')
  })

  function frameSample(expected = '7') {
    const status = { dataset: { frames: '7' } }
    const callbacks: (() => void)[] = []
    const cancelled = vi.fn()
    const promise = runInNewContext(
      `(${sampleStoppedFrames.toString()})(${JSON.stringify(expected)}, 100)`,
      {
        document: { querySelector: () => status },
        requestAnimationFrame: (callback: () => void) =>
          callbacks.push(callback),
        cancelAnimationFrame: cancelled,
        setTimeout,
        clearTimeout
      }
    ) as Promise<string[]>
    return { promise, status, callbacks, cancelled }
  }

  it('records unchanged raw counters across actual animation callbacks', async () => {
    const sample = frameSample()
    for (let frame = 0; frame < 3; frame++) sample.callbacks.shift()!()
    await expect(sample.promise).resolves.toEqual(['7', '7', '7'])
    expect(sample.callbacks).toEqual([])
    expect(sample.cancelled).toHaveBeenCalledOnce()
  })

  it('rejects continued frames, absent counters and missing animation opportunities', async () => {
    vi.useFakeTimers()
    const sample = frameSample()
    sample.callbacks.shift()!()
    sample.status.dataset.frames = '8'
    sample.callbacks.shift()!()
    await expect(sample.promise).rejects.toThrow('frames advanced')
    await expect(frameSample('').promise).rejects.toThrow(
      'missing rendered-frame'
    )
    const stalled = frameSample()
    const refusal = expect(stalled.promise).rejects.toThrow(
      'timed out observing'
    )
    await vi.advanceTimersByTimeAsync(100)
    await refusal
    expect(stalled.cancelled).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('installed native recipe provenance', () => {
  it('accepts exact nonempty bytes and refuses tampering, extras and absent input', () => {
    const root = fixture()
    const manifest = digest(root, { 'entry.js': 'actual module bytes' })
    expect(verifyFiles(root, manifest, true)).toBe(manifest.sha256)
    writeFileSync(join(root, 'entry.js'), 'changed module bytes')
    expect(() => verifyFiles(root, manifest)).toThrow('changed file')
    writeFileSync(join(root, 'entry.js'), 'actual module bytes')
    writeFileSync(join(root, 'extra.js'), 'extra')
    expect(() => verifyFiles(root, manifest, true)).toThrow('inventory changed')
    expect(() => verifyFiles(root, { files: {}, sha256: hash('') })).toThrow(
      'zero files'
    )
    expect(() =>
      verifyFiles(root, { ...manifest, sha256: hash('wrong') })
    ).toThrow('bad manifest')
    log('native artifact integrity', { verifiedFiles: 1, negativeControls: 4 })
  })

  it('refuses escaping paths and artifact symlinks', () => {
    const root = fixture()
    const child = join(root, 'child')
    mkdirSync(child)
    const manifest = digest(root, { 'entry.js': 'bytes' })
    const entry = manifest.files['entry.js']!
    expect(() =>
      verifyFiles(child, { sha256: '', files: { '../entry.js': entry } })
    ).toThrow('unsafe manifest path')
    symlinkSync(join(root, 'entry.js'), join(child, 'entry.js'))
    expect(() => verifyFiles(child, manifest, true)).toThrow('symlink')
    expect(() => verifyFiles(child, manifest)).toThrow('escapes artifact')
  })

  it('refuses failed, non-retained and old inventory-free receipts before browsing', () => {
    expect(() => verifyReceipt({ status: 'failed' })).toThrow('did not pass')
    expect(() =>
      verifyReceipt({ status: 'passed', qualification: 'native' })
    ).toThrow('CPU qualifier')
    expect(() =>
      verifyReceipt({ status: 'passed', qualification: 'cpu-only' })
    ).toThrow('not retained')
    expect(() =>
      verifyReceipt({
        status: 'passed',
        qualification: 'cpu-only',
        retained: true,
        three: selectThree('0.185.1')
      })
    ).toThrow('missing archive inventory')
    expect(() =>
      verifyReceipt({
        status: 'passed',
        qualification: 'cpu-only',
        retained: true
      })
    ).toThrow(
      'Consumer native: missing or invalid Three version metadata in CPU receipt'
    )
  })

  it.each(['0.185.1', '0.186.1'])(
    'accepts only the exact prepared Three pin for %s',
    version => {
      const archive = fixture()
      const sourceRoot = join(archive, 'recipes', 'vanilla')
      mkdirSync(sourceRoot, { recursive: true })
      const manifest = {
        dependencies: { three: '0.185.1' },
        devDependencies: { '@types/three': '0.185.0' }
      }
      const original = JSON.stringify(manifest, null, 2) + '\n'
      const sources = digest(sourceRoot, {
        'package.json': original,
        'entry.js': 'export const value = 1'
      })
      const three = selectThree(version)
      const root = fixture()
      const pinned =
        JSON.stringify(pinRecipeThree(manifest, three), null, 2) + '\n'
      const prepared = digest(root, {
        'package.json': pinned,
        'entry.js': 'export const value = 1'
      })
      const recipe = {
        name: 'vanilla',
        root,
        sources,
        prepared,
        installed: { root: archive }
      }
      expect(() => verifyPreparedRecipe(recipe, three)).not.toThrow()
      expect(() =>
        verifyPreparedRecipe({ ...recipe, prepared: undefined }, three)
      ).toThrow('missing prepared')
      writeFileSync(join(root, 'entry.js'), 'export const value = 2')
      expect(() => verifyPreparedRecipe(recipe, three)).toThrow('changed file')
      recipe.prepared = digest(root, {
        'package.json': pinned,
        'entry.js': 'export const value = 2'
      })
      expect(() => verifyPreparedRecipe(recipe, three)).toThrow(
        'beyond the allowed Three pin'
      )
      recipe.prepared = digest(root, {
        'package.json': JSON.stringify({ ...manifest, private: true }),
        'entry.js': 'export const value = 1'
      })
      expect(() => verifyPreparedRecipe(recipe, three)).toThrow(
        'beyond the allowed Three pin'
      )
    }
  )

  it('enumerates six production scenarios and a separate real development scenario', () => {
    const receipt = {
      recipes: ['vanilla', 'r3f'].map(name => ({
        name,
        builds: [{ base: '/' }, { base: '/nested/' }]
      }))
    }
    const cases = scenarios(receipt)
    expect(cases.map(item => item.id)).toEqual([
      'helper-root',
      'manual-root',
      'helper-nested',
      'manual-nested',
      'r3f-root',
      'r3f-nested',
      'r3f-development-strictmode'
    ])
    expect(cases.filter(item => item.development)).toHaveLength(1)
    expect(() => scenarios({ recipes: [receipt.recipes[1]] })).toThrow(
      'seven native scenarios'
    )
    // The WebGL fallback recipe rides along in the CPU receipt and adds no
    // hardware scenario: the same seven ids, in the same order
    const withFallback = {
      recipes: [
        ...receipt.recipes,
        {
          name: 'webgl-fallback',
          builds: [{ base: '/' }, { base: '/nested/' }]
        }
      ]
    }
    expect(scenarios(withFallback).map(item => item.id)).toEqual(
      cases.map(item => item.id)
    )
  })

  it('accepts the fallback recipe beside vanilla and r3f, and nothing else', () => {
    const named = (...names: string[]) => names.map(name => ({ name }))
    expect(verifyRecipeNames(named('vanilla', 'r3f'))).toEqual([
      'vanilla',
      'r3f'
    ])
    expect(
      verifyRecipeNames(named('r3f', 'vanilla', 'webgl-fallback'))
    ).toEqual(['r3f', 'vanilla', 'webgl-fallback'])
    expect(() => verifyRecipeNames(named('vanilla', 'r3f', 'ocean'))).toThrow(
      'expected the vanilla and r3f recipes'
    )
    expect(() => verifyRecipeNames(named('vanilla', 'webgl-fallback'))).toThrow(
      'expected the vanilla and r3f recipes'
    )
    expect(() => verifyRecipeNames(named('vanilla', 'r3f', 'r3f'))).toThrow(
      'duplicate recipe'
    )
    expect(() => verifyRecipeNames(undefined)).toThrow(
      'expected the vanilla and r3f recipes'
    )
  })

  it('serves only manifest bytes under the exact base, never an HTML asset fallback', async () => {
    const root = fixture()
    const files = digest(root, {
      'index.html': '<main>exact</main>',
      'entry.js': 'console.log(1)'
    })
    const server = await staticServer({ root, base: '/nested/', files })
    try {
      const document = await fetch(`${server.origin}/nested/`)
      expect(await document.text()).toBe('<main>exact</main>')
      expect(
        (await fetch(`${server.origin}/nested/entry.js`)).headers.get(
          'content-type'
        )
      ).toBe('text/javascript')
      for (const path of ['/', '/entry.js', '/nested/missing.bin'])
        expect((await fetch(`${server.origin}${path}`)).status).toBe(404)
      writeFileSync(join(root, 'entry.js'), 'tampered')
      expect((await fetch(`${server.origin}/nested/entry.js`)).status).toBe(500)
      expect(server.served).toHaveLength(2)
      expect(server.served[0]?.sha256).toBe(
        hash(readFileSync(join(root, 'index.html')))
      )
      log('native exact-base server', {
        served: server.served.length,
        refusedRequests: 4
      })
    } finally {
      await server.close()
    }
  })
})

describe('actual application GPU evidence', () => {
  const device = {
    type: 'device',
    id: 1,
    vendor: 'apple',
    architecture: 'apple-m3',
    fallback: false
  }
  const canvas = { type: 'canvas', device: 1 }
  it('requires exactly one identified hardware device configured on the canvas', () => {
    expect(assertHardware([device, canvas])).toBe(device)
    expect(() => assertHardware([])).toThrow('one observed')
    expect(() => assertHardware([device, device, canvas])).toThrow(
      'one observed'
    )
    expect(() => assertHardware([device])).toThrow('application canvas')
    expect(() =>
      assertHardware([{ type: 'device', id: 1, vendor: 'unknown' }, canvas])
    ).toThrow('unrecognized hardware')
    expect(() => assertHardware([{ type: 'device', id: 1 }, canvas])).toThrow(
      'identity is unavailable'
    )
    expect(() =>
      assertHardware([device, canvas, { type: 'gpu-error' }])
    ).toThrow('GPU error')
  })
  it.each(['SwiftShader', 'llvmpipe', 'lavapipe', 'software'])(
    'refuses %s even when the canvas uses it',
    description => {
      expect(() =>
        assertHardware([{ ...device, description }, canvas])
      ).toThrow('software/fallback')
    }
  )
  it('refuses a fallback adapter regardless of a hardware-looking identity', () => {
    expect(() =>
      assertHardware([{ ...device, fallback: true }, canvas])
    ).toThrow('software/fallback')
  })
})

describe('public observer semantics and development replay', () => {
  it('recognizes real development code without comments and rejects production bytes', () => {
    const require = createRequire(import.meta.url)
    const reactRoot = dirname(require.resolve('react/package.json'))
    const fiberRoot = dirname(
      require.resolve('@react-three/fiber/package.json')
    )
    const fiberFiles = readdirSync(join(fiberRoot, 'dist'))
    for (const mode of ['dev', 'prod']) {
      const react = readFileSync(
        join(
          reactRoot,
          'cjs',
          `react.${mode === 'dev' ? 'development' : 'production'}.js`
        ),
        'utf8'
      )
      const matches = fiberFiles.filter(
        name => name.startsWith('events-') && name.endsWith(`.cjs.${mode}.js`)
      )
      expect(matches).toHaveLength(1)
      const fiber = readFileSync(join(fiberRoot, 'dist', matches[0]!), 'utf8')
      for (const [source, expected] of [
        [react, { react: mode === 'dev', reconciler: false }],
        [fiber, { react: false, reconciler: mode === 'dev' }]
      ] as const) {
        const file = ts.createSourceFile(
          'module.js',
          source,
          ts.ScriptTarget.Latest,
          true
        )
        const stripped = ts
          .createPrinter({ removeComments: true })
          .printFile(file)
        expect(detectDevelopmentModules(source)).toEqual(expected)
        expect(detectDevelopmentModules(stripped)).toEqual(expected)
      }
    }
    log('native development bytes', {
      realModules: 4,
      commentStrippedControls: 4
    })
  })

  it('refuses filename/comment markers and incomplete development code evidence', () => {
    const diagnostic =
      'console.error("Expected to find a StrictMode component in a strict mode tree.")'
    const metadata =
      'const metadata = { bundleType: 1, reconcilerVersion: "19.2.0" }'
    const react =
      'console.error("You called act(async () => ...) without await.")'
    const filename =
      'console.log("react.development.js react-reconciler.development.js")'
    for (const source of [
      filename,
      `/* ${react}; ${diagnostic}; ${metadata} */`,
      `// ${react}; ${diagnostic}; ${metadata}`,
      diagnostic,
      metadata,
      `${diagnostic}; ${metadata.replace('bundleType: 1', 'bundleType: 0')}`
    ])
      expect(detectDevelopmentModules(source)).toEqual({
        react: false,
        reconciler: false
      })
    log('native development negative controls', { refused: 6 })
  })

  it('requires both volume loads to cancel then restart before user remount', () => {
    const assets = [
      'local_weather.png',
      'shape.bin',
      'shape_detail.bin',
      'turbulence.png'
    ].map(name => ({
      exportPath: `three-clouds-webgpu/assets/${name}`,
      sha256: hash(name),
      bytes: name.length
    }))
    const responses = assets.map(asset => ({
      ...asset,
      url: `http://localhost/${asset.exportPath}`
    }))
    const events = responses.flatMap((response, index) => [
      { type: 'fetch-start', id: index * 2, url: response.url },
      { type: 'fetch-abort', id: index * 2, url: response.url },
      { type: 'fetch-start', id: index * 2 + 1, url: response.url },
      { type: 'fetch-settled', id: index * 2 + 1, url: response.url, ok: true }
    ])
    expect(assertDevelopmentReplay(events, responses, assets)).toHaveLength(2)
    expect(() => assertDevelopmentReplay([], responses, assets)).toThrow(
      'no pre-remount'
    )
    expect(() =>
      assertDevelopmentReplay(
        events.filter(event => event.type !== 'fetch-abort'),
        responses,
        assets
      )
    ).toThrow('no pre-remount')
    expect(() => assertDevelopmentReplay(events, [], assets)).toThrow(
      'no pre-remount'
    )
    expect(() => assertDevelopmentReplay(events, responses, [])).toThrow(
      'incomplete'
    )
    const reordered = [
      ...events.slice(0, 4),
      events[4]!,
      events[6]!,
      events[5]!,
      ...events.slice(7)
    ]
    expect(() => assertDevelopmentReplay(reordered, responses, assets)).toThrow(
      'before cleanup'
    )
  })

  it('preserves public GPU and fetch arguments, receivers, return values and promises', async () => {
    const emitted: string[] = []
    const calls: unknown[][] = []
    class Device extends EventTarget {
      lost = new Promise(() => {})
      destroy(...args: unknown[]): string {
        calls.push([this, ...args])
        return 'destroyed'
      }
    }
    const device = new Device()
    const devicePromise = Promise.resolve(device)
    class Adapter {
      info = { vendor: 'apple', architecture: 'apple-m3' }
      isFallbackAdapter = false
      requestDevice(...args: unknown[]): Promise<Device> {
        calls.push([this, ...args])
        return devicePromise
      }
    }
    class Canvas {
      canvas = { width: 200, height: 100 }
      configure(configuration: unknown): string {
        calls.push([this, configuration])
        return 'configured'
      }
    }
    const response = Promise.resolve(new Response('bytes'))
    const sandbox = {
      console: { info: (message: string) => emitted.push(message) },
      GPUAdapter: Adapter,
      GPUDevice: Device,
      GPUCanvasContext: Canvas,
      Request,
      URL,
      location: { href: 'http://localhost/' },
      fetch(this: unknown, ...args: unknown[]) {
        calls.push([this, ...args])
        return response
      }
    }
    const properties = Object.keys(sandbox)
    runInNewContext(`(${observeDevice.toString()})('event ')`, sandbox)
    const adapter = new Adapter()
    const descriptor = { label: 'actual request' }
    expect(adapter.requestDevice(descriptor)).toBe(devicePromise)
    await devicePromise
    const canvas = new Canvas()
    const configuration = { device }
    expect(canvas.configure(configuration)).toBe('configured')
    const controller = new AbortController()
    const options = { signal: controller.signal }
    expect(sandbox.fetch('payload.bin', options)).toBe(response)
    controller.abort()
    await response
    expect(device.destroy('original argument')).toBe('destroyed')
    expect(calls).toEqual([
      [adapter, descriptor],
      [canvas, configuration],
      [sandbox, 'payload.bin', options],
      [device, 'original argument']
    ])
    expect(Object.keys(sandbox)).toEqual(properties)
    expect(emitted.some(event => event.includes('"type":"device"'))).toBe(true)
    expect(
      emitted.some(event => event.includes('"type":"canvas","device":1'))
    ).toBe(true)
    expect(emitted.some(event => event.includes('"type":"fetch-abort"'))).toBe(
      true
    )
    log('public transparent observer', {
      forwardedCalls: calls.length,
      observations: emitted.length,
      addedGlobals: 0
    })
  })
})

describe('nonvacuous masked cloud contribution', () => {
  it('requires real nonflat pixels, on/off contribution, and restoration', () => {
    const metrics = assertContribution(pixels(), pixels(), pixels(20), pixels())
    expect(metrics.contribution.meanDifference).toBeGreaterThan(0.07)
    expect(metrics.noise.meanDifference).toBe(0)
    expect(metrics.restoration.meanDifference).toBe(0)
    log('native contribution', metrics)
  })
  it('does not count HUD-only changes as cloud evidence', () => {
    const on = pixels()
    on.mask = { x: 0, y: 0, width: 30, height: 30 }
    const off = { ...on, data: on.data.slice() }
    for (let vertical = 0; vertical < 30; vertical++)
      for (let horizontal = 0; horizontal < 30; horizontal++)
        off.data.fill(
          255,
          (vertical * 200 + horizontal) * 3,
          (vertical * 200 + horizontal) * 3 + 3
        )
    expect(comparePixels(on, off).meanDifference).toBe(0)
    expect(() => assertContribution(on, on, off, on)).toThrow(
      'no cloud contribution'
    )
  })
  it('refuses zero, flat, too small, nonfinite and unequal images', () => {
    const blank = pixels()
    blank.data.fill(0)
    expect(() => assertVisible(blank)).toThrow('blank')
    blank.data.fill(100)
    expect(() => assertVisible(blank)).toThrow('flat')
    expect(() => comparePixels({ ...pixels(), width: 0 })).toThrow('too few')
    expect(() =>
      comparePixels({ ...pixels(), data: new Uint8Array() })
    ).toThrow('non-finite')
    expect(() => comparePixels(pixels(), { ...pixels(), width: 199 })).toThrow(
      'unequal'
    )
  })
  it('takes a caller limit for a noisier baseline and keeps the noise margin', () => {
    const limits = { ...LIMITS, stableMean: 0.05, restoreMean: 0.05 }
    expect(() =>
      assertContribution(pixels(), pixels(1), pixels(40), pixels(1))
    ).toThrow('unstable')
    const metrics = assertContribution(
      pixels(),
      pixels(1),
      pixels(40),
      pixels(1),
      limits
    )
    expect(metrics.noise.meanDifference).toBeCloseTo(1 / 255, 5)
    // contribution must still clear five times the measured noise
    expect(() =>
      assertContribution(pixels(), pixels(4), pixels(10), pixels(), limits)
    ).toThrow('no cloud contribution')
    log('native contribution with caller limits', metrics)
  })
  it('refuses noisy baselines and failed restorations', () => {
    expect(() =>
      assertContribution(pixels(), pixels(10), pixels(20), pixels())
    ).toThrow('unstable')
    expect(() =>
      assertContribution(pixels(), pixels(), pixels(20), pixels(10))
    ).toThrow('restoration')
    expect(() =>
      assertContribution(pixels(), pixels(), pixels(), pixels())
    ).toThrow('no cloud contribution')
  })
})

describe('fixed-anchor temporal phase recurrence', () => {
  const sample = (
    image: PixelImage,
    index: number,
    before = index * 80,
    after = before + 2
  ) => ({ image, name: `capture-${index}`, before, after })

  it('accepts a stationary raw-pixel phase orbit without accepting adjacent differences', () => {
    const sampler = createPhaseSampler()
    const results = []
    for (let index = 0; index <= 12; index++)
      results.push(
        sampler.push(sample(pixels((index % 4) * 10), index, index * 20))
      )
    const result = results.at(-1)!
    expect(result.ready).toBe(true)
    expect(result.anchor?.index).toBe(0)
    expect(result.recurrences.map(item => item.index)).toEqual([4, 8, 12])
    expect(
      result.recurrences.every(
        item => item.gap >= 64 && item.difference.meanDifference === 0
      )
    ).toBe(true)
    expect(result.adjacent?.meanDifference).toBeGreaterThan(0.001)
    expect(results.slice(0, -1).every(item => !item.ready)).toBe(true)
    expect(() => sampler.push(sample(pixels(), 13))).toThrow(
      'already completed'
    )
    log('fixed temporal orbit', {
      phaseMatches: result.recurrences.length,
      rawRecurrenceMAE: result.recurrences[0]?.difference.meanDifference,
      adjacentMAE: result.adjacent?.meanDifference,
      minimumGap: RECURRENCE_LIMITS.minimumFrameGap
    })
  })

  it('uses conservative before/after frame gaps rather than screenshot indices', () => {
    const sampler = createPhaseSampler()
    sampler.push(sample(pixels(), 0, 0, 10))
    const tooSoon = sampler.push(sample(pixels(), 1, 73, 74))
    expect(tooSoon.anchor).toBeNull()
    const sufficient = sampler.push(sample(pixels(), 2, 74, 80))
    expect(sufficient.recurrences[0]?.gap).toBe(64)
    expect(sufficient.ready).toBe(false)
    expect(() => sampler.push(sample(pixels(), 3, 79, 81))).toThrow(
      'moved backwards'
    )
    expect(() => createPhaseSampler().push(sample(pixels(), 0, NaN))).toThrow(
      'invalid public frame bracket'
    )
    expect(() => createPhaseSampler().push(sample(pixels(), 0, 5, 4))).toThrow(
      'invalid public frame bracket'
    )
  })

  it('never promotes a moving anchor to hide slow drift', () => {
    const sampler = createPhaseSampler()
    const results = []
    for (let index = 0; index < 8; index++) {
      const image = pixels()
      for (let channel = 0; channel < image.data.length / 5; channel++)
        image.data[channel]! += index
      results.push(sampler.push(sample(image, index)))
    }
    expect(
      results.slice(1).every(result => result.adjacent!.meanDifference < 0.001)
    ).toBe(true)
    expect(results.every(result => !result.ready)).toBe(true)
    expect(results.at(-1)?.anchor?.index).toBe(0)
    expect(results.at(-1)?.recurrences.map(item => item.index)).toEqual([1])
  })

  it('bounds history and discards all old hits when a stale anchor expires', () => {
    const sampler = createPhaseSampler()
    sampler.push(sample(pixels(), 0))
    sampler.push(sample(pixels(), 1))
    let result
    for (let index = 2; index <= 66; index++)
      result = sampler.push(sample(pixels(10), index))
    expect(result?.expired).toBe(true)
    expect(result?.ready).toBe(false)
    expect(result?.historySize).toBe(64)
    expect(result?.anchor?.index).toBeGreaterThan(1)
    expect(result?.recurrences.map(item => item.index)).toEqual([66])
  })

  it('requires visibility and the unchanged fixed target tolerance', () => {
    const blank = pixels()
    blank.data.fill(0)
    const blankSampler = createPhaseSampler()
    const mismatch = createPhaseSampler({
      reference: pixels(20),
      referenceLimit: 0.002
    })
    const matching = createPhaseSampler({
      reference: pixels(),
      referenceLimit: 0.001
    })
    for (let index = 0; index < 4; index++) {
      expect(blankSampler.push(sample(blank, index)).ready).toBe(false)
      expect(mismatch.push(sample(pixels(), index)).ready).toBe(false)
      const result = matching.push(sample(pixels(), index))
      expect(result.ready).toBe(index === 3)
      expect(result.referenceDifference?.meanDifference).toBe(0)
    }
    expect(() => createPhaseSampler({ referenceLimit: 0.01 })).toThrow(
      'unsupported phase reference tolerance'
    )
  })
})

describe('public-frame phase-guided capture cadence', () => {
  it('keeps discovery captures while reserving an aligned phase opportunity', () => {
    const cadence = createPhaseCadence()
    const hint = { before: 867 }
    const first = cadence.plan({ currentFrame: 0, iteration: 0, hint })
    expect(first).toMatchObject({
      mode: 'explore',
      waitUntil: 12,
      targetBefore: 35
    })
    cadence.observe(first, { before: 12, after: 15 })
    const second = cadence.plan({ currentFrame: 15, iteration: 1, hint })
    expect(second).toMatchObject({
      mode: 'explore',
      waitUntil: 28,
      targetBefore: 35
    })
    cadence.observe(second, { before: 28, after: 31 })
    const aligned = cadence.plan({ currentFrame: 31, iteration: 2, hint })
    expect(aligned).toMatchObject({
      mode: 'phase',
      waitUntil: 35,
      targetBefore: 35
    })
    const observed = cadence.observe(aligned, { before: 36, after: 39 })
    expect(observed.observedBefore).not.toBe(observed.requested.targetBefore)
    expect(observed.nextOverhead).toBe(1)
    expect(observed).not.toHaveProperty('ready')
    const next = cadence.plan({
      currentFrame: 150,
      iteration: 3,
      hint,
      lastMatch: { after: 39 }
    })
    expect(next).toMatchObject({
      mode: 'phase',
      waitUntil: 162,
      targetBefore: 163,
      overhead: 1
    })
    expect(next.targetBefore! % 64).toBe(hint.before % 64)
    expect(next.targetBefore! - 39).toBeGreaterThanOrEqual(64)
    log('phase-guided cadence', {
      firstTarget: aligned.targetBefore,
      observedBefore: observed.observedBefore,
      nextWait: next.waitUntil,
      nextTarget: next.targetBefore,
      grantsAcceptance: false
    })
  })

  it('uses only the reference phase, not a previous timeline absolute deadline', () => {
    const cadence = createPhaseCadence()
    const plan = cadence.plan({
      currentFrame: 1,
      iteration: 0,
      hint: { before: 64035 }
    })
    expect(plan.targetBefore).toBe(35)
    const late = cadence.plan({
      currentFrame: 10000,
      iteration: 0,
      hint: { before: 35 }
    })
    expect(late.targetBefore).toBeGreaterThan(10000)
    expect(late.targetBefore! % 64).toBe(35)
  })

  it('respects wide observed brackets and never counts guidance as a pixel match', () => {
    const cadence = createPhaseCadence()
    const guided = cadence.plan({
      currentFrame: 32,
      iteration: 0,
      hint: { before: 35 }
    })
    cadence.observe(guided, { before: 35, after: 100 })
    const next = cadence.plan({
      currentFrame: 101,
      iteration: 1,
      hint: { before: 35 },
      lastMatch: { after: 120 }
    })
    expect(next.targetBefore! % 64).toBe(35)
    expect(next.targetBefore! - 120).toBeGreaterThanOrEqual(64)
    expect(next.targetBefore! - 100).toBeGreaterThanOrEqual(64)
    expect(next).not.toHaveProperty('ready')
    expect(() =>
      cadence.observe(next, {
        before: next.waitUntil - 1,
        after: next.waitUntil
      })
    ).toThrow('invalid observed cadence bracket')
  })

  it('keeps the unguided12/13 cadence and refuses invalid counters', () => {
    const cadence = createPhaseCadence()
    expect(cadence.plan({ currentFrame: 10, iteration: 0 }).waitUntil).toBe(22)
    expect(cadence.plan({ currentFrame: 10, iteration: 1 }).waitUntil).toBe(23)
    expect(() => cadence.plan({ currentFrame: NaN, iteration: 0 })).toThrow(
      'invalid cadence frame'
    )
    expect(() =>
      cadence.plan({ currentFrame: 0, iteration: 0, hint: { before: -1 } })
    ).toThrow('invalid phase hint')
  })
})
