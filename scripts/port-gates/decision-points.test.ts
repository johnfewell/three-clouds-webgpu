import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

interface ExecError {
  stdout?: string
  stderr?: string
  status?: number
}

function isExecError(e: unknown): ExecError {
  return typeof e === 'object' && e !== null ? e : {}
}

const ROOT = join(import.meta.dirname, '../..')
const GATE_DIR = join(ROOT, 'scripts/port-gates')
const run = (dir: string, max?: number) => {
  const maxFlag = max != null ? ` --max ${max}` : ''
  const result = execSync(
    `node ${GATE_DIR}/decision-points.mjs ${dir}${maxFlag}`,
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' }
    }
  )
  return result
}
const runExit = (dir: string, max?: number) => {
  try {
    const out = run(dir, max)
    return { out, code: 0 }
  } catch (e: unknown) {
    const err = isExecError(e)
    return {
      out: (err.stdout ?? '') + (err.stderr ?? ''),
      code: err.status ?? 1
    }
  }
}

describe('decision-points fixtures', () => {
  it('ok/good.ts: 7 functions, max 5, gate 12, 0 over, exit 0', () => {
    setCurrentSpec('decision-points-ok')
    const { out, code } = runExit(`${GATE_DIR}/fixtures/ok`, 12)
    log('decision-points-ok', { stdout: out })
    expect(code).toBe(0)
    expect(out).toContain('7 shader functions')
    expect(out).toMatch(/good\.ts:\d+ measuredFive/)
    expect(out).toContain('gate 12')
    expect(out).toContain('0 over')
    expect(out).not.toContain('structural problem')
  })

  it('bad/bad.ts: 3 functions, max 13, 1 over, 4 structural problems, exit 1', () => {
    setCurrentSpec('decision-points-bad')
    const { out, code } = runExit(`${GATE_DIR}/fixtures/bad`, 12)
    log('decision-points-bad', { stdout: out })
    expect(code).toBe(1)
    expect(out).toContain('3 shader functions')
    expect(out).toMatch(/bad\.ts:\d+ thirteen/)
    expect(out).toContain('1 over')
    expect(out).toContain('4 structural problem(s) (fatal)')
    expect(out).toContain('unmeasured Fn')
    expect(out).toContain('flow outside Fn')
  })

  it('bad/bad.ts: expressionBodied and expressionVar are MEASURED', () => {
    setCurrentSpec('decision-points-bad-measured')
    const out = runExit(`${GATE_DIR}/fixtures/bad`, 12).out
    expect(out).toMatch(/\d+\s+bad\.ts:\d+\s+expressionBodied/)
    expect(out).toMatch(/\d+\s+bad\.ts:\d+\s+expressionVar/)
  })

  it('bad/bad.ts: 2 unmeasured + 2 flow-outside', () => {
    setCurrentSpec('decision-points-bad-structural')
    const out = runExit(`${GATE_DIR}/fixtures/bad`, 12).out
    const unmeasured = (out.match(/unmeasured Fn/g) || []).length
    const flowOutside = (out.match(/flow outside Fn/g) || []).length
    expect(unmeasured).toBe(2)
    expect(flowOutside).toBe(2)
  })

  it('glsl: 2 functions, #if column present', () => {
    setCurrentSpec('decision-points-glsl')
    const out = run(`${GATE_DIR}/fixtures/glsl`)
    log('decision-points-glsl', { stdout: out })
    expect(out).toContain('2 shader functions')
    expect(out).toContain('#if')
    expect(out).toMatch(/conditionalFunc/)
    expect(out).toMatch(/simpleFunc/)
  })
})

describe('decision-points reference baselines', () => {
  it('reference/clouds/src/shaders: 94 functions, max 12 marchClouds, 0 over', () => {
    setCurrentSpec('decision-points-ref-glsl')
    const { out, code } = runExit('reference/clouds/src/shaders', 12)
    log('decision-points-ref-glsl', { stdout: out })
    expect(code).toBe(0)
    expect(out).toContain('94 shader functions')
    expect(out).toMatch(/max 12 \(clouds\.frag:472 marchClouds\)/)
    expect(out).toContain('gate 12')
    expect(out).toContain('0 over')
    expect(out).toContain('"11-15":1')
    expect(out).toContain('"6-10":6')
    expect(out).toContain('"1-5":87')
  })

  it('reference/atmosphere-webgpu: 89 functions, max 19 surfaceLuminance, 8 structural problems', () => {
    setCurrentSpec('decision-points-ref-atmosphere')
    const { out, code } = runExit('reference/atmosphere-webgpu', 12)
    log('decision-points-ref-atmosphere', { stdout: out })
    expect(code).toBe(1)
    expect(out).toContain('89 shader functions')
    expect(out).toMatch(
      /max 19 \(AerialPerspectiveNode\.ts:144 surfaceLuminance\)/
    )
    expect(out).toContain('8 structural problem(s)')
  })

  it('reference/core-webgpu: 38 functions, max 18, 12 structural problems', () => {
    setCurrentSpec('decision-points-ref-core')
    const { out, code } = runExit('reference/core-webgpu', 12)
    log('decision-points-ref-core', { stdout: out })
    expect(code).toBe(1)
    expect(out).toContain('38 shader functions')
    expect(out).toMatch(/max 18/)
    expect(out).toContain('12 structural problem(s)')
  })
})
