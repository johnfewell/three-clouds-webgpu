// prove.mjs with the replay half swapped for core/src/runtime: every uniform
// comes from the CPU state (setup.json), compared with the three oracle
// Usage, under the GPU lock, after pnpm build and emit-runtime.mjs:
//   node core/scripts/prove-runtime.mjs --out <dir> [--port 5296] [--frames 10]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    port: { type: 'string', default: '5296' },
    generated: { type: 'string' },
    // build the runtime from this description, then resize it to the case
    'resize-from': { type: 'string' },
    frames: { type: 'string', default: '10' },
    case: { type: 'string', default: 'baseline-medium' },
    // replay against the oracle a previous run left in <out>/oracle
    'reuse-oracle': { type: 'boolean', default: false },
    // break the compared run on purpose: 'sun' or 'frame', which must fail
    fault: { type: 'string' }
  }
})
if (values.out == null) throw new Error('--out <dir> is required')
const out = resolve(values.out)
const generated = resolve(values.generated ?? join(repo, 'core/generated'))
const frames = Number(values.frames)
// the description's linear readback follows a frames[1] frame, so the last
// frame index must be odd
if (frames % 2 !== 0) throw new Error('--frames must be even')
const port = Number(values.port)
const origin = `http://localhost:${port}`
mkdirSync(join(out, 'oracle'), { recursive: true })

const kill = setTimeout(
  () => {
    console.error('HARD TIMEOUT')
    process.exit(3)
  },
  12 * 60 * 1000
)
const require = createRequire(join(repo, 'examples/parity/package.json'))
const { chromium } = require('@playwright/test')
const server = await createServer({
  root: join(repo, 'examples/parity'),
  configFile: join(repo, 'examples/parity/vite.config.ts'),
  logLevel: 'error',
  server: { port, strictPort: true }
})
await server.listen()
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})
const log = []
try {
  const description = JSON.parse(
    readFileSync(join(generated, 'description.json'), 'utf8')
  )
  const oracle = values['reuse-oracle']
    ? {
        trace: JSON.parse(readFileSync(join(out, 'oracle/trace.json'), 'utf8')),
        blobs: readFileSync(join(out, 'oracle/blobs.bin'))
      }
    : await recordOracle()
  const compare = alignOracle(description, oracle)
  const report = await replay(compare)
  report.alignment = compare.map(({ name, oracleId }) => ({ name, oracleId }))
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1))
  const rows = Object.entries(report.results).map(([name, r]) => ({
    name,
    ...r
  }))
  console.table(rows)
  console.log('controls', report.controls)
  console.log('errors', report.errors)
} finally {
  writeFileSync(join(out, 'console.log'), log.join('\n') + '\n')
  await browser.close()
  await server.close()
  clearTimeout(kill)
}

// The spike's protocol: build once, then reset and render `frames` frames,
// then the linear readback
async function recordOracle() {
  const hook = readFileSync(join(repo, 'core/emit/replay/gpuhook.js'), 'utf8')
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('console', m => log.push(`[oracle ${m.type()}] ${m.text()}`))
  page.on('pageerror', e => log.push(`[oracle pageerror] ${e.message}`))
  await page.addInitScript(hook)
  await page.goto(`${origin}/?case=${values.case}&e2e=1`)
  await page.waitForFunction(() => window.__parity != null, null, {
    timeout: 120000
  })
  const meta = await page.evaluate(async warmup => {
    const p = window.__parity
    const T = window.__gpuTrace
    const mark = l => T.ops.push({ op: 'mark', label: l })
    mark('build')
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 64 })
    await p.readLinear('B')
    mark('renderOnce-1')
    await p.renderOnce('B', { time: 0, frame: 0, warmup, resetHistory: true })
    mark('readLinear-2')
    await p.readLinear('B')
    mark('end')
    return T.finish()
  }, frames - 1)
  const json = await page.evaluate(m => window.__gpuTrace.serialise(m), meta)
  const size = await page.evaluate(() => window.__gpuTrace.blobSize())
  const chunks = []
  const CHUNK = 8 << 20
  for (let s = 0; s < size; s += CHUNK)
    chunks.push(
      Buffer.from(
        await page.evaluate(
          ([a, b]) => window.__gpuTrace.blobChunk(a, b),
          [s, CHUNK]
        ),
        'base64'
      )
    )
  await page.close()
  const trace = JSON.parse(json)
  writeFileSync(join(out, 'oracle/trace.json'), json)
  const blobs = Buffer.concat(chunks)
  writeFileSync(join(out, 'oracle/blobs.bin'), blobs)
  console.log(
    `oracle: ${trace.ops.length} ops, ${trace.errors.length} errors, ${blobs.length} blob bytes`
  )
  return { trace, blobs }
}

