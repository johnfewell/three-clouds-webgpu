// The public package ships this prose. The internal tracker, the agent fleet and
// the dispatch layer are none of its business, and a public reader cannot act
// on a task id, an agent name or an absolute path from another machine. This
// guard is the only thing that notices when one creeps back in: the export
// script fails on code comments and test names, but nothing scanned markdown

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { decide } from '../scripts/release/public-manifest.mjs'
import { log } from './helpers/log'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * A tracker id, assembled rather than written out.
 *
 * The public exporter strips these out of prose, so an id spelled in full
 * arrives in the exported copy of THIS file already gone, and the canaries below
 * would assert nothing there. Assembled, the same case runs in both trees.
 */
const ref = (body: string): string => `cw-${body}`
const trackerNoun = 'bea' + 'd'

/**
 * The prose a public reader can REACH, and the internal documents it cannot.
 *
 * Exported, as seeds: what a user reads to install, use or understand the port.
 * ADRs are listed directory-wide rather than file by file so a new ADR is
 * covered the day it is added, which is the moment it would otherwise be
 * forgotten.
 *
 * Not the whole answer. The scan set is the transitive closure of markdown
 * links FROM these seeds, because a linked document is as public as the one
 * that links it. Two files the README cites as the evidence for its headline
 * numbers were outside a static list and stayed dirty while the list was
 * green. The walk is what closes that class rather than those two instances.
 *
 * Reachability is not the same as shipping. A document nothing links is still
 * exported if the manifest keeps it, so the seeds carry the top-level files a
 * reader opens without being led there, and what falls outside both is named
 * in the closing comment rather than assumed clean.
 */
const PUBLIC_PROSE = [
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'WEBGPU.md',
  'docs/MIGRATION.md',
  'docs/BENCHMARKS.md',
  'docs/RELEASE.md',
  'docs/design/cloud-types.md',
  'core/CPU-STATE.md',
  'docs/PERFORMANCE-PROFILING.md',
  'docs/ATMOSPHERE-COST-STUDY.md',
  'test/README.md',
  'scripts/port-gates/README.md',
  'examples/parity/README.md',
  'examples/parity/e2e/README.md',
  'examples/r3f/README.md',
  'examples/storybook/README.md'
]

/**
 * What the public tree actually ships, which is the manifest's decision.
 *
 * These lists name files, and the exporter decides which of them exist, so
 * reading an excluded one fails on ENOENT rather than on prose. It still runs
 * over the private tree unchanged, where every entry is present.
 */
const shipped = (paths: string[]): string[] =>
  paths.filter(path => decide(path).keep)

const INTERNAL_PROSE = [
  'docs/MAINTAINER_REVIEW.md',
  'docs/UPSTREAM_PR.md',
  'docs/enumeration-method.md',
  // Indexed by the internal change ids it was produced against. The README
  // states the figures instead of linking here, and BENCHMARKS.md has the method
  'perf/FINAL-2026-09-24.md'
]

function adrProse(): string[] {
  const dir = resolve(ROOT, 'docs/adr')
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => `docs/adr/${name}`)
}

/**
 * Every way this repository names its own internal process. Each pattern is a
 * thing a public reader cannot resolve: an id with no lookup, a name with no
 * roster, a path from another machine, or the word that introduces all three.
 */
