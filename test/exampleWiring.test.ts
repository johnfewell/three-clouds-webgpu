// The two defects typecheck provably cannot catch, audited statically so CI can
// run them. Both are semantically
// VALID TypeScript, so only a check reading the wiring sees them. The browser
// smoke needs a GPU, so this is the CI-reachable half, inside `pnpm test` at
// zero added minutes, and it anchors on content because line numbers die

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from './helpers/cpuTwin'

const ROOT = resolve(import.meta.dirname, '..')
const EXAMPLES = {
  basic: resolve(ROOT, 'examples/basic/src/main.ts'),
  r3f: resolve(ROOT, 'examples/r3f/src/App.tsx')
} as const

// Comments go before anything asserted ABSENT, since each example explains
// its own defect in prose and a raw-text search reads the fix as the bug

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function read(example: keyof typeof EXAMPLES): string {
  return stripComments(readFileSync(EXAMPLES[example], 'utf8'))
}

/**
 * The atmosphere's own camera. Unset, every uniform it derives from a camera
 * (`cameraPositionUnit`, `matrixViewToECEF`, `altitudeCorrectionUnit`) falls
 * back to `frame.camera`, which inside a fullscreen pass is the pass's quad
 * camera. The sky is then integrated from the origin along a view-space ray,
 * which is valid arithmetic and renders as a hard wedge with one black side
 */
function auditAtmosphereCamera(code: string): boolean {
  return /atmosphere(?:Context)?\s*\.\s*camera\s*=\s*camera/.test(code)
}

interface SunAudit {
  /** The sun direction is mentioned at all */
  mentioned: boolean
  /** WRITTEN, not merely read, so a read that never assigns leaves a black frame */
  written: boolean
}

/**
 * The atmosphere context's sun direction is assigned from a computed vector, and
 * a WRITE is the whole point: `new Vector3()` alone is a valid black scene
 */