// Oracle passes in QUEUE order, each with its pipeline label, attachments
// and bound textures. three begins the canvas pass before the frame's
// pre-passes, so the order passes are begun in is not the order they run
function oraclePasses(trace) {
  const by = new Map()
  for (const o of trace.ops) if (o.ret != null) by.set(o.ret, o)
  const viewTexture = r => {
    const o = by.get(r?.$r)
    return o?.op === 'GPUTexture.createView' ? o.self : null
  }
  const byEncoder = new Map()
  const open = new Map()
  const encoderOf = new Map()
  const submitted = []
  let started = false
  for (const o of trace.ops) {
    if (o.op === 'mark' && o.label === 'renderOnce-1') started = true
    if (!started) continue
    if (o.op === 'GPUCommandEncoder.beginRenderPass') {
      const d = o.args[0]
      const p = {
        color: d.colorAttachments.map(c => (c ? viewTexture(c.view) : null)),
        depth: d.depthStencilAttachment
          ? viewTexture(d.depthStencilAttachment.view)
          : null,
        pipeline: null,
        groups: {}
      }
      open.set(o.ret, p)
      if (!byEncoder.has(o.self)) byEncoder.set(o.self, [])
      byEncoder.get(o.self).push(p)
    } else if (o.op === 'GPURenderPassEncoder.setPipeline') {
      open.get(o.self).pipeline = by.get(o.args[0].$r).args[0].label
    } else if (o.op === 'GPURenderPassEncoder.setBindGroup') {
      const entries = by.get(o.args[1].$r).args[0].entries
      open.get(o.self).groups[o.args[0]] = Object.fromEntries(
        entries.map(e => [e.binding, viewTexture(e.resource)])
      )
    } else if (o.op === 'GPUCommandEncoder.finish') {
      encoderOf.set(o.ret, o.self)
    } else if (o.op === 'GPUQueue.submit') {
      for (const cb of o.args[0])
        submitted.push(...(byEncoder.get(encoderOf.get(cb.$r)) ?? []))
    }
  }
  return submitted
}

// Our passes for frames[1] and the linear readback, the same shape
function describedPasses(description) {
  const passes = []
  const steps = [
    ...description.schedule.frames[1],
    ...description.schedule.linear
  ]
  for (const s of steps) {
    if (s.kind !== 'submit') continue
    let p = null
    for (const c of s.commands) {
      if (c.cmd === 'beginRenderPass') {
        p = {
          color: c.colorAttachments.map(a => a?.texture ?? null),
          depth: c.depthStencilAttachment?.texture ?? null,
          pipeline: null,
          groups: {}
        }
        passes.push(p)
      } else if (c.cmd === 'setPipeline') p.pipeline = c.pipeline
      else if (c.cmd === 'setBindGroup') {
        const g = description.bindGroups[c.bindGroup]
        p.groups[c.index] = Object.fromEntries(
          g.entries.map(e => [e.binding, e.texture ?? null])
        )
      }
    }
  }
  return passes
}

