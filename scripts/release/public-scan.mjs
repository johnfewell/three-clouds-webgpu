import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import ts from 'typescript'

import { BINARY, DOTFILES, TEXT } from './public-formats.mjs'

const LIMITS = { bytes: 128 * 1024 * 1024, files: 10000, depth: 3 }
const ARCHIVE = /\.(?:tgz|tar\.gz)$/i
const MARKERS = [
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['private-history', /\b(?:commit|main|correction)\s+`?[a-f0-9]{7,40}\b/g],
  [
    'private-reference',
    /\bdocs\/(?:UPSTREAM_PR|PERFORMANCE-PROFILING|MAINTAINER_REVIEW)\.md\b/g
  ],
  ['machine-path', /\/(?:Users|home|private\/tmp)\/[^\s"'<>]+/g],
  [
    'machine-name',
    /\b(?:[\w-]*Mac-min[i][\w-]*|[\w-]*MacBoo[k][\w-]*|(?!env\.local\b)[\w-]+\.local)\b/gi
  ],
  ['tracker', /\bcw-[a-z0-9][a-z0-9.-]*|\bbea[d]s?\b/gi],
  [
    'private-reference',
    /\b(?:PRs?|issues?|pull requests?)\s*#\d+\b|\bAGENTS\.md\b/g
  ],
  [
    'maintenance',
    /\b(?:nt[m]|agent mai[l]|briefs-102[5]|clouds--fork-[\w-]+|three-clouds-webgpu-de[v]|three-ocean-wave[s])\b/gi
  ],
  [
    'credential',
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|nfp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})\b/g
  ],
  [
    'credential',
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  ],
  ['credential-file', /(?:^|\/)\.env(?:$|[./-])/g]
]

export const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function requireValue(condition, message) {
  if (!condition) {
    const error = new Error(message)
    error.name = 'PublicationRefusal'
    throw error
  }
}

function safeMember(path) {
  requireValue(
    path !== '' &&
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some(part => part === '..' || part === '.git'),
    'Refusing unsafe archive member'
  )
}

function field(header, start, length) {
  return header
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/s, '')
}

function extendedPath(bytes) {
  const text = bytes.toString('utf8')
  const fields = new Map(
    text
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const entry = line.slice(line.indexOf(' ') + 1)
        const equal = entry.indexOf('=')
        return [entry.slice(0, equal), entry.slice(equal + 1)]
      })
  )
  requireValue(
    !fields.has('linkpath') && !fields.has('size'),
    'Refusing archive metadata override'
  )
  return fields.get('path')
}

export function archiveMembers(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: LIMITS.bytes })
  const members = []
  const names = new Set()
  let nextPath
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) {
      requireValue(
        tar.subarray(offset).every(value => value === 0),
        'Refusing trailing archive payload'
      )
      break
    }
    const expectedChecksum = Number.parseInt(field(header, 148, 8).trim(), 8)
    const checksum = header.reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0
    )
    requireValue(
      expectedChecksum === checksum,
      'Refusing corrupt archive header'
    )
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8)
    requireValue(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        offset + 512 + size <= tar.length,
      'Refusing truncated archive member'
    )
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    const kind = field(header, 156, 1)
    if (kind === 'x') {
      const metadataName = field(header, 0, 100)
      safeMember(metadataName)
      members.push({
        path: `${metadataName}.metadata-${offset}.bin`,
        bytes: body
      })
      requireValue(
        members.length <= LIMITS.files,
        'Refusing excessive archive metadata'
      )
      nextPath = extendedPath(body)
      continue
    }
    const prefix = field(header, 345, 155)
    const path =
      nextPath ?? [prefix, field(header, 0, 100)].filter(Boolean).join('/')
    nextPath = undefined
    safeMember(path)
    if (kind === '5') continue
    requireValue(
      kind === '' || kind === '0',
      'Refusing non-regular archive member'
    )
    requireValue(!names.has(path), 'Refusing duplicate archive member')
    names.add(path)
    members.push({ path, bytes: body })
    requireValue(
      members.length <= LIMITS.files,
      'Refusing excessive archive members'
    )
  }
  requireValue(members.length > 0, 'Refusing empty archive')
  return members
}

function textParts(path, bytes) {
  const name = basename(path)
  requireValue(
    TEXT.test(path) ||
      /^\.env(?:$|[.-])/.test(name) ||
      DOTFILES.has(name) ||
      !name.includes('.'),
    `Refusing unclassified publication format: ${safePath(path)}`
  )
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!/\.(?:json|map)$/.test(path)) return [text]
  const values = []
  function collect(value) {
    if (typeof value === 'string') values.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        values.push(key)
        collect(item)
      }
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    if (!/^tsconfig(?:\.[^/]+)?\.json$/.test(basename(path))) throw error
    const config = ts.parseConfigFileTextToJson(path, text)
    requireValue(!config.error, 'Refusing invalid configuration JSON')
    parsed = config.config
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      text
    )
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      )
        values.push(scanner.getTokenText())
    }
  }
  collect(parsed)
  return values
}

function inspectText(text, entry, hits, publicToken, filename = false) {
  for (const [kind, pattern] of MARKERS) {
    if (kind === 'credential-file' && !filename) continue
    for (const found of text.matchAll(
      new RegExp(pattern.source, pattern.flags)
    )) {
      if (kind === 'credential' && publicToken && found[0] === publicToken)
        continue
      if (
        kind === 'machine-path' &&
        /^\/(?:Users|home)\/(?:somebody|example)(?:\/|$)/.test(found[0])
      )
        continue
      hits.push({
        surface: entry.surface,
        path: entry.path,
        class: kind,
        line: text.slice(0, found.index).split('\n').length,
        sha256: digest(found[0]),
        value: found[0]
      })
    }
  }
}

function inspectEntry(entry, depth, state, options) {
  const { hits, binaries, budget } = state
  requireValue(depth <= LIMITS.depth, 'Refusing archive nesting depth')
  budget.files++
  budget.bytes += entry.bytes.length
  requireValue(
    budget.files <= LIMITS.files && budget.bytes <= LIMITS.bytes,
    'Refusing scan budget overflow'
  )
  inspectText(entry.path, entry, hits, options.publicToken, true)
  if (ARCHIVE.test(entry.path)) {
    for (const member of archiveMembers(entry.bytes)) {
      inspectEntry(
        {
          ...member,
          surface: entry.surface,
          path: `${entry.path}!/${member.path}`
        },
        depth + 1,
        state,
        options
      )
    }
  } else if (BINARY.test(entry.path)) {
    binaries.push({
      path: entry.path,
      surface: entry.surface,
      sha256: digest(entry.bytes)
    })
    for (const found of entry.bytes
      .toString('latin1')
      .matchAll(/[\x20-\x7e]{8,}/g)) {
      inspectText(found[0], entry, hits, options.publicToken)
    }
  } else {
    for (const text of textParts(entry.path, entry.bytes))
      inspectText(text, entry, hits, options.publicToken)
  }
}

function reviewMatches(hits, allowlist) {
  const approved = new Set()
  const allowlistErrors = []
  for (const item of allowlist) {
    const valid =
      item.surface &&
      item.path &&
      item.match &&
      item.class &&
      item.reason &&
      item.approvedBy &&
      /^\d{4}-\d{2}-\d{2}$/.test(item.approvedAt ?? '') &&
      Number.isSafeInteger(item.count) &&
      item.count > 0 &&
      !item.class.startsWith('credential')
    const matches = hits.filter(
      hit =>
        hit.surface === item.surface &&
        hit.path === item.path &&
        hit.class === item.class &&
        hit.value === item.match
    )
    if (
      !valid ||
      matches.length !== item.count ||
      matches.some(hit => approved.has(hit))
    ) {
      allowlistErrors.push({
        path: item.path,
        class: item.class,
        expected: item.count,
        actual: matches.length
      })
    } else matches.forEach(hit => approved.add(hit))
  }
  return { approved, allowlistErrors }
}

function safePath(path) {
  for (const [kind, pattern] of MARKERS) {
    if (kind === 'credential')
      path = path.replace(
        new RegExp(pattern.source, pattern.flags),
        '<redacted>'
      )
  }
  return path
}

const redact = ({ value, ...hit }) => ({ ...hit, path: safePath(hit.path) })

export function scanPublicFiles(entries, allowlist = [], options = {}) {
  requireValue(entries.length > 0, 'Refusing scan over zero files')
  const state = { hits: [], binaries: [], budget: { files: 0, bytes: 0 } }
  entries.forEach(entry => inspectEntry(entry, 0, state, options))
  const { hits, binaries, budget } = state
  const { approved, allowlistErrors } = reviewMatches(hits, allowlist)
  const manifest = entries
    .map(entry => ({
      path: entry.path,
      surface: entry.surface,
      sha256: digest(entry.bytes)
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const surfaces = [...new Set(manifest.map(entry => entry.surface))]
  return {
    manifestSha256: digest(JSON.stringify(manifest)),
    surfaceManifests: Object.fromEntries(
      surfaces.map(surface => [
        surface,
        digest(
          JSON.stringify(manifest.filter(entry => entry.surface === surface))
        )
      ])
    ),
    files: budget.files,
    bytes: budget.bytes,
    binaries: binaries.map(file => ({ ...file, path: safePath(file.path) })),
    hits: hits.map(redact),
    unapproved: hits.filter(hit => !approved.has(hit)).map(redact),
    allowlistErrors: allowlistErrors.map(item => ({
      ...item,
      path: safePath(item.path ?? '')
    })),
    publicClientTokenSha256: options.publicToken
      ? digest(options.publicToken)
      : null
  }
}

export function publicationFiles(root, surface = 'tree') {
  const files = []
  function visit(path) {
    const stat = lstatSync(path)
    requireValue(!stat.isSymbolicLink(), 'Refusing symlink publication input')
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        requireValue(
          !['.git', 'node_modules'].includes(name),
          'Pass an explicit publication artifact, not a working checkout'
        )
        visit(join(path, name))
      }
    } else {
      requireValue(
        stat.isFile() && stat.size <= LIMITS.bytes,
        'Refusing non-regular or oversized publication input'
      )
      files.push({
        surface,
        path: relative(root, path) || basename(path),
        bytes: readFileSync(path)
      })
    }
  }
  visit(root)
  requireValue(files.length > 0, 'Refusing publication input with zero files')
  return files
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [root, surface = 'artifact', allowlistPath] = process.argv.slice(2)
    requireValue(
      root,
      'Usage: public-scan.mjs <artifact> [surface] [allowlist.json]'
    )
    const allowlist = allowlistPath
      ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
      : []
    const result = scanPublicFiles(
      publicationFiles(resolve(root), surface),
      allowlist,
      {
        publicToken:
          surface === 'pages' ? process.env.STORYBOOK_ION_API_TOKEN : undefined
      }
    )
    console.log(JSON.stringify(result, null, 2))
    if (result.unapproved.length || result.allowlistErrors.length)
      process.exitCode = 1
  } catch (error) {
    console.error(
      `Publication scan refused: ${error.code ?? (error.name === 'PublicationRefusal' ? error.message : error.name)}`
    )
    process.exitCode = 1
  }
}
