// A changelog entry that names a knob on `ctx.<field>` is copied into user
// code, so every knob it puts in code font must be a real key of that field,
// because assigning an unknown key is a silent no-op that throws nothing
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CloudsContext } from '../src/CloudsContext'
import { log } from './helpers/log'

const CHANGELOG = resolve(import.meta.dirname, '../CHANGELOG.md')

interface Entry {
  field: string
  names: string[]
}

// One entry per bullet that names a plain-object knob field of the context
function knobEntries(ctx: CloudsContext): Entry[] {
  const bullets = readFileSync(CHANGELOG, 'utf8').split(/\n(?=- )/)
  const entries: Entry[] = []
  for (const bullet of bullets) {
    const codes = [...bullet.matchAll(/`([^`]+)`/g)].map(m => m[1]!)
    for (const code of codes) {
      const field = /^ctx\.([A-Za-z]+)$/.exec(code)?.[1]
      if (field == null) continue
      const value = (ctx as unknown as Record<string, unknown>)[field]
      if (value == null || typeof value !== 'object') continue
      // Bare identifiers only: dotted paths and package names are not knobs
      const names = codes.filter(c => /^[a-z][A-Za-z0-9]*$/.test(c))
      entries.push({ field, names })
    }
  }
  return entries
}

describe('CHANGELOG knob names exist on the context', () => {
  const ctx = new CloudsContext()
  const entries = knobEntries(ctx)

  it('finds the knob entries it checks', () => {
    log(
      'entries',
      entries.map(e => ({ field: e.field, names: e.names }))
    )
    // cirrusDeck, rainShafts and cloudShape at least, each naming its knobs
    expect(entries.length).toBeGreaterThanOrEqual(3)
    expect(entries.every(e => e.names.length > 0)).toBe(true)
  })

  it('every knob in code font is a key of its field', () => {
    const unknown = entries.flatMap(({ field, names }) => {
      const keys = Object.keys(
        (ctx as unknown as Record<string, object>)[field]!
      )
      return names
        .filter(name => !keys.includes(name))
        .map(name => `ctx.${field}.${name}`)
    })
    log('unknown', { unknown: unknown.join(' ') || 'none' })
    expect(unknown).toEqual([])
  })
})
