import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../../..')
const DST_DIR = join(import.meta.dirname, '..', 'public', 'assets')
const BASIC_DST = join(ROOT, 'examples', 'basic', 'public', 'assets')

// ONE script, two callers. parity provisions from the REFERENCE
// package (its side A), examples/basic from the PORT, its only cloud package
// Byte-identical today, but the caller says which package it means
const SCRIPT = 'node scripts/setup-assets.mjs'
const PARITY_ARGS = '--example examples/parity --from @takram/three-clouds'
const BASIC_ARGS = '--example examples/basic --from three-clouds-webgpu'

const ASSETS = [
  { name: 'local_weather.png', expectedBytes: 679_653 },
  { name: 'shape.bin', expectedBytes: 2_097_152 },
  { name: 'shape_detail.bin', expectedBytes: 32_768 },
  { name: 'turbulence.png', expectedBytes: 49_691 }
]

describe('setup-assets', () => {
  it('script runs and reports all OK', () => {
    const result = execSync(`${SCRIPT} ${PARITY_ARGS}`, {
      cwd: ROOT,
      encoding: 'utf8'
    })
    for (const asset of ASSETS) {
      expect(result).toContain(`${asset.name} ${asset.expectedBytes} OK`)
    }
  })

  it.each(ASSETS)(
    '$name exists with correct size ($expectedBytes bytes)',
    ({ name, expectedBytes }) => {
      const path = join(DST_DIR, name)
      expect(existsSync(path)).toBe(true)
      const { size } = statSync(path)
      expect(size).toBe(expectedBytes)
    }
  )

  it('public/assets/ is gitignored', () => {
    const result = execSync('git check-ignore examples/parity/public/assets/', {
      cwd: ROOT,
      encoding: 'utf8'
    }).trim()
    expect(result).toContain('examples/parity/public/assets/')
  })
})

// examples/basic provisioned NOTHING, and the relative default URLs
// 404'd all four textures, unseen because basic had never been run (the same
// blind spot that shipped the `mrt` import)
describe('setup-assets — examples/basic', () => {
  it('provisions basic from the PORT, which ships its own assets', () => {
    const result = execSync(`${SCRIPT} ${BASIC_ARGS}`, {
      cwd: ROOT,
      encoding: 'utf8'
    })
    for (const asset of ASSETS) {
      expect(result).toContain(`${asset.name} ${asset.expectedBytes} OK`)
    }
  })

  it.each(ASSETS)(
    'basic has $name at $expectedBytes bytes',
    ({ name, expectedBytes }) => {
      const path = join(BASIC_DST, name)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).size).toBe(expectedBytes)
    }
  )

  it('basic public/assets/ is gitignored too — copied, never committed', () => {
    const result = execSync('git check-ignore examples/basic/public/assets/', {
      cwd: ROOT,
      encoding: 'utf8'
    }).trim()
    expect(result).toContain('examples/basic/public/assets/')
  })

  it('REFUSES a source package the example does not depend on', () => {
    // The obvious lift (point basic at @takram/three-clouds like parity) does
    // NOT work: basic depends on three-clouds-webgpu, not the reference. The
    // script must fail loudly rather than silently provisioning nothing
    let code = 0
    let output = ''
    try {
      execSync(
        `${SCRIPT} --example examples/basic --from @takram/three-clouds 2>&1`,
        { cwd: ROOT, encoding: 'utf8' }
      )
    } catch (e) {
      const err = e as { status?: number; stdout?: string }
      code = err.status ?? -1
      output = String(err.stdout ?? '')
    }
    expect(code).not.toBe(0)
    expect(output).toContain('is not installed under')
  })
})