// Line the oracle's last frame and final linear pass up with ours, by
// position, and check each pair runs the same pipeline before trusting it
function alignOracle(description, { trace, blobs }) {
  const ours = describedPasses(description)
  const theirs = oraclePasses(trace)
  // the oracle ends: last frame, a convergence linear read, the linear read
  const tail = [
    ...theirs.slice(-(ours.length + 1), -2),
    theirs[theirs.length - 1]
  ]
  if (tail.length !== ours.length)
    throw new Error(`oracle has ${theirs.length} passes, too few`)
  const map = new Map()
  const pair = (name, id, where) => {
    if (name == null || id == null) return
    const known = map.get(name)
    if (known != null && known !== id)
      throw new Error(`${name} is oracle t${known} and t${id} (${where})`)
    map.set(name, id)
  }
  ours.forEach((p, i) => {
    const t = tail[i]
    const base = String(t.pipeline ?? '')
      .replace(/^renderPipeline_/, '')
      .replace(/_\d+$/, '')
    if (p.pipeline.replace(/\.\d+$/, '') !== base)
      throw new Error(`pass ${i}: ours ${p.pipeline}, oracle ${t.pipeline}`)
    p.color.forEach((n, j) => pair(n, t.color[j], `pass ${i} color ${j}`))
    pair(p.depth, t.depth, `pass ${i} depth`)
    for (const [g, entries] of Object.entries(p.groups))
      for (const [b, n] of Object.entries(entries))
        pair(n, t.groups[g]?.[b], `pass ${i} group ${g} binding ${b}`)
  })
  const compare = []
  for (const [name, id] of map) {
    const s = trace.snaps[id]
    if (s == null || s.$b == null) continue
    const [o, n] = trace.index[s.$b]
    const file = `${name}.bin`
    writeFileSync(join(out, 'oracle', file), blobs.subarray(o, o + n))
    const { $b: _b, ...meta } = s
    compare.push({ name, oracleId: id, file, meta })
  }
  console.log(`aligned ${ours.length} passes, ${compare.length} textures`)
  if (compare.length === 0) throw new Error('nothing to compare')
  return compare
}

async function replay(compare) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('console', m => log.push(`[runtime ${m.type()}] ${m.text()}`))
  page.on('pageerror', e => log.push(`[runtime pageerror] ${e.message}`))
  const files = {
    generated,
    resizeFrom: values['resize-from'] ?? generated,
    assets: join(repo, 'examples/parity/public/assets'),
    oracle: join(out, 'oracle')
  }
  await page.route(`${origin}/__replay/**`, route => {
    const path = new URL(route.request().url()).pathname.replace(
      /^\/__replay\//,
      ''
    )
    if (path === 'index.html')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><script type="module" src="page.js"></script>'
      })
    const [head, ...rest] = path.split('/')
    const own = join(repo, 'core/scripts/runtime-proof', path)
    const file =
      files[head] != null
        ? join(files[head], ...rest)
        : existsSync(own)
          ? own
          : join(repo, 'core/emit/replay', path)
    const type = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.json')
        ? 'application/json'
        : file.endsWith('.png')
          ? 'image/png'
          : 'application/octet-stream'
    return route.fulfill({ contentType: type, body: readFileSync(file) })
  })
  await page.goto(`${origin}/__replay/index.html`)
  await page.waitForFunction(() => window.__runtimeReady === true)
  // the oracle's renderOnce: warm-up frames-1 then the final frame, with the
  // frame index from the harness's own plan
  const { warmupFramePlan } = await server.ssrLoadModule(
    join(repo, 'examples/parity/src/warmupFrames.ts')
  )
  const setup = JSON.parse(readFileSync(join(generated, 'setup.json'), 'utf8'))
  const plan = warmupFramePlan(
    0,
    frames - 1,
    setup.inputs.temporalUpscale === true
  )
  const report = await page.evaluate(args => window.__runtimeProve(args), {
    base: `${origin}/__replay`,
    // vite serves the TypeScript runtime from source
    runtimeUrl: `${origin}/@fs${join(repo, 'core/src/runtime/index.ts')}`,
    plan,
    compare,
    resizeFrom: values['resize-from'] != null,
    fault: values.fault ?? null
  })
  await page.close()
  return report
}
