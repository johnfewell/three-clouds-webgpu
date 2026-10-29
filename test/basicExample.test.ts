// examples/basic must BE the WEBGPU.md "Usage" snippet, so the documented
// wiring cannot drift. It must also drive
// `pipeline.render()`, not `renderer.render()`: the example shipped
// the wrong call and nothing caught it. Static form, reading the consumer
// with no test hooks added to the snippet

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEBGPU_MD = resolve(import.meta.dirname, '../WEBGPU.md')
const BASIC_MAIN = resolve(import.meta.dirname, '../examples/basic/src/main.ts')

function extractUsageSnippet(markdown: string): string | null {
  const match = markdown.match(/## Usage[\s\S]*?\n```ts\n([\s\S]*?)\n```/)
  return match?.[1] ?? null
}

/**
 * Comments must go before anything is asserted ABSENT from the source: the
 * corrected file names `renderer.render()` twice while explaining why it is
 * wrong, so a plain search of the raw text reports the defect in the very file
 * that fixed it. Stripping is what makes the absence check mean anything.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * The body of the `setAnimationLoop` callback, comments removed, or null when
 * there is no such loop. Brace-matched rather than line-sliced so that adding a
 * conditional inside the loop cannot silently truncate what gets audited.
 */
function loopBody(source: string): string | null {
  const code = stripComments(source)
  const at = code.search(/setAnimationLoop\s*\(/)
  if (at === -1) return null
  const open = code.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(open + 1, i)
    }
  }
  return null
}

interface LoopAudit {
  /** A loop exists at all. Every other field is meaningless without it */
  found: boolean
  advancesTime: boolean
  advancesFrame: boolean
  rendersPipeline: boolean
  /** The defect: the renderer driven directly, bypassing the pipeline */
  callsRendererRender: boolean
}

function auditLoop(source: string): LoopAudit {
  const body = loopBody(source)
  if (body == null) {
    return {
      found: false,
      advancesTime: false,
      advancesFrame: false,
      rendersPipeline: false,
      callsRendererRender: false
    }
  }
  return {
    found: true,
    advancesTime: /cloudsContext\s*\.\s*time\s*\+=/.test(body),
    advancesFrame: /cloudsContext\s*\.\s*frame\s*=/.test(body),
    rendersPipeline: /\bpipeline\s*\.\s*render\s*\(/.test(body),
    callsRendererRender: /\brenderer\s*\.\s*render\s*\(/.test(body)
  }
}

/** The loop EXACTLY as shipped (f44a926^), the defect this guard exists for */
const SHIPPED_BAD = `
const clock = new Clock()
let frame = 0
void renderer.setAnimationLoop(() => {
  cloudsContext.time += clock.getDelta()
  cloudsContext.frame = frame++
  renderer.render()
})
`

describe('examples/basic is the WEBGPU.md Usage snippet', () => {
  it('the basic consumer source matches the documented snippet verbatim', () => {
    const markdown = readFileSync(WEBGPU_MD, 'utf8')
    const main = readFileSync(BASIC_MAIN, 'utf8')
    const snippet = extractUsageSnippet(markdown)

    console.table([
      {
        what: 'WEBGPU.md Usage section found',
        expected: 'true',
        actual: String(snippet != null)
      },
      {
        what: 'basic/src/main.ts matches snippet',
        expected: 'true',
        actual: String(snippet?.trimEnd() === main.trimEnd())
      }
    ])

    expect(snippet, 'WEBGPU.md has a ## Usage ts snippet').not.toBeNull()
    expect(snippet?.trimEnd()).toBe(main.trimEnd())
  })
})

describe('the basic consumer drives the pipeline each frame', () => {
  it('the animation loop advances time and frame and renders the PIPELINE', () => {
    const audit = auditLoop(readFileSync(BASIC_MAIN, 'utf8'))

    console.table([
      {
        what: 'setAnimationLoop found',
        expected: 'true',
        actual: String(audit.found)
      },
      {
        what: 'advances cloudsContext.time',
        expected: 'true',
        actual: String(audit.advancesTime)
      },
      {
        what: 'advances cloudsContext.frame',
        expected: 'true',
        actual: String(audit.advancesFrame)
      },
      {
        what: 'calls pipeline.render()',
        expected: 'true',
        actual: String(audit.rendersPipeline)
      },
      {
        what: 'calls renderer.render()',
        expected: 'false',
        actual: String(audit.callsRendererRender)
      }
    ])

    expect(audit.found, 'examples/basic has an animation loop').toBe(true)
    // Frozen time renders a still frame forever: the clouds' temporal
    // accumulation never advances and the demo silently shows one sample
    expect(audit.advancesTime, 'the loop advances cloudsContext.time').toBe(
      true
    )
    expect(audit.advancesFrame, 'the loop advances cloudsContext.frame').toBe(
      true
    )
    // The load-bearing one. `pipeline.render()` drives `outputNode` (the clouds
    // composited over aerial) through the pipeline's own quad
    expect(audit.rendersPipeline, 'the loop calls pipeline.render()').toBe(true)
    expect(
      audit.callsRendererRender,
      'the loop must not drive the renderer directly — that bypasses the pipeline'
    ).toBe(false)
  })

  // A guard is only worth its line count if it FAILS on the defect. Asserting
  // that against the verbatim shipped source proves it permanently and in-suite,
  // where a one-time manual revert proves it once and leaves no record
  it('REJECTS the loop exactly as it shipped', () => {
    const audit = auditLoop(SHIPPED_BAD)
    expect(audit.found).toBe(true)
    expect(audit.callsRendererRender, 'the shipped defect is detected').toBe(
      true
    )
    expect(
      audit.rendersPipeline,
      'the shipped loop never drove the pipeline'
    ).toBe(false)
    // Note WHICH assertion does the work: the shipped loop advanced time and
    // frame perfectly well. A time/frame check alone would have passed it.
    expect(audit.advancesTime).toBe(true)
    expect(audit.advancesFrame).toBe(true)
  })

  it('REJECTS a loop that renders correctly but freezes time', () => {
    const audit = auditLoop(
      'void renderer.setAnimationLoop(() => {\n  pipeline.render()\n})'
    )
    expect(audit.rendersPipeline).toBe(true)
    expect(audit.advancesTime, 'frozen time is caught').toBe(false)
    expect(audit.advancesFrame).toBe(false)
  })

  // This guards the GUARD. The corrected consumer explains the defect by naming
  // it, so a comment-blind absence check reports the fix as the bug. If this
  // ever fails, the audit has started reading prose as code
  it('does not read a comment mentioning renderer.render() as a call', () => {
    const raw = readFileSync(BASIC_MAIN, 'utf8')
    const mentions = raw.match(/renderer\s*\.\s*render\s*\(/g) ?? []
    expect(
      mentions.length,
      'the corrected file names the defect in prose — that is the point of this test'
    ).toBeGreaterThan(0)
    expect(auditLoop(raw).callsRendererRender).toBe(false)
  })
})
