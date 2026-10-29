// docs/EXPERIMENTAL.md is the reference for the opt-in experiments, so it
// has to follow the code. An option that lands without a section, a section for
// an option that was never merged, and a documented default that disagrees with
// experimentalDefaults are the three drifts this guards. Two files of text and
// one plain module: no GPU, and nothing imported from the pass

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { experimentalDefaults } from '../src/experimental/options'
import { log } from './helpers/log'

const DOC = resolve(import.meta.dirname, '../docs/EXPERIMENTAL.md')
const WEBGPU_MD = resolve(import.meta.dirname, '../WEBGPU.md')
const README = resolve(import.meta.dirname, '../README.md')

const OVERVIEW = '## Options at a glance'
const SECTION = /^## `([A-Za-z][A-Za-z0-9]*)`\s*$/
const SUBHEADING = /^### (.+?)\s*$/
const OPTION_NAME = /`([A-Za-z][A-Za-z0-9]*)`/

interface OptionSection {
  option: string
  subheadings: string[]
  /** Prose word count per subheading, so an empty one fails not passes */
  words: Map<string, number>
}

interface OptionRow {
  option: string
  claimedDefault: string | null
  cells: number
}

/**
 * The at-a-glance table as rows, or null when the heading is absent. Parsed
 * rather than regexed whole-file so a second table cannot silently satisfy the
 * check by carrying the same option twice.
 */