const INTERNAL_PATTERNS: { name: string; pattern: RegExp }[] = [
  // `cw-`+suffix, `br-`+suffix and the phase-scoped `pN-`+suffix task ids
  {
    name: 'tracker id',
    pattern: /\b(?:cw|br|p[0-4])-[a-z0-9][a-z0-9.-]*/i
  },
  // the word that introduces a tracker id, and the plural agent fleet
  { name: 'tracker noun', pattern: /\bbeads?\b/i },
  // Not the bare word "dispatch": "a compute dispatch" and "the dispatch covers
  // 8x8 lanes" are core vocabulary here, so matching it flagged the GPU sense
  { name: 'agent-fleet words', pattern: /\b(?:fleet|dispatcher)\b/i },
  // "Phase 3's 3.2a shadow" names work a public reader cannot follow. As a
  // HEADING it is legitimate: the ladder groups its tables under `## Phase 0`
  // to `## Phase 4`. parity/results/0 and /1 do it in a sentence, out of the set
  { name: 'internal phase', pattern: /^\s*[^#].*\bPhase [0-4]\b/ },
  // agent identities from the coordination layer, and its message ids
  { name: 'agent name', pattern: /\b(?:cc|mb|oc)_\d\b/ },
  { name: 'agent mail', pattern: /\b(?:mails?|inbox|reservation)\s+#?\d/i },
  // absolute paths from the machine this was written on
  { name: 'absolute path', pattern: /(?:^|[\s(`'"])(?:\/Users\/|~\/code\/)/ },
  // the internal operating manual, by name or by section reference
  { name: 'AGENTS.md', pattern: /\bAGENTS\.md\b/ },
  // Pull-request numbers in THIS repository are process, and the public repo
  // has one commit and no pull requests. The lookbehind keeps an upstream
  // issue reference such as [three-geospatial#111] out of it: that one resolves
  { name: 'pull-request number', pattern: /(?<![\w-])#\d{2,4}\b/ }
]

/**
 * The relative links in one file that do not resolve. Absolute and protocol
 * links are skipped, and a directory counts: `[the ADRs](docs/adr/)` is as
 * valid as a link to a file.
 */
/** The relative links in one file, as { target, fragment } pairs */
function relativeLinksIn(
  path: string
): { target: string; fragment: string | null }[] {
  const text = readFileSync(resolve(ROOT, path), 'utf8')
  const links: { target: string; fragment: string | null }[] = []
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const whole = match[1]!
    const [target, fragment] = whole.split('#', 2)
    if (/^[a-z]+:/i.test(target!)) continue
    links.push({ target: target!, fragment: fragment ?? null })
  }
  return links
}

/**
 * GitHub's heading anchor for a heading line: lowercased, punctuation dropped,
 * inner spaces to hyphens. A duplicated heading gets a `-1` suffix there, which
 * this does not model, and the caller only asks whether the fragment is
 * present.
 */
function anchorsOf(path: string): Set<string> {
  const text = readFileSync(resolve(ROOT, path), 'utf8')
  const anchors = new Set<string>()
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{1,6} +(.+?)\s*$/)
    if (heading == null) continue
    anchors.add(
      heading[1]!
        .toLowerCase()
        .replace(/[^\p{L}\p{N} -]/gu, '')
        .trim()
        .replace(/ /g, '-')
    )
  }
  return anchors
}

/**
 * The relative links in one file that a reader cannot follow: the target does
 * not exist, or it exists and the FRAGMENT names no heading in it. Validating
 * the fragment is the point: GitHub renders a missing one silently, so a dead
 * anchor reads as a page that loads fine.
 */
function brokenLinksIn(path: string): string[] {
  const broken: string[] = []
  for (const { target, fragment } of relativeLinksIn(path)) {
    const absolute = resolve(ROOT, join(join(ROOT, path, '..'), target))
    let isDirectory = false
    try {
      isDirectory = statSync(absolute).isDirectory()
    } catch {
      broken.push(`${path} -> ${target}`)
      continue
    }
    if (isDirectory || fragment == null) continue
    if (!anchorsOf(absolute).has(fragment)) {
      broken.push(`${path} -> ${target}#${fragment}`)
    }
  }
  return broken
}

function hitsIn(
  path: string
): { path: string; name: string; line: number; text: string }[] {
  const lines = readFileSync(resolve(ROOT, path), 'utf8').split('\n')
  const found: { path: string; name: string; line: number; text: string }[] = []
  lines.forEach((text, i) => {
    for (const { name, pattern } of INTERNAL_PATTERNS) {
      if (pattern.test(text)) {
        found.push({ path, name, line: i + 1, text: text.trim() })
      }
    }
  })
  return found
}

/**
 * Vendored and generated trees. A link that lands in one of these is not public
 * prose: the upstream sources under `reference/` are read-only reference copies
 * and the build output is not documentation at all.
 */
const NOT_PUBLIC = ['reference/', 'node_modules/', 'build/', 'types/', 'dist/']

const seeds = [...PUBLIC_PROSE, ...adrProse()]

/** A repo-relative path, so the scanned set is stable and comparable in logs */
function repoRelative(absolute: string): string {
  return absolute.slice(ROOT.length + 1)
}

/**
 * Every markdown file a public reader can reach from the seeds by following
 * links, excluding the vendored trees and the documents marked internal. A
 * linked document is as public as the one linking it, which is why this is a
 * walk and not the seed list.
 */
function reachableProse(): string[] {
  const seen = new Set<string>()
  const queue = [...seeds]
  while (queue.length > 0) {
    const path = queue.pop()!
    if (seen.has(path) || !existsSync(resolve(ROOT, path))) continue
    seen.add(path)
    for (const { target } of relativeLinksIn(path)) {
      const next = repoRelative(
        resolve(ROOT, join(join(ROOT, path, '..'), target))
      )
      if (!next.endsWith('.md')) continue
      if (NOT_PUBLIC.some(prefix => next.startsWith(prefix))) continue
      if (!seen.has(next)) queue.push(next)
    }
  }
  return [...seen].filter(path => !INTERNAL_PROSE.includes(path)).sort()
}

const exported = reachableProse()

describe('the prose the public tree ships names no internal process', () => {
  it('every file in the exported set exists', () => {
    log('public-prose-files', {
      listed: PUBLIC_PROSE.length,
      adr: adrProse().length,
      total: exported.length
    })
    expect(exported.length).toBeGreaterThan(PUBLIC_PROSE.length)
    for (const path of exported) {
      expect(
        readFileSync(resolve(ROOT, path), 'utf8').length,
        `${path} is non-empty`
      ).toBeGreaterThan(0)
    }
  })

  it('carries no tracker id, agent name, dispatch word or foreign path', () => {
    const hits = exported.flatMap(hitsIn)

    log('public-prose-hits', {
      filesScanned: exported.length,
      hits: hits.length
    })
    log(
      'public-prose-hits-detail',
      hits.map(hit => ({
        file: hit.path,
        line: hit.line,
        kind: hit.name,
        text: hit.text.slice(0, 60)
      }))
    )

    expect(
      hits.map(hit => `${hit.path}:${hit.line} ${hit.name}: ${hit.text}`),
      'the public prose must name no internal process'
    ).toEqual([])
  })

  it('marks the internal documents as internal', () => {
    const kept = shipped(INTERNAL_PROSE)
    log('internal-prose-files', {
      listed: INTERNAL_PROSE.length,
      shipped: kept.length
    })
    expect(INTERNAL_PROSE.length).toBeGreaterThan(0)
    for (const path of kept) {
      const text = readFileSync(resolve(ROOT, path), 'utf8')
      expect(
        text.slice(0, 400),
        `${path} says at the top that it is internal`
      ).toContain('Internal document')
    }
  })

  it('the exported prose links only paths the exported tree has', () => {
    const missing = shipped(PUBLIC_PROSE).flatMap(brokenLinksIn)
    log('public-prose-links', { broken: missing.length, detail: missing })
    expect(
      missing,
      'every relative link in the exported prose resolves'
    ).toEqual([])
  })
})

// A guard is only worth its lines if it FAILS on the thing it exists to catch,
// so each pattern is shown rejecting the real shape it was written for. These
// are the strings that were actually in the tree when this guard was added
describe('the internal-process patterns reject what they were written for', () => {
  const CASES: [string, string][] = [
    ['tracker id', 'Fixed under ' + ref('p00s') + ': WGSL is strict'],
    ['tracker id', 'the operator decision (' + ref('wbnn') + ' matrix)'],
    ['tracker id', 'per the epic ' + ref('dlr1')],
    ['tracker noun', `recorded as a ${trackerNoun} rather than fixed here`],
    ['tracker noun', `pending ${trackerNoun}s`],
    ['agent-fleet words', "took the fleet's typecheck down"],
    ['agent-fleet words', 'a dispatcher ruling, fallback (b)'],
    ['agent name', 'the oc_6 reviewer agreed'],
    ['agent mail', 'see mails #1991 and #1992'],
    ['absolute path', 'recorded at `~/code/dispatch/bluenoise/SUMMARY.md`'],
    // Assembled, because the exporter rewrites a machine path and this canary
    // IS one: written out, the public tree's own copy of this guard would stop
    // matching it
    ['absolute path', `/Us${'ers'}/fewell/code/clouds`],
    ['AGENTS.md', 'see AGENTS.md §5 first'],
    ['pull-request number', 're-captured after #167'],
    ['pull-request number', 'landing as part of #194'],
    ['internal phase', "where Phase 3's 3.2a shadow multiplies the term"],
    ['internal phase', 'runs all four checks from Phase 0 and in CI']
  ]

  it('every recorded case matches exactly one pattern', () => {
    log(
      'internal-pattern-cases',
      CASES.map(([expected, text]) => {
        const matched = INTERNAL_PATTERNS.filter(({ pattern }) =>
          pattern.test(text)
        ).map(({ name }) => name)
        return { expected, matched: matched.join(','), text }
      })
    )

    for (const [expected, text] of CASES) {
      const matched = INTERNAL_PATTERNS.filter(({ pattern }) =>
        pattern.test(text)
      )
      expect(
        matched.some(({ name }) => name === expected),
        `${JSON.stringify(text)} is caught as "${expected}"`
      ).toBe(true)
    }
  })

  // The complement matters as much: a guard that also fires on ordinary prose
  // gets disabled, and then it guards nothing
  it('does not fire on ordinary technical prose', () => {
    const ALLOWED = [
      'The march binds the scene camera explicitly',
      'Every fix in the shadow path was invisible to the ladder',
      'see [three-geospatial#111](https://github.com/takram-design-engineering/three-geospatial/issues/111)',
      '`p0` and `p4` are not identifiers on their own',
      'A compute dispatch instead of a fragment pass, plus the barrier',
      'Each dispatch covers 8x8 lanes of the resolve target',
      '## Phase 4',
      'The `CLOUD_SHAPE_TEXTURE_SIZE` constant is 128',
      'src/march/primaryMarch.ts:531 holds the bisection',
      'ADR-011 Amendment 3 gates SSIM at the ladder reference L'
    ]
    log(
      'internal-pattern-false-positives',
      ALLOWED.map(text => ({
        text,
        matched: INTERNAL_PATTERNS.filter(({ pattern }) => pattern.test(text))
          .map(({ name }) => name)
          .join(',')
      }))
    )
    for (const text of ALLOWED) {
      expect(
        INTERNAL_PATTERNS.filter(({ pattern }) => pattern.test(text)),
        `${JSON.stringify(text)} must not look like internal process`
      ).toEqual([])
    }
  })
})
