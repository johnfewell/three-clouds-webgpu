// Emit the graph description on a fake WebGPU device, no GPU needed
// Usage: node core/scripts/emit.mjs [--case baseline-medium] [--out dir]
//        [--allow-anonymous]
// Writes description.json and state.json, see core/DESCRIPTION.md
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({
  options: {
    case: { type: 'string', default: 'baseline-medium' },
    out: { type: 'string', default: join(repo, 'core/generated') },
    'allow-anonymous': { type: 'boolean', default: false }
  }
})

const server = await createServer({
  root: join(repo, 'examples/parity'),
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  // TSL is the source: compile the library from src/, never a stale build/
  resolve: {
    alias: { 'three-clouds-webgpu': join(repo, 'src/index.ts') }
  },
  appType: 'custom'
})
// Creation sites of unnamed uniforms, mapped back to the TS source lines
globalThis.__emitFixStack = error => server.ssrFixStacktrace(error)
try {
  const { emitDescription } = await server.ssrLoadModule(
    join(repo, 'core/emit/emit.ts')
  )
  const { description, state, naming } = await emitDescription({
    caseName: values.case,
    allowAnonymous: values['allow-anonymous']
  })
  mkdirSync(values.out, { recursive: true })
  const write = (name, value) =>
    writeFileSync(join(values.out, name), JSON.stringify(value, null, 1))
  write('description.json', description)
  write('state.json', state)
  write('naming.json', naming)
  const count = k => Object.keys(description[k]).length
  console.log(
    `${values.case}: ${count('pipelines')} pipelines, ${count('modules')} modules, ` +
      `${count('buffers')} buffers, ${count('textures')} textures, ` +
      `${description.schedule.frames.map(f => f.length).join('/')} frame steps, ` +
      `${naming.anonymous.length} unnamed, ${naming.assigned.length} named by the emitter -> ${values.out}`
  )
} finally {
  await server.close()
}
