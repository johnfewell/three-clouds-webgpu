// The emitter: run the graph on the fake device, check the trace, describe it
// Runs under vite (core/scripts/emit.mjs) or vitest, which compile TSL from
// src/, and needs no GPU

import { execSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, type Description, type State } from './describe'
import { installFakeGpu, type GpuTrace } from './fakeGpu'
import type { runSideB as runSideBType } from './sideBGraph'
import { nameUniforms, type UniformNaming } from './uniformNames'

const REPO = resolve(import.meta.dirname, '../..')

// four frames: the fourth must repeat the second, then it is dropped
const RECORDED_FRAMES = 4

export interface EmitOptions {
  caseName: string
  // fail on a uniform three would name nodeUniformN (the default)
  allowAnonymous?: boolean
}

export interface EmitResult {
  description: Description
  state: State
  naming: UniformNaming
  // the fake device's record, for checks against what three did
  trace: GpuTrace
  // the live side B and parity case the description was emitted from, so
  // CPU-state checks can read the same inputs
  sideB: Awaited<ReturnType<typeof runSideBType>>['sideB']
  parityCase: Awaited<ReturnType<typeof runSideBType>>['pc']
}

export async function emitDescription(opts: EmitOptions): Promise<EmitResult> {
  // before three builds anything: the globals three reads at module load
  // fall back to constants, but the device and canvas must be ours
  const trace = installFakeGpu()
  // textures by role, filled in once the graph has made them
  const textureRoles = new Map<object, string>()
  const naming = nameUniforms(t => textureRoles.get(t))
  const anonymous = naming.anonymous
  const { ASSET_CONTENT, runSideB } = await import('./sideBGraph')
  // three renames a second declaration of a name to name_1 and only warns, so
  // a name that depends on build order is not a stable name
  const renamed: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    const message = args.map(String).join(' ')
    if (/Declaration name '\w+' .* already in use/.test(message))
      renamed.push(message)
    else warn(...args)
  }
  const run = await runSideB(trace, {
    caseName: opts.caseName,
    // the committed baked textures, not the parity
    // copy setup-assets generates, so a clean checkout can emit
    assetsDir: join(REPO, 'assets'),
    atmosphereAssetsDir: join(
      realpathSync(
        join(REPO, 'examples/parity/node_modules/@takram/three-atmosphere')
      ),
      'assets'
    ),
    frames: RECORDED_FRAMES,
    maxWarmup: 32,
    textureRoles
  })
  console.warn = warn
  if (renamed.length > 0) {
    throw new Error(
      `names declared twice in one shader:\n${renamed.join('\n')}`
    )
  }
  if (anonymous.length > 0 && opts.allowAnonymous !== true) {
    const sites = anonymous.map(a => `  ${a.type} ${a.site}`).join('\n')
    throw new Error(`${anonymous.length} unnamed uniforms:\n${sites}`)
  }
  const { description, state } = describe(trace, {
    textureNames: run.textureNames,
    frames: RECORDED_FRAMES,
    source: {
      graph: 'parity-side-b',
      case: opts.caseName,
      commit: execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(),
      three: (
        JSON.parse(
          readFileSync(join(REPO, 'node_modules/three/package.json'), 'utf8')
        ) as { version: string }
      ).version
    }
  })
  for (const [name, content] of Object.entries(ASSET_CONTENT)) {
    const texture = description.textures[name]
    if (texture != null) texture['content'] = content
  }
  // The ping-pong has period 2. The last recorded frame must repeat frame 1
  // step for step, which is checked, then the copy is dropped
  const frames = description.schedule.frames
  if (JSON.stringify(frames.at(-1)) !== JSON.stringify(frames[1])) {
    throw new Error(`frame ${frames.length - 1} does not repeat frame 1`)
  }
  // The values too, for a case that pins time and frame. A sequence that
  // advances them gets its values from the CPU state, not from state.json
  const w = state.writes.frames
  const periodicValues = JSON.stringify(w.at(-1)) === JSON.stringify(w[1])
  frames.length = 3
  w.length = 3
  description.source['periodicValues'] = periodicValues
  return {
    description,
    state,
    naming,
    trace,
    sideB: run.sideB,
    parityCase: run.pc
  }
}
