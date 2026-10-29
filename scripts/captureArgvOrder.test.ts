// parsing is the first thing the entry points do. This test reads
// source. It does not import or spawn capture.mjs or setup-assets.mjs: a
// child process that regressed past the guard would start the dev server
// and Chrome

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { log } from '../test/helpers/log'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function lineOf(src: string, needle: string): number {
  let from = 0
  while (from < src.length) {
    const idx = src.indexOf(needle, from)
    if (idx < 0) return -1
    const lineStart = src.lastIndexOf('\n', idx) + 1
    const lineEnd = src.indexOf('\n', idx)
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd)
    const trimmed = line.trim()
    if (!trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      return src.slice(0, idx).split('\n').length
    }
    from = idx + needle.length
  }
  return -1
}

function assertBefore(
  src: string,
  earlier: readonly string[],
  later: readonly string[]
): { needle: string; line: number }[] {
  const found = [...earlier, ...later].map(needle => ({
    needle,
    line: lineOf(src, needle)
  }))
  for (const row of found) {
    expect(row.line, row.needle).toBeGreaterThan(0)
  }
  const guard = found.filter(row => earlier.includes(row.needle))
  const effects = found.filter(row => later.includes(row.needle))
  const guardEnd = Math.max(...guard.map(row => row.line))
  for (const effect of effects) {
    expect(effect.line, effect.needle).toBeGreaterThan(guardEnd)
  }
  for (let i = 1; i < guard.length; i++) {
    const prev = guard[i - 1]
    const curr = guard[i]
    if (prev == null || curr == null) throw new Error('guard step')
    expect(curr.line, curr.needle).toBeGreaterThan(prev.line)
  }
  return found
}

describe('argv is refused before capture side effects', () => {
  it('capture.mjs exits on help and bad argv before any capture work', () => {
    const src = readFileSync(
      join(ROOT, 'examples/parity/scripts/capture.mjs'),
      'utf8'
    )
    const found = assertBefore(
      src,
      [
        'parseCaptureArgs(',
        'parsed.help',
        'process.exit(0)',
        '!parsed.ok',
        'process.exit(1)'
      ],
      [
        'readFileSync(',
        'ensureFreshBuild(',
        'captureProvenance(',
        'spawn(',
        'chromium.launch(',
        'mkdirSync(',
        'writeFileSync(',
        'main()'
      ]
    )
    log('capture-order', found)
  })

  it('setup-assets.mjs exits on help and bad argv before copying', () => {
    const src = readFileSync(join(ROOT, 'scripts/setup-assets.mjs'), 'utf8')
    const found = assertBefore(
      src,
      [
        'parseSetupAssetsArgs(',
        'parsed.help',
        'process.exit(0)',
        '!parsed.ok',
        'process.exit(1)'
      ],
      ['existsSync(', 'mkdirSync(', 'copyFileSync(', 'statSync(']
    )
    log('setup-assets-order', found)
  })
})
