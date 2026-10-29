import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from './helpers/log'

const FORBIDDEN_IMPORTS = [
  'cameraPosition',
  'cameraProjectionMatrix',
  'cameraViewMatrix',
  'cameraWorldMatrix',
  'cameraNormalMatrix',
  'cameraNear',
  'cameraFar'
]

const SHADER_DIRS = [
  'src/march',
  'src/shadow',
  'src/resolve',
  'src/density',
  'src/lighting'
]

function collectFiles(dir: string): string[] {
  const result: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        result.push(...collectFiles(full))
      } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
        result.push(full)
      }
    }
  } catch {
    // Directory may not exist yet
  }
  return result
}

describe('no TSL camera node imports in shader modules', () => {
  setCurrentSpec('no-camera-nodes')

  const root = join(__dirname, '..')
  const violations: Array<{ file: string; line: number; text: string }> = []

  for (const dir of SHADER_DIRS) {
    const files = collectFiles(join(root, dir))
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      for (const [i, line] of lines.entries()) {
        if (!line.includes('import')) continue
        if (!line.includes('three/tsl')) continue
        for (const name of FORBIDDEN_IMPORTS) {
          if (line.includes(name)) {
            violations.push({
              file: relative(root, file),
              line: i + 1,
              text: line.trim()
            })
          }
        }
      }
    }
  }

  it('no forbidden TSL camera imports', () => {
    log(
      'no-camera-nodes',
      violations.length > 0 ? violations : { result: 'clean' }
    )

    expect(
      violations,
      `Found ${String(violations.length)} forbidden TSL camera import(s):\n` +
        violations
          .map(v => `  ${v.file}:${String(v.line)} — ${v.text}`)
          .join('\n')
    ).toHaveLength(0)
  })
})
