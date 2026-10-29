import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

// citations.mjs checks only entries at or below phase.json, so a wrong
// `where` on a later-phase entry stays hidden until the bump. This
// applies the gate's URL and marker rules to EVERY entry against src/

interface UrlEntry {
  url: string
  phase: number
  where: string | string[]
}

interface MarkerEntry {
  text: string
  phase: number
  where: string
}

const ROOT = join(import.meta.dirname, '../..')
const req = JSON.parse(
  readFileSync(join(import.meta.dirname, 'required-citations.json'), 'utf8')
) as { urls: UrlEntry[]; markers: MarkerEntry[] }

// Same file set as citations.mjs: src/**/*.ts without *.test*
function sourceFiles(dir: string, out: Map<string, string>) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (name.endsWith('.ts') && !name.includes('.test.')) {
      out.set(relative(ROOT, path), readFileSync(path, 'utf8'))
    }
  }
  return out
}

const contents = sourceFiles(join(ROOT, 'src'), new Map<string, string>())

describe('required-citations.json locations, every phase', () => {
  it('reads the source tree and the full register', () => {
    expect(contents.size).toBeGreaterThan(0)
    expect(req.urls.length).toBe(24)
    expect(req.markers.length).toBe(11)
  })

  it('every URL is at each of its locations and nowhere else in src/', () => {
    setCurrentSpec('required-citation-urls')
    const rows = req.urls.map(u => {
      const where = Array.isArray(u.where) ? u.where : [u.where]
      const missing = where.filter(w => !contents.get(w)?.includes(u.url))
      const misplaced = [...contents]
        .filter(([f, src]) => !where.includes(f) && src.includes(u.url))
        .map(([f]) => f)
      return { url: u.url, phase: u.phase, missing, misplaced }
    })
    log('required-citation-urls', rows)
    expect(rows.filter(r => r.missing.length || r.misplaced.length)).toEqual([])
  })

  it('every marker is at its location', () => {
    setCurrentSpec('required-citation-markers')
    const missing = req.markers.filter(
      m => !contents.get(m.where)?.includes(m.text)
    )
    log('required-citation-markers', { checked: req.markers.length, missing })
    expect(missing).toEqual([])
  })
})
