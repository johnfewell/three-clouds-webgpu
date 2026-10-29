/**
 * Cyclomatic-style complexity for shader logic, per function.
 *
 * Node scripts/port-gates/decision-points.mjs <dir> [--max N]
 *
 * Two modes by file extension:
 *
 * .glsl .frag .vert GLSL: 1 + if / for / while / do / case / ?: / && / || per
 * top-level function. Preprocessor conditionals are reported separately — they
 * are compile-time variants. .ts .js .mjs TSL: 1 + If( / .ElseIf( / .Else( /
 * Loop( / select( / cond( / .and( / .or( / Switch( / .Case( per shader function
 * body, plus JS if / for / while / ?: / && / || inside it. Graph-time JS
 * branching (the port's replacement for #ifdef) is what oxlint's `complexity`
 * rule sees; this counts what ends up in the shader.
 *
 * A shader function is any of these call forms with an ARROW callback:
 *
 * Fn(() => { ... }) Fn(([a, b]) => { ... }) Fn<[Node]>(([a]) => { ... }) Fn(():
 * Node<'vec3'> => { ... }) FnVar((a: Node, b: Node) => { ... }) FnVar((a) =>
 * (builder) => { ... }) FnLayout({ ... })(([a], builder) => { ... }) FnLayout({
 * ... })(([a]) => a.mul(2)) (expression bodies are measured too)
 *
 * (`Fn` from three/tsl; `FnVar` / `FnLayout` from @takram/three-geospatial —
 * the upstream house style for typed TSL functions.) Generic arguments, typed
 * parameters, a return-type annotation, the curried `(args) => (builder) =>`
 * form and expression bodies are all recognised; the measured body is the
 * innermost block, or the expression up to the call's closing parenthesis.
 *
 * Two structural checks close the blind spots of the counter (ADR-010), both
 * fatal when --max is given:
 *
 * Unmeasured Fn a Fn / FnVar / FnLayout call whose callback body is not
 * lexically there: `Fn(function () { … })`, `Fn(helper)`, or a `FnLayout({ ...
 * })` stored instead of called inline. Write the arrow callback inline. flow
 * outside Fn TSL control flow (If( / Loop( / select( / Switch( / …) that is not
 * lexically inside any measured body — shader logic assembled outside a Fn (in
 * a node's setup(), a plain helper, module scope) evades the gate. Move it into
 * a Fn. The check is lexical, not dynamic: a plain arrow helper that emits If(
 * and is only ever called from inside a Fn still fails — make the helper a Fn
 * too.
 *
 * A Fn nested inside a measured body counts toward that body (conservative).
 * Strings and comments are stripped before counting.
 *
 * Baseline, @takram/three-clouds 0.7.6 GLSL: max 12 (clouds.frag marchClouds),
 * 87 of 94 functions at 1–5. Lizard reports 26 for main() because it also
 * counts the 17 preprocessor conditionals inside it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const root = args.find(a => !a.startsWith('--'))
const maxIdx = args.indexOf('--max')
const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : Infinity
if (!root) {
  console.error('usage: decision-points.mjs <dir> [--max N]')
  process.exit(2)
}

const files = []
const walk = d => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (f === 'node_modules') continue
    if (statSync(p).isDirectory()) walk(p)
    else if (
      /\.(glsl|frag|vert|ts|js|mjs)$/.test(f) &&
      !/\.(test|spec|d)\.ts$/.test(f)
    )
      files.push(p)
  }
}
walk(root)

const strip = s =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\\n])*'/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\\n])*"/g, m => m.replace(/[^\n]/g, ' '))

const countGlsl = body =>
  0 +
  (body.match(/\bif\s*\(/g) || []).length +
  (body.match(/\b(for|while)\s*\(/g) || []).length +
  (body.match(/\bdo\s*\{/g) || []).length +
  (body.match(/\bcase\b/g) || []).length +
  (body.match(/\?/g) || []).length +
  (body.match(/&&|\|\|/g) || []).length

const TSL_FLOW =
  /\bIf\s*\(|\.ElseIf\s*\(|\.Else\s*\(|\bLoop\s*\(|\b(?:select|cond)\s*\(|\.(?:and|or)\s*\(|\bSwitch\s*\(|\.Case\s*\(/g
const countTsl = body => countGlsl(body) + (body.match(TSL_FLOW) || []).length

// index just past the matching close bracket; `start` is just past the open one
const bodyFrom = (src, start, open = '{', close = '}') => {
  let i = start,
    depth = 1
  while (i < src.length && depth > 0) {
    if (src[i] === open) depth++
    else if (src[i] === close) depth--
    i++
  }
  return [src.slice(start, i - 1), i]
}
const ws = (src, i) => {
  while (i < src.length && /\s/.test(src[i])) i++
  return i
}
const ident = (src, i) => {
  const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 128))
  return m ? i + m[0].length : -1
}
// skip a `: ReturnType` annotation up to the `=>` at bracket depth 0
const skipReturnType = (src, i) => {
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if ('([{<'.includes(c)) depth++
    else if (')]}>'.includes(c)) {
      if (c === '>' && src[i - 1] === '=' && depth === 0) return i - 1
      depth--
    } else if (c === '=' && src[i + 1] === '>' && depth === 0) return i
  }
  return -1
}
// parse `(params) [: type] =>` or `param =>` at i; returns the index after `=>` or -1
const arrowHead = (src, i) => {
  i = ws(src, i)
  if (src[i] === '(') [, i] = bodyFrom(src, i + 1, '(', ')')
  else {
    i = ident(src, i)
    if (i < 0) return -1
  }
  i = ws(src, i)
  if (src[i] === ':') {
    i = skipReturnType(src, i + 1)
    if (i < 0) return -1
  }
  i = ws(src, i)
  return src.startsWith('=>', i) ? i + 2 : -1
}
const bindingName = (src, idx) => {
  const m = /(?:(?:const|let|var)\s+|this\.)([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
    src.slice(Math.max(0, idx - 200), idx)
  )
  return m ? m[1] : '(anonymous Fn)'
}

const rows = [],
  problems = []
for (const p of files) {
  const src = strip(readFileSync(p, 'utf8'))
  const rel = relative(root, p)
  const lineOf = idx => src.slice(0, idx).split('\n').length
  if (/\.(glsl|frag|vert)$/.test(p)) {
    const re = /^[ \t]*(?:[A-Za-z_]\w*\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/gm
    let m
    while ((m = re.exec(src))) {
      if (['if', 'for', 'while', 'switch', 'return'].includes(m[1])) continue
      const [body] = bodyFrom(src, m.index + m[0].length)
      const pp = (body.match(/^\s*#\s*(if|ifdef|ifndef|elif)\b/gm) || []).length
      rows.push({
        file: rel,
        line: lineOf(m.index),
        name: m[1],
        c: 1 + countGlsl(body),
        pp,
        kind: 'glsl'
      })
    }
    continue
  }
  const spans = []
  const inside = idx => spans.some(([a, b]) => idx > a && idx < b)
  const unmeasured = (idx, hint) =>
    problems.push({ file: rel, line: lineOf(idx), kind: 'unmeasured Fn', hint })
  const head = /\b(Fn|FnVar|FnLayout)\b/g
  let m
  while ((m = head.exec(src))) {
    const idx = m.index
    if (inside(idx)) continue
    let i = ws(src, idx + m[1].length)
    if (src[i] === '<')
      (([, i] = bodyFrom(src, i + 1, '<', '>')), (i = ws(src, i)))
    if (
      src[i] !== '(' ||
      /function\s+$/.test(src.slice(Math.max(0, idx - 16), idx))
    )
      continue // a type, an import or the helper's own definition, not a call
    if (m[1] === 'FnLayout') {
      ;[, i] = bodyFrom(src, i + 1, '(', ')')
      i = ws(src, i) // skip the layout object
      if (src[i] !== '(') {
        unmeasured(
          idx,
          'call the layout inline: FnLayout({ ... })(( args ) => ...)'
        )
        continue
      }
    }
    const [, callEnd] = bodyFrom(src, i + 1, '(', ')') // the whole callback argument
    let k = arrowHead(src, i + 1)
    if (k >= 0) {
      const k2 = ws(src, k)
      if (src[k2] !== '{') {
        const k3 = arrowHead(src, k2)
        if (k3 >= 0) k = k3
      }
    } // curried (args) => (builder) => …
    if (k < 0) {
      unmeasured(
        idx,
        'write the arrow callback inline: ' + m[1] + '(( args ) => ...)'
      )
      continue
    }
    k = ws(src, k)
    const body =
      src[k] === '{' ? bodyFrom(src, k + 1)[0] : src.slice(k, callEnd - 1) // block body, or the expression up to the call's `)`
    rows.push({
      file: rel,
      line: lineOf(idx),
      name: bindingName(src, idx),
      c: 1 + countTsl(body),
      pp: 0,
      kind: 'tsl'
    })
    spans.push([idx, callEnd])
    head.lastIndex = callEnd
  }
  // structural check 2: TSL control flow outside every measured body
  const flowRe = new RegExp(TSL_FLOW.source, 'g')
  while ((m = flowRe.exec(src))) {
    if (inside(m.index)) continue
    problems.push({
      file: rel,
      line: lineOf(m.index),
      kind: 'flow outside Fn',
      hint: m[0].trim() + ' is not inside a measured Fn body'
    })
  }
}

rows.sort((a, b) => b.c - a.c)
if (rows.length === 0 && problems.length === 0) {
  console.log('no shader functions found under', root)
  process.exit(0)
}
const over = rows.filter(r => r.c > max)
if (rows.length > 0) {
  console.log(
    `${rows.length} shader functions · max ${rows[0].c} (${rows[0].file}:${rows[0].line} ${rows[0].name})${Number.isFinite(max) ? ` · gate ${max} · ${over.length} over` : ''}`
  )
  for (const r of rows.slice(0, 15))
    console.log(
      String(r.c).padStart(4),
      r.kind === 'glsl' ? String(r.pp).padStart(3) + '#if' : '      ',
      (r.file + ':' + r.line).padEnd(44),
      r.name
    )
  const hist = {}
  for (const r of rows) {
    const b =
      r.c <= 5 ? '1-5' : r.c <= 10 ? '6-10' : r.c <= 15 ? '11-15' : '16+'
    hist[b] = (hist[b] || 0) + 1
  }
  console.log('histogram', JSON.stringify(hist))
}
if (problems.length) {
  console.log(
    `${problems.length} structural problem(s)${Number.isFinite(max) ? ' (fatal)' : ''}:`
  )
  for (const q of problems)
    console.log(
      '    ',
      (q.file + ':' + q.line).padEnd(44),
      q.kind.padEnd(18),
      q.hint
    )
}
process.exit(over.length || (Number.isFinite(max) && problems.length) ? 1 : 0)
