#!/usr/bin/env node
// proves a change touches comments and whitespace only. For every
// changed .ts/.tsx/.mts/.js/.mjs file, the token stream (comments, JSDoc and
// whitespace removed) must be identical at the base ref and in the work tree
//
// Usage: node scripts/comment-only-check.mjs <base-ref> [--allow <path>]...
// --allow names a file whose code is meant to change (the PR says why)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const CODE = /\.(?:[mc]?ts|tsx|[mc]?js)$/

function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (/\.[mc]?ts$/.test(fileName)) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

// Leaf tokens from the parse tree, so template literals and regexes are
// tokenised the way the compiler sees them. JSDoc nodes are skipped
export function tokenStream(text, fileName) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName)
  )
  const tokens = []
  const visit = node => {
    const kind = node.kind
    const jsdoc =
      kind >= ts.SyntaxKind.FirstJSDocNode &&
      kind <= ts.SyntaxKind.LastJSDocNode
    if (jsdoc) return
    if (node.kind <= ts.SyntaxKind.LastToken || node.getChildCount() === 0) {
      tokens.push(`${node.kind}:${node.getText(source)}`)
      return
    }
    for (const child of node.getChildren(source)) visit(child)
  }
  visit(source)
  return tokens
}

// First differing token, or null when the two texts are the same code
export function firstCodeDifference(before, after, fileName) {
  const a = tokenStream(before, fileName)
  const b = tokenStream(after, fileName)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { index: i, before: a[i], after: b[i] }
  }
  return null
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

export function checkCommentOnly(cwd, base, allow = []) {
  const changed = git(cwd, ['diff', '--name-status', '--no-renames', base])
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'))
    .filter(([, path]) => CODE.test(path) && !allow.includes(path))
  const failures = []
  for (const [status, path] of changed) {
    if (status !== 'M') {
      failures.push({ path, reason: `status ${status}, not a modification` })
      continue
    }
    const before = git(cwd, ['show', `${base}:${path}`])
    const full = join(cwd, path)
    const after = existsSync(full) ? readFileSync(full, 'utf8') : ''
    const diff = firstCodeDifference(before, after, path)
    if (diff) failures.push({ path, reason: JSON.stringify(diff) })
  }
  return { checked: changed.length, failures }
}

function main(argv) {
  const [base, ...rest] = argv
  if (!base) {
    console.error(
      'usage: comment-only-check.mjs <base-ref> [--allow <path>]...'
    )
    return 2
  }
  const allow = rest.filter((_, i) => rest[i - 1] === '--allow')
  const { checked, failures } = checkCommentOnly(process.cwd(), base, allow)
  // Zero inputs is a failed measurement, not a pass
  if (checked === 0) {
    console.error(`REFUSING: no changed code files against ${base}`)
    return 1
  }
  for (const f of failures) console.error(`CODE CHANGED ${f.path}: ${f.reason}`)
  console.log(
    `[comment-only] ${checked} files checked, ${failures.length} with code changes` +
      (allow.length ? `, ${allow.length} allowed: ${allow.join(', ')}` : '')
  )
  return failures.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2))
}