function optionRows(markdown: string): OptionRow[] | null {
  const start = markdown.indexOf(OVERVIEW)
  if (start === -1) return null
  const lines = markdown.slice(start).split('\n').slice(1)
  const rows: OptionRow[] = []
  let seenRule = false
  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (rows.length > 0) break
      continue
    }
    if (/^\|[\s|:-]+\|$/.test(line)) {
      seenRule = true
      continue
    }
    // the header row sits above the rule, and no option is named in it
    if (!seenRule) continue
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|')
    const option = cells[0]?.match(OPTION_NAME)?.[1]
    if (option == null) continue
    rows.push({
      option,
      claimedDefault: cells[1]?.trim().replace(/`/g, '') ?? null,
      cells: cells.length
    })
  }
  return rows
}

/**
 * One entry per h2 option section, with its h3 subheadings and their prose size
 */
function optionSections(markdown: string): OptionSection[] {
  const sections: OptionSection[] = []
  for (const line of markdown.split('\n')) {
    const heading = line.match(SECTION)
    if (heading != null) {
      sections.push({
        option: heading[1]!,
        subheadings: [],
        words: new Map()
      })
      continue
    }
    const current = sections[sections.length - 1]
    if (current == null) continue
    const sub = line.match(SUBHEADING)
    if (sub != null) {
      current.subheadings.push(sub[1]!)
      current.words.set(sub[1]!, 0)
      continue
    }
    const last = current.subheadings[current.subheadings.length - 1]
    if (last == null || !line.trim()) continue
    current.words.set(last, current.words.get(last)! + wordsIn(line))
  }
  return sections
}

function wordsIn(line: string): number {
  return line.split(/\s+/).filter(Boolean).length
}

/** Words under one subheading of a section, headings excluded */
function sectionProse(markdown: string, option: string, subheading: string) {
  const lines = markdown.split('\n')
  const at = lines.findIndex(
    line => SECTION.test(line) && line.includes(option)
  )
  if (at === -1) return null
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    if (SECTION.test(lines[i]!) || /^## /.test(lines[i]!)) {
      end = i
      break
    }
  }
  const body = lines.slice(at, end)
  const from = body.findIndex(line => line === `### ${subheading}`)
  if (from === -1) return null
  const prose: string[] = []
  for (const line of body.slice(from + 1)) {
    if (line.startsWith('#')) break
    prose.push(line)
  }
  return prose.join('\n').trim()
}

const REQUIRED_SUBHEADINGS = ['What it does', 'Cost', 'Trade-offs']

type OptionName = keyof typeof experimentalDefaults

/** The code's own default for one option, by name */
function codeDefault(option: OptionName): boolean {
  return experimentalDefaults[option]
}

describe('docs/EXPERIMENTAL.md documents every experimental option', () => {
  const markdown = readFileSync(DOC, 'utf8')
  const rows = optionRows(markdown) ?? []
  const sections = optionSections(markdown)
  const known = Object.keys(experimentalDefaults) as OptionName[]

  it('the at-a-glance table names exactly the options that exist', () => {
    log('experimental-options', {
      tableRows: rows.length,
      sections: sections.length,
      knownOptions: known.length
    })
    log(
      'experimental-options-rows',
      known.map(option => ({
        option,
        inTable: rows.some(row => row.option === option),
        section: sections.some(s => s.option === option),
        documentedDefault: rows.find(r => r.option === option)?.claimedDefault,
        codeDefault: String(codeDefault(option))
      }))
    )

    expect(rows.length, `${DOC} has the "${OVERVIEW}" table`).toBeGreaterThan(0)
    expect(
      rows.map(row => row.option).sort(),
      'the table lists every option in experimentalDefaults and nothing else'
    ).toEqual([...known].sort())
  })

  it('every option has its own section with what, cost and trade-offs', () => {
    log(
      'experimental-options-sections',
      sections.map(section => ({
        option: section.option,
        subheadings: section.subheadings.join(' | '),
        words: [...section.words.values()].join(',')
      }))
    )

    expect(
      sections.map(section => section.option).sort(),
      'one h2 section per option, and no section for a missing option'
    ).toEqual([...known].sort())
    for (const option of known) {
      const section = sections.find(s => s.option === option)
      expect(section, `${option} has a section`).toBeDefined()
      for (const required of REQUIRED_SUBHEADINGS) {
        expect(
          section!.subheadings,
          `${option} has a "### ${required}" subheading`
        ).toContain(required)
        const prose = sectionProse(markdown, option, required)
        expect(
          wordsIn(prose ?? ''),
          `${option} "### ${required}" says something`
        ).toBeGreaterThan(8)
      }
    }
  })

  it('the documented defaults are the code defaults', () => {
    log(
      'experimental-options-defaults',
      known.map(option => ({
        option,
        documented: rows.find(row => row.option === option)?.claimedDefault,
        code: String(codeDefault(option))
      }))
    )

    for (const option of known) {
      expect(
        rows.find(row => row.option === option)?.claimedDefault,
        `${option}'s documented default`
      ).toBe(String(codeDefault(option)))
    }
    // The guide claimed every option was off until distantShapeDetailFade was
    // promoted. Assert the shipped-on set agrees with the table,
    // so a second promotion has to be documented rather than absorbed
    const onByDefault = known.filter(o => codeDefault(o))
    expect(
      rows.filter(row => row.claimedDefault === 'true').map(r => r.option)
    ).toHaveLength(onByDefault.length)
    for (const option of onByDefault) {
      expect(
        rows.find(row => row.option === option)?.claimedDefault,
        `${option} ships on and the table says so`
      ).toBe('true')
    }
    expect(markdown).toContain('distantShapeDetailFade')
  })
})

describe('the experimental options are reachable from the entry docs', () => {
  it('WEBGPU.md and README.md link the guide', () => {
    const webgpu = readFileSync(WEBGPU_MD, 'utf8')
    const readme = readFileSync(README, 'utf8')
    log('experimental-doc-links', {
      webgpuMentions: webgpu.includes('docs/EXPERIMENTAL.md'),
      readmeMentions: readme.includes('docs/EXPERIMENTAL.md')
    })
    expect(webgpu).toContain('docs/EXPERIMENTAL.md')
    expect(readme).toContain('docs/EXPERIMENTAL.md')
  })

  // A guard is only worth its lines if it FAILS on the drift. These three feed
  // the parser the defect it exists to catch, so the rejection is permanent and
  // in-suite rather than a one-time manual revert that leaves no record
  it('REJECTS an option with no table row and no section', () => {
    const without = markdown_without('windReprojection')
    expect(optionRows(without)!.map(row => row.option)).not.toContain(
      'windReprojection'
    )
    expect(optionSections(without).map(s => s.option)).not.toContain(
      'windReprojection'
    )
  })

  it('REJECTS a documented default the code does not have', () => {
    const flipped = markdown.replace(
      '| `directionalSkylight` | `false` |',
      '| `directionalSkylight` | `true` |'
    )
    const row = optionRows(flipped)!.find(
      r => r.option === 'directionalSkylight'
    )
    expect(row!.claimedDefault).not.toBe(
      String(codeDefault('directionalSkylight'))
    )
  })

  it('REJECTS a section for an option that was never merged', () => {
    // The invented name must be one no option has claimed in
    // experimentalDefaults. It was distantShapeDetailFade until that option
    // merged for real
    const invented = [
      markdown,
      '## `inventedNeverMergedOption`',
      '',
      '### Cost',
      '',
      'It generates the weather, as the name promises.',
      ''
    ].join('\n')
    expect(optionSections(invented).map(s => s.option)).toContain(
      'inventedNeverMergedOption'
    )
    expect(Object.keys(experimentalDefaults)).not.toContain(
      'inventedNeverMergedOption'
    )
  })
})

const markdown = readFileSync(DOC, 'utf8')

/** The guide with one option's table row and whole section removed */
function markdown_without(option: string): string {
  const withoutSection = markdown
    .split('\n')
    .filter(line => !line.includes(`\`${option}\``))
    .join('\n')
  return withoutSection
}
