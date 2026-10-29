// The Phase A exit test: the core runtime, every uniform from the CPU state,
// against the three package byte for byte. Exits 1 on any mismatch, dead
// control or missing case. Usage and phases: core/EXIT-TEST.md
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { ensureFreshBuild } from '../../examples/parity/scripts/freshBuild.mjs'
import {
  caseVerdict,
  EXIT_CASES,
  EXIT_FAULTS,
  faultVerdict,
  formatTable,
  runVerdict
} from './exitVerdict.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: join(repo, 'core/generated/exit') },
    phase: { type: 'string', default: 'all' },
    cases: { type: 'string', default: EXIT_CASES.join(',') },
    port: { type: 'string', default: '5295' },
    frames: { type: 'string', default: '10' }
  }
})
const out = resolve(values.out)
const cases = values.cases.split(',')
mkdirSync(out, { recursive: true })

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

// The library bytes the oracle page actually serves, through the parity
// package's link, never the tree that was edited
function servedBuild() {
  const root = realpathSync(
    join(repo, 'examples/parity/node_modules/three-clouds-webgpu')
  )
  const file = join(root, 'build/shared.js')
  return { root, sha256: sha256(readFileSync(file)) }
}

function provenance() {
  const dirty = git(
    'status',
    '--porcelain',
    '--',
    'src',
    'core',
    'examples/parity/src'
  )
  return {
    head: git('rev-parse', 'HEAD'),
    dirty: dirty === '' ? [] : dirty.split('\n'),
    servedBuild: servedBuild(),
    node: process.version,
    at: new Date().toISOString()
  }
}

function run(script, args) {
  const r = spawnSync(process.execPath, [join(repo, script), ...args], {
    cwd: repo,
    stdio: 'inherit'
  })
  if (r.status !== 0)
    throw new Error(`${script} ${args.join(' ')} exited ${r.status}`)
}

// With the rebuild skipped (the e2e suite builds once), refuse a build/
// older than any source file, or the oracle would serve stale library code
function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs
    )
  }
  return newest
}

function requireBuildNewerThanSource() {
  const built = statSync(join(servedBuild().root, 'build/shared.js')).mtimeMs
  const source = newestMtime(join(repo, 'src'))
  if (built < source)
    throw new Error(
      'build/ is older than src/: run pnpm build, or drop PARITY_SKIP_BUILD'
    )
}

function prepare() {
  const build = ensureFreshBuild('core-exit', { startDir: repo })
  if (!build.built) requireBuildNewerThanSource()
  const emitted = {}
  for (const name of cases) {
    const dir = join(out, `gen-${name}`)
    run('core/scripts/emit-runtime.mjs', ['--case', name, '--out', dir])
    emitted[name] = Object.fromEntries(
      ['description.json', 'setup.json'].map(f => [
        f,
        sha256(readFileSync(join(dir, f)))
      ])
    )
  }
  const record = { ...provenance(), cases, emitted }
  writeFileSync(join(out, 'prepared.json'), JSON.stringify(record, null, 1))
  console.log(`prepared ${cases.length} cases at ${record.head}`)
}

function gpu() {
  const prepared = JSON.parse(readFileSync(join(out, 'prepared.json'), 'utf8'))
  const now = provenance()
  // The oracle serves build/: a rebuild or an edit since prepare would
  // compare a different library from the one the descriptions came from
  if (now.servedBuild.sha256 !== prepared.servedBuild.sha256)
    throw new Error(
      'served build changed since prepare: run --phase prepare again'
    )
  if (now.head !== prepared.head)
    throw new Error(
      `HEAD moved since prepare (${prepared.head} -> ${now.head})`
    )
  const verdicts = []
  const evidence = {}
  for (const name of cases) {
    const dir = join(out, `run-${name}`)
    const report = join(dir, 'report.json')
    try {
      run('core/scripts/prove-runtime.mjs', [
        '--case',
        name,
        '--generated',
        join(out, `gen-${name}`),
        '--out',
        dir,
        '--port',
        values.port,
        '--frames',
        values.frames
      ])
    } catch (error) {
      console.error(String(error))
    }
    const r = existsSync(report)
      ? JSON.parse(readFileSync(report, 'utf8'))
      : null
    verdicts.push(caseVerdict(name, r))
    evidence[name] =
      r == null
        ? null
        : {
            report: sha256(readFileSync(report)),
            // Buffers taken from the three run's bytes, not computed: geometry,
            // the star catalogue and the app's own scene object
            statics: r.statics ?? null,
            textures: Object.fromEntries(
              Object.entries(r.results).map(([t, x]) => [
                t,
                x.oursSha256 ?? x.skipped ?? null
              ])
            )
          }
  }
  // Faults on the first case, against its oracle: each run must FAIL
  const faults = []
  for (const fault of EXIT_FAULTS) {
    const name = cases[0]
    const dir = join(out, `fault-${fault}-${name}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(out, `run-${name}`, 'oracle'), join(dir, 'oracle'))
    try {
      run('core/scripts/prove-runtime.mjs', [
        '--case',
        name,
        '--generated',
        join(out, `gen-${name}`),
        '--out',
        dir,
        '--port',
        values.port,
        '--frames',
        values.frames,
        '--reuse-oracle',
        '--fault',
        fault
      ])
    } catch (error) {
      console.error(String(error))
    }
    const report = join(dir, 'report.json')
    faults.push(
      faultVerdict(
        fault,
        existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null
      )
    )
  }
  const verdict = runVerdict(cases, verdicts, faults)
  const table = formatTable(verdicts)
  const record = { verdict, prepared, gpuRun: now, verdicts, faults, evidence }
  writeFileSync(join(out, 'exit-report.json'), JSON.stringify(record, null, 1))
  writeFileSync(
    join(out, 'exit-report.md'),
    `# Phase A exit test\n\nHEAD ${now.head}, served build ${now.servedBuild.sha256}\n\n${table}\n\n` +
      `Buffers not computed by the core (geometry, star catalogue, the app's scene), per case: ${Object.entries(
        evidence
      )
        .map(([c, e]) => `${c}: ${(e?.statics ?? ['?']).join(' ')}`)
        .join('; ')}\n\n` +
      `Faults (each must be caught): ${faults
        .map(
          f =>
            `${f.fault} ${f.caught ? 'caught' : 'NOT CAUGHT'} (${f.differingBytes} bytes)`
        )
        .join(', ')}\n\n` +
      `Verdict: ${verdict.pass ? 'PASS' : 'FAIL'}\n`
  )
  console.log(table)
  console.log('faults', faults)
  console.log(`exit test: ${verdict.pass ? 'PASS' : 'FAIL'}`, verdict)
  return verdict.pass
}

let ok = true
if (values.phase === 'all' || values.phase === 'prepare') prepare()
if (values.phase === 'all' || values.phase === 'gpu') ok = gpu()
process.exit(ok ? 0 : 1)
