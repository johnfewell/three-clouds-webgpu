// Emit a case for the runtime: the description and state (as emit.mjs) plus
// setup.json, the case's knobs as plain data for a three-free RuntimeSession
// Usage: node core/scripts/emit-runtime.mjs [--case baseline-medium] [--out dir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({
  options: {
    case: { type: 'string', default: 'baseline-medium' },
    out: { type: 'string', default: join(repo, 'core/generated') }
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
try {
  const { emitDescription } = await server.ssrLoadModule(
    join(repo, 'core/emit/emit.ts')
  )
  const { caseSetup } = await server.ssrLoadModule(
    join(repo, 'core/emit/caseSetup.ts')
  )
  const { description, state, sideB } = await emitDescription({
    caseName: values.case
  })
  mkdirSync(values.out, { recursive: true })
  const write = (name, value) =>
    writeFileSync(join(values.out, name), JSON.stringify(value, null, 1))
  write('description.json', description)
  write('state.json', state)
  write('setup.json', caseSetup(sideB))
  console.log(
    `${values.case}: ${Object.keys(description.pipelines).length} pipelines, ` +
      `${description.schedule.frames.map(f => f.length).join('/')} frame steps -> ${values.out}`
  )
} finally {
  await server.close()
}