function auditSun(code: string): SunAudit {
  const assigned = new RegExp(
    /(sunDirectionECEF|cloudsContext\s*\.\s*sunDirection)\s*(\.value\s*)?\.\s*(copy|set)\s*\(/
  )
  // The sanctioned helper writes the sun into a sink list rather than copying
  // into each consumer, so it counts as writing one. The sinks are what the
  // audit checks: a call with no sunDirection among them is still only a mention
  const viaHelper = /syncCelestialDirections\(\s*\[[\s\S]*?sunDirection/.test(
    code
  )
  return {
    mentioned: /sunDirection/.test(code),
    written: assigned.test(code) || viaHelper
  }
}

interface SizeAudit {
  /** The canvas is sized off the window, not left at the HTML 300x150 */
  sized: boolean
  /** r3f's <Canvas> sizes itself, so the audit looks for the component */
  sizingOwner: string | null
}

function auditSize(code: string): SizeAudit {
  const setSize = /renderer\s*\.\s*setSize\s*\(/.test(code)
  const canvas = /<Canvas\b/.test(code)
  return {
    sized: setSize || canvas,
    sizingOwner: setSize ? 'renderer.setSize' : canvas ? '<Canvas>' : null
  }
}

describe('examples/basic sizes its canvas and sets a sun', () => {
  it('the consumer sizes the renderer off the window', () => {
    const audit = auditSize(read('basic'))
    table('example-basic-size', [
      {
        field: 'sizing owner',
        expected: 'renderer.setSize',
        actual: String(audit.sizingOwner)
      }
    ])
    // Without it the canvas keeps the HTML default 300x150, and a missing call
    // is not a type error
    expect(
      audit.sized,
      'examples/basic never sizes its renderer, so the canvas stays 300x150'
    ).toBe(true)
  })

  it('the atmosphere gets the SCENE camera, not the pass quad camera', () => {
    const bound = auditAtmosphereCamera(read('basic'))
    table('example-basic-atmosphere-camera', [
      {
        field: 'atmosphere.camera bound',
        expected: true,
        actual: String(bound)
      }
    ])
    expect(
      bound,
      'examples/basic leaves atmosphere.camera unset, so the sky is ' +
        "integrated from the Earth's centre along a view-space ray and one " +
        'side of the sky renders black'
    ).toBe(true)
  })

  it('the consumer WRITES a sun direction, not merely mentions one', () => {
    const audit = auditSun(read('basic'))
    table('example-basic-sun', [
      {
        field: 'sun mentioned',
        expected: true,
        actual: String(audit.mentioned)
      },
      { field: 'sun WRITTEN', expected: true, actual: String(audit.written) }
    ])
    expect(audit.mentioned).toBe(true)
    // The load-bearing half: a zero sun is valid arithmetic through march, sky
    // and shadow, so the example renders black with no error
    expect(
      audit.written,
      'examples/basic never writes a sun, so it renders black with no error'
    ).toBe(true)
  })
})

describe('examples/r3f sizes its canvas and sets a sun', () => {
  it('the Canvas component owns the canvas size', () => {
    const audit = auditSize(read('r3f'))
    table('example-r3f-size', [
      {
        field: 'sizing owner',
        expected: '<Canvas>',
        actual: String(audit.sizingOwner)
      }
    ])
    expect(
      audit.sized,
      'examples/r3f has neither a setSize call nor a <Canvas>, so nothing sizes the canvas'
    ).toBe(true)
  })

  it('the atmosphere gets the SCENE camera there too', () => {
    expect(
      auditAtmosphereCamera(read('r3f')),
      'examples/r3f leaves atmosphere.camera unset'
    ).toBe(true)
  })

  it('the scene WRITES a sun direction, not merely mentions one', () => {
    const audit = auditSun(read('r3f'))
    table('example-r3f-sun', [
      {
        field: 'sun mentioned',
        expected: true,
        actual: String(audit.mentioned)
      },
      { field: 'sun WRITTEN', expected: true, actual: String(audit.written) }
    ])
    expect(audit.mentioned).toBe(true)
    expect(
      audit.written,
      'examples/r3f never writes a sun direction, so it renders black with no error'
    ).toBe(true)
  })
})

// A guard is only worth its line count if it FAILS on the defect. Asserting it
// against the verbatim shipped form proves it permanently and in-suite, where a
// one-time manual revert proves it once and leaves no record
const NEVER_SIZED = `
const renderer = new WebGPURenderer({ canvas })
void renderer.setAnimationLoop(() => {
  pipeline.render()
})
`

const NEVER_SUNNED = `
const atmosphere = new Atmosphere()
const sunDirection = new Vector3()
const cloudsContext = new CloudsContext({ atmosphere, sceneDepth })
void renderer.setAnimationLoop(() => {
  pipeline.render()
})
`

const NEVER_CAMERA_BOUND = `
const atmosphere = new AtmosphereContext()
const camera = new PerspectiveCamera()
atmosphere.raymarchScattering = false
void atmosphere
`

describe('the example audits REJECT the defects that reached main', () => {
  it('rejects a consumer that never binds the atmosphere camera', () => {
    expect(
      auditAtmosphereCamera(stripComments(NEVER_CAMERA_BOUND)),
      'the unbound-camera defect is detected'
    ).toBe(false)
    // A comment naming the fix must not satisfy it, or the examples' own prose
    // would make this audit permanently green
    expect(
      auditAtmosphereCamera(
        stripComments('// atmosphere.camera = camera\nvoid 0')
      ),
      'a comment naming the binding satisfies the audit'
    ).toBe(false)
    expect(
      auditAtmosphereCamera('atmosphereContext.camera = camera'),
      'the harness spelling counts too'
    ).toBe(true)
  })

  it('rejects a consumer that never sizes its renderer', () => {
    const audit = auditSize(NEVER_SIZED)
    expect(audit.sized, 'the never-sized defect is detected').toBe(false)
    expect(audit.sizingOwner).toBeNull()
  })

  it('rejects a consumer that never WRITES a sun direction', () => {
    const audit = auditSun(NEVER_SUNNED)
    // Naming the sun without writing it is the exact shape of the defect, and
    // is why the audit requires a write
    expect(audit.mentioned, 'the fixture mentions the sun').toBe(true)
    expect(audit.written, 'mentioning the sun is not setting it').toBe(false)
  })

  it('accepts the corrected forms', () => {
    expect(auditSize('renderer.setSize(innerWidth, innerHeight)').sized).toBe(
      true
    )
    expect(
      auditSun('atmosphere.sunDirectionECEF.value.copy(sunDirection)').written
    ).toBe(true)
    expect(
      auditSun('cloudsContext.sunDirection.copy(sunDirection)').written
    ).toBe(true)
    // The helper form, and the shape that must NOT satisfy it: a call whose
    // sinks carry no sun is as inert as naming one
    expect(
      auditSun(
        'syncCelestialDirections([{ sunDirection: ctx.sunDirection }], when)'
      ).written
    ).toBe(true)
    expect(
      auditSun('syncCelestialDirections([{ cloudType: name }], when)').written
    ).toBe(false)
  })
})

// The guard that guards the guard. Both example sources explain their own
// defect in prose, so a comment-blind absence check would report the fix as
// the bug forever
describe('the example audits do not read prose as wiring', () => {
  // Asserted on the value the audits CONSUME. A fixture passed straight to
  // auditSize bypasses stripComments and cannot see the strip removed, which
  // is how this test caught itself green during development
  it('the audited source of both examples is comment-free', () => {
    table('example-audit-comment-strip', [
      { example: 'basic', noLineComment: !/^\s*\/\//m.test(read('basic')) },
      { example: 'r3f', noLineComment: !/^\s*\/\//m.test(read('r3f')) }
    ])
    // Both examples name their own defects in prose, so this is the property
    // that keeps the absence checks honest
    expect(read('basic'), 'basic prose survived the strip').not.toMatch(
      /without setSize/i
    )
    expect(read('r3f'), 'r3f prose survived the strip').not.toMatch(/BLACK/i)
  })

  it('a comment naming setSize does not satisfy the size audit', () => {
    const commented = `
// without setSize the canvas keeps the HTML default 300x150
void renderer.setAnimationLoop(() => {})
`
    expect(auditSize(stripComments(commented)).sized).toBe(false)
    expect(auditSize(read('basic')).sized, 'the real file does size').toBe(true)
  })

  it('a comment naming sunDirection does not satisfy the sun audit', () => {
    const commented = `
// without it the frame is BLACK: both sun directions start at zero
void renderer.setAnimationLoop(() => {})
`
    expect(auditSun(stripComments(commented)).written).toBe(false)
    expect(auditSun(read('r3f')).written, 'the real file does write').toBe(true)
  })
})
