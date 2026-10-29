import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

const ROOT = join(import.meta.dirname, '../..')
const GATE_DIR = join(ROOT, 'scripts/port-gates')

const runAudit = (dir: string) =>
  execSync(`node ${GATE_DIR}/comment-audit.mjs ${dir}`, {
    cwd: ROOT,
    encoding: 'utf8',
    // FORCE_COLOR pinned off: the audit colourises its counts, so an inherited
    // FORCE_COLOR turns 'doc-blocks 1' into escape codes and every substring
    // match fails. NO_COLOR does not help, the script honours FORCE_COLOR only
    env: { ...process.env, NODE_NO_WARNINGS: '1', FORCE_COLOR: '0' }
  })

describe('comment-audit fixtures', () => {
  it('fixture: detects TODO, NOTE tags and 2 URLs', () => {
    setCurrentSpec('comment-audit-fixture')
    const out = runAudit(`${GATE_DIR}/fixtures/comments`)
    log('comment-audit-fixture', { stdout: out })
    expect(out).toContain('"TODO":1')
    expect(out).toContain('"NOTE":1')
    expect(out).toContain('links cited in source (2)')
    expect(out).toContain('doc-blocks 1')
  })
})

describe('comment-audit reference baseline', () => {
  it('reference/clouds/src: TS comment/code 0.05, GLSL 0.14, doc-blocks match, tags match, 30 links', () => {
    setCurrentSpec('comment-audit-ref')
    const out = runAudit('reference/clouds/src')
    log('comment-audit-ref', { stdout: out })

    const tsLine = out.split('\n').find(l => l.startsWith('TS'))!
    expect(tsLine).toContain('comment/code 0.05')
    expect(tsLine).toContain('doc-blocks 2')

    const glslLine = out.split('\n').find(l => l.startsWith('GLSL'))!
    expect(glslLine).toContain('0.14')

    expect(out).toContain('"TODO":10')
    expect(out).toContain('"NOTE":1')
    expect(out).toContain('links cited in source (30)')
  })
})
