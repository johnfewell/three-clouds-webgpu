// Enumerate every Fn / FnVar / FnLayout call site under src/ and record, per
// site, whether a CPU twin test and a WGSL snapshot test cover it.
//
// The Fn-site parser is lifted from scripts/port-gates/decision-points.mjs so
// the enumeration agrees with the gate by construction (same definition of a
// measured body, same spans logic, same anonymous-name fallback).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.indexOf(name)
const asJson = flag('--json') >= 0
const bucketIdx = flag('--bucket')
const mdWanted = args.includes('--md')
// A tree root is the positional arg. `--src` overrides where the shader
// sources live, so a fixture directory can be audited without a whole repo
// shape around it; `--root` says where the TESTS live (default <root>/test).
const opt = name => {
  const i = flag(name)
  // `-1 + 1 === 0`, so `args[flag(x) + 1]` silently reads args[0] — the tree
  // root — when the flag is ABSENT. That made srcDir the repo root and sent
  // the walker into examples/*/node_modules until the path limit, so every
  // option must be gated on its index.
  return i >= 0 ? args[i + 1] : undefined
}
const positional = args.filter((a, i) => !a.startsWith('--') && i < 2)
const ROOT =
  opt('--root') ?? positional[0] ?? join(import.meta.dirname, '..', '..')
const srcDir = opt('--src') ?? join(ROOT, 'src')
const testRoot = opt('--tests') ?? join(ROOT, 'test')
const onlyBuckets = (
  bucketIdx >= 0
    ? args[bucketIdx + 1]
    : 'neither,twin-only,snap-only,cross-module'
).split(',')

const files = []
const walk = d => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (f === 'node_modules' || f === 'dist' || f === 'build') continue
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|js|mjs)$/.test(f) && !/\.(test|spec|d)\.ts$/.test(f))
      files.push(p)
  }
}
walk(srcDir)

const strip = s =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\\n])*'/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\\n])*"/g, m => m.replace(/[^\n]/g, ' '))

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
// The binding a Fn is assigned to, and whether that DECLARATION is exported.
// Anchored on the declaration keyword immediately before the call, because the
// earlier 400-character lookback for `export` crossed the previous statement:
// `hgTSL` in phaseFunction.ts is module-private, but the preceding
// `export const phaseFunctionTSL` was still inside the window, so the site
// read as an exported entry point and the audit asked for a test on a symbol
// no test can import.
const bindingOf = (src, idx) => {
  const m =
    /(?:(export)\s+)?(?:(?:const|let|var)\s+|this\.)([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
      src.slice(Math.max(0, idx - 200), idx)
    )
  return m ? { name: m[2], exported: m[1] === 'export' } : null
}
const bindingName = (src, idx) => bindingOf(src, idx)?.name ?? null

const sites = []
const exportedByFile = {}
for (const p of files) {
  const src = strip(readFileSync(p, 'utf8'))
  const rel = relative(srcDir, p)
  const lineOf = idx => src.slice(0, idx).split('\n').length
  const spans = []
  const inside = idx => spans.some(([a, b]) => idx > a && idx < b)
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
      continue
    if (m[1] === 'FnLayout') {
      ;[, i] = bodyFrom(src, i + 1, '(', ')')
      i = ws(src, i)
      if (src[i] !== '(') continue
    }
    const [, callEnd] = bodyFrom(src, i + 1, '(', ')')
    let k = arrowHead(src, i + 1)
    if (k >= 0) {
      const k2 = ws(src, k)
      if (src[k2] !== '{') {
        const k3 = arrowHead(src, k2)
        if (k3 >= 0) k = k3
      }
    }
    if (k < 0) continue
    k = ws(src, k)
    const body =
      src[k] === '{' ? bodyFrom(src, k + 1)[0] : src.slice(k, callEnd - 1)
    const bind = bindingOf(src, idx)
    sites.push({
      file: rel,
      line: lineOf(idx),
      kind: m[1],
      name: bind?.name ?? '(anonymous)',
      exported: bind?.exported ?? false,
      body
    })
    spans.push([idx, callEnd])
    head.lastIndex = callEnd
  }
  exportedByFile[rel] = {
    fnSites: sites.filter(s => s.file === rel),
    raw: readFileSync(p, 'utf8')
  }
}

// index test files
const testFiles = []
const walkTests = d => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walkTests(p)
    else if (/\.(test|spec)\.ts$/.test(f)) testFiles.push(p)
  }
}
walkTests(srcDir)
if (existsSync(testRoot)) walkTests(testRoot)

const info = testFiles.map(p => {
  const src = readFileSync(p, 'utf8')
  const relToSrc = relative(srcDir, p)
  return {
    path: p,
    rel: relative(ROOT, p),
    dir: dirname(p),
    src,
    usesWGSL: /compileWGSL/.test(src),
    // static `from './x'` OR dynamic `await import('./x')`
    imports: new Set(
      [
        ...[...src.matchAll(/\bfrom\s+'(\.[^']+)'/g)].map(m => m[1]),
        ...[...src.matchAll(/\bimport\(\s*'(\.[^']+)'\s*\)/g)].map(m => m[1])
      ].map(s => s.replace(/\.js$/, ''))
    ),
    localFns: [
      ...src.matchAll(
        /(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>)/g
      )
    ].map(m => m[1] ?? m[2])
  }
})

// does this test resolve to that module?
const resolves = (test, moduleRel) => {
  const base = moduleRel.replace(/\.ts$/, '')
  for (const imp of test.imports) {
    if (join(test.dir, imp).endsWith(base)) return true
  }
  return false
}

// Is this function body plain JS (a CPU mirror) or TSL (node graph)?
//
// Two earlier versions of this predicate were wrong in opposite directions, so
// it is worth writing down why each half looks the way it does.
//
// BARE CALLS. Only names that cannot appear in a CPU mirror are listed.
// `exp`, `pow`, `min`, `max`, `abs`, `sqrt`, `clamp`, `step`, `mix` are TSL
// nodes AND plain JS Math calls; listing them made `cpuPowderTerm`'s
// `Math.exp(...)` read as TSL and every twin look absent.
//
// METHOD CALLS. A method name alone is not evidence either: `Math.exp(` is a
// method call on a plain object. The receiver guard excludes the JS globals,
// and the rest of the list is node methods with no JS counterpart. The guard is
// a lookbehind on the RECEIVER, so `Math.exp(` is rejected while a node's
// `.mul(` is accepted.
const JS_GLOBALS =
  'Math|JSON|Object|Array|Number|String|Boolean|Date|Map|Set|Promise|console|globalThis|performance|process'
const BARE_CALL =
  '(?<!\\w)(?:Fn|Loop|If|Switch|texture|textureLoad|textureStore|select|cond|transformNormalToView|viewportUV|instanceIndex|vertexIndex|dFdx|dFdy|fwidth)(?=\\s*\\()'
const NODE_METHOD =
  'toVar|toConst|mul|add|div|sub|oneMinus|negate|saturate|sample|sampleLevel|load|xyz|xy|yzw|xzy|wzyx|assign|addAssign|mulAssign|subAssign|divAssign|normalizeSafe|element|toReadOnly'
const METHOD_CALL = `(?<![\\w.$])(?!(?:${JS_GLOBALS})[.\\w])[A-Za-z_$][\\w$]*[.](?:${NODE_METHOD})\\b`
const TSL_MARKERS = new RegExp(`${BARE_CALL}|${METHOD_CALL}`)

// test/helpers/*Reference.ts: map `<fn>Reference` -> the spec file that uses it
const referenceHelpers = []
// Scan the helpers DIRECTORY, not `testFiles`: that index holds only
// *.test.ts, so `perlinReference.ts` was never a candidate and every
// `<name>Reference` twin read as absent.
{
  const helperDir = join(testRoot, 'helpers')
  const cands = []
  const walkH = d => {
    for (const f of readdirSync(d)) {
      if (f === 'node_modules') continue
      const p = join(d, f)
      if (statSync(p).isDirectory()) walkH(p)
      else cands.push(p)
    }
  }
  if (existsSync(helperDir)) walkH(helperDir)
  for (const p of cands) {
    const src = readFileSync(p, 'utf8')
    if (!/Reference\.ts$/.test(p)) continue
    for (const m of src.matchAll(
      /export\s+(?:function|const)\s+([A-Za-z_$][\w$]*Reference)\b/g
    ))
      referenceHelpers.push([m[1], p])
  }
}

// Static call graph WITHIN a module: which exported Fn bodies mention which
// other exported Fn names. Needed so a snapshot test that compiles one entry
// point is not treated as evidence about every sibling it merely lives beside.
const callGraph = {}
for (const p of files) {
  const rel = relative(srcDir, p)
  const raw = readFileSync(p, 'utf8')
  // LOCAL bindings count as call-graph nodes as well as exported ones. A
  // module-private twin (`hgTSL`) is genuinely covered by a snapshot that
  // compiles the exported function that calls it, and without local nodes the
  // closure cannot see that.
  const names = [
    ...raw.matchAll(
      /(?:^|[\s;}])(?:export\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g
    )
  ].map(m => m[1])
  const src = strip(raw)
  // null prototype: an exported name like `constructor` or `toString` would
  // otherwise resolve to Object.prototype's member, which is a FUNCTION, and
  // `for (const n of g[cur])` then throws "function is not iterable"
  const graph = Object.create(null)
  for (const n of names) graph[n] = new Set()
  const spans = []
  const inside = idx => spans.some(([a, b]) => idx > a && idx < b)
  const head = /\b(Fn|FnVar|FnLayout)\b/g
  let m
  while ((m = head.exec(src))) {
    const idx = m.index
    if (inside(idx)) continue
    let i = ws(src, idx + m[1].length)
    if (src[i] === '<')
      (([, i] = bodyFrom(src, i + 1, '<', '>')), (i = ws(src, i)))
    if (src[i] !== '(') continue
    if (m[1] === 'FnLayout') {
      ;[, i] = bodyFrom(src, i + 1, '(', ')')
      i = ws(src, i)
      if (src[i] !== '(') continue
    }
    const [, callEnd] = bodyFrom(src, i + 1, '(', ')')
    const bn = bindingName(src, idx)
    let k = arrowHead(src, i + 1)
    if (k >= 0) {
      const k2 = ws(src, k)
      if (src[k2] !== '{') {
        const k3 = arrowHead(src, k2)
        if (k3 >= 0) k = k3
      }
    }
    if (k >= 0) {
      k = ws(src, k)
      const body =
        src[k] === '{' ? bodyFrom(src, k + 1)[0] : src.slice(k, callEnd - 1)
      // a Fn bound to a LOCAL name inside a factory is not an entry point, so it
      // has no row in the graph; it is covered through the exported factory's
      // own closure, and adding an edge for it threw on `graph[bn].add`
      if (bn && graph[bn]) {
        for (const other of names)
          if (other !== bn && new RegExp(`\\b${other}\\b`).test(body))
            graph[bn].add(other)
      }
    }
    spans.push([idx, callEnd])
    head.lastIndex = callEnd
  }
  callGraph[rel] = graph
}

// transitive closure of "compiling X also compiles Y"
const reaches = (rel, from, to) => {
  const g = callGraph[rel] ?? {}
  const seen = new Set()
  const stack = [from]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === to) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const n of g[cur] ?? []) stack.push(n)
  }
  return false
}

// Pre-pass: every `cpu<Name>` / `<name>CPU` export under src/, with the module
// that declares it.
//
// The index is GLOBAL rather than per-module because two real pairs live in a
// third file: `hazeMarch.ts` holds `getHazeRayNearFarCPU`, which twins
// `intersections.ts`'s `getHazeRayNearFar`, and `shadowLengthMarch.ts` holds
// `getShadowRayNearFarCPU`, which twins `intersections.ts`'s of the same name.
// A per-module index reported both as gaps.
//
// The declaring module is recorded because the NAME IS OVERLOADED:
// `getShadowRayNearFar` is exported by intersections.ts AND by
// shadow/opticalDepthMarch.ts with different signatures, and the CPU twin
// matches only the first. Cross-module credit is reported as its own bucket,
// never folded into the covered count.
const globalCpuExports = new Map()
for (const p of files) {
  const rel = relative(srcDir, p)
  const raw = readFileSync(p, 'utf8')
  for (const m of raw.matchAll(
    /export\s+function\s+(cpu[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*CPU)\b/g
  )) {
    const twinName = m[1]
    const target = twinName.startsWith('cpu')
      ? twinName[3].toLowerCase() + twinName.slice(4)
      : twinName.slice(0, -3)
    if (!globalCpuExports.has(twinName)) globalCpuExports.set(twinName, [])
    globalCpuExports.get(twinName).push({ target, module: rel })
  }
}

const rows = sites.map(s => {
  const mod = exportedByFile[s.file]
  // TWO twin-naming conventions are in use and the first version of this rule
  // knew only one, which reported 28 snap-only rows that were in fact twinned:
  //   <name>CPU      marchShadowLength / marchShadowLengthCPU
  //   cpu<Name>      getSphericalUv / cpuGetSphericalUv
  // Both are module exports here, so neither is a test-local mirror.
  // Twins declared in THIS module. Cross-module declarations are reported
  // separately below and never counted here: their signature is unverified
  // against this Fn, and `getShadowRayNearFar` exists under two incompatible
  // signatures in src/
  const cpuExports = new Map()
  for (const m of mod.raw.matchAll(
    /export\s+function\s+(cpu[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*CPU)\b/g
  )) {
    const twinName = m[1]
    const target = twinName.startsWith('cpu')
      ? twinName[3].toLowerCase() + twinName.slice(4)
      : twinName.slice(0, -3)
    cpuExports.set(twinName, target)
  }
  // THIRD twin convention, in test/helpers/*Reference.ts: `<name>Reference`,
  // with the helper's own spec in test/helpers/*Reference.test.ts. Distinct
  // from the other two: these assert properties that follow from what the
  // function IS, so they validate the transcription WITHOUT comparing it to
  // the shader — the numeric agreement is an e2e readback, which this
  // CPU-only task cannot run. Counted as a twin, flagged `reference` below.
  const twins = []
  const snaps = []
  const snapNamed = []
  // an orphan twin: the module ALREADY exports <name>CPU but no test calls it

  // A twin's target may differ from the Fn's name by a trailing `Function`/
  // `Fn`: the twin is `cpuShapeAltering`, the Fn is `shapeAlteringFunction`.
  // Insisting on equality hides a real pair; pairing by prefix ALONE would pair
  // any longer name, so the leftover suffix must be exactly Function or Fn.
  //
  // This returns a LIST, not one name. The first version returned a single
  // match, so a module exporting two twins of one Fn silently kept only the
  // first and 25 already-twinned rows fell back to snap-only.
  //
  // A FOURTH pairing, and the one this audit's first pass missed entirely: a
  // TSL-suffixed Fn whose twin is the plain-JS export of the same name minus
  // the suffix (`phaseFunctionTSL` twins `phaseFunction`, `hgTSL` twins
  // `henyeyGreenstein`). These are the phase-function pairs, and both forms
  // sit in one module, so the CPU twin is a sibling export rather than a
  // `cpu`/`CPU` symbol.
  const jsExports = new Set(
    [...mod.raw.matchAll(/(?:^|[\s;}])export\s+function\s+([A-Za-z_$][\w$]*)/g)]
      .map(x => x[1])
      .filter(n => !n.endsWith('CPU') && !/^cpu[A-Z]/.test(n))
  )
  const jsTwinOf = name => {
    if (!name.endsWith('TSL')) return null
    const base = name.slice(0, -3)
    return jsExports.has(base) ? base : null
  }
  // A twin's target can differ from the Fn's name by a bounded decoration on
  // EITHER end, which is why this is not plain equality:
  //   exact     getLayerDensity        / cpuGetLayerDensity
  //   suffix    shapeAlteringFunction / cpuShapeAltering        (+ Function|Fn)
  //   prefix    applySurfaceLightingMask / cpuSurfaceLightingMask (+ apply)
  //
  // Both decoration cases were false gaps: each pair is written and called, and
  // the equality rule called it unmatched. The leftover must come from this
  // closed list on the correct side, never an arbitrary substring — otherwise
  // every longer name pairs with every shorter one and the audit reports
  // nothing missing. Compared case-INSENSITIVELY, because the internal capital
  // of `cpuSurfaceLightingMask` makes a sensitive endsWith fail.
  // lowercased because every comparison below lowercases the remainder too:
  // `shapeAlteringFunction`.slice is 'Function' and matching it against a
  // list holding 'function' fails, which is exactly what happened once
  const DECORATIONS = ['', 'function', 'fn', 'apply', 'create', 'build', 'get']
  const decorated = (name, target) => {
    if (name.length < target.length) return false
    const lower = name.toLowerCase()
    const t = target.toLowerCase()
    if (lower.endsWith(t))
      return DECORATIONS.includes(
        name.slice(0, name.length - target.length).toLowerCase()
      )
    if (lower.startsWith(t))
      return DECORATIONS.includes(name.slice(target.length).toLowerCase())
    return false
  }
  const twinsOf = name =>
    [
      ...[...cpuExports]
        .filter(([, t]) => decorated(name, t))
        .map(([twinName]) => twinName),
      ...(jsTwinOf(name) ? [jsTwinOf(name)] : [])
    ].sort()

  const covering = info.filter(t => resolves(t, s.file))
  for (const t of covering) {
    if (t.usesWGSL) {
      snaps.push(t.rel)
      // Per-site attribution: the test names this site, or names an exported
      // entry point of the same module whose call-graph closure reaches it.
      // Without the closure a test that compiles `getGlobeUv` would look like
      // evidence about `getSphericalUv` merely because both are in the file.
      if (s.name !== '(anonymous)') {
        // Two routes, and the self-match must be excluded from the second.
        // `reaches` returns true immediately when from === to, and the name
        // list below contains the site's own name whenever the test mentions
        // it — so folding both into one `some()` made every site whose name
        // appears anywhere in a covering test count as snap-named. The fixture
        // caught it: orphanFn has no compiled call site of its own yet reported
        // one.
        const graph = callGraph[s.file] ?? {}
        //
        // Names are read from the test's CODE, not its raw text. The fixture
        // caught this: its spec ends with a comment saying `orphanFn` is
        // deliberately absent, and the comment alone was enough to give that
        // Fn a per-site snapshot. A comment is not a call site.
        const code = strip(t.src)
        const names = [
          ...new Set(
            [...code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map(m => m[1])
          )
        ]
        const explicit = new RegExp(`\\b${s.name}\\b`).test(code)
        const viaClosure = names.some(
          n =>
            n !== s.name &&
            Object.prototype.hasOwnProperty.call(graph, n) &&
            reaches(s.file, n, s.name)
        )
        if (explicit || viaClosure) snapNamed.push(t.rel)
      }
    }
    if (s.name === '(anonymous)') continue
    for (const twinName of twinsOf(s.name)) {
      if (new RegExp(`\\b${twinName}\\b`).test(t.src)) {
        const kind = cpuExports.has(twinName)
          ? 'module export'
          : 'sibling JS export'
        twins.push(t.rel + ` (${kind} ${twinName})`)
      }
    }
    // a local mirror in the TEST file whose name contains the site name and
    // whose body is plain JS (TSL_MARKERS decides)
    for (const lf of t.localFns) {
      if (lf === s.name) continue
      if (!lf.toLowerCase().includes(s.name.toLowerCase())) continue
      // Both branches must STOP BEFORE the body brace. An earlier version put
      // `\\{` inside the function branch as well, so the alternation consumed
      // the brace and the trailing `\\s*\\{` then demanded a second one. The
      // matcher never fired, which reads as `powderTerm` having no twin rather
      // than as a broken detector.
      const bodyM = new RegExp(
        `(?:function\\s+${lf}\\s*\\([^)]*\\)\\s*(?::[^\\{]+)?|const\\s+${lf}\\s*(?::[^=]+)?=[\\s\\S]{0,120}?=>)\\s*\\{`
      ).exec(t.src)
      if (!bodyM) continue
      const [b] = bodyFrom(t.src, bodyM.index + bodyM[0].length)
      if (TSL_MARKERS.test(b)) continue
      twins.push(t.rel + ` (local mirror ${lf})`)
    }
  }
  // a twin the module exports that NO covering test calls: dead coverage, and
  // the most misleading kind, because the symbol reads as tested
  const orphanCpu = []
  if (s.name !== '(anonymous)') {
    for (const twinName of twinsOf(s.name)) {
      if (!covering.some(t => new RegExp(`\\b${twinName}\\b`).test(t.src)))
        orphanCpu.push(twinName)
    }
  }
  // Reference helpers are matched OUTSIDE the covering-test loop on purpose. A
  // `<fn>Reference.ts` twin is spec'd in test/helpers/<fn>Reference.test.ts,
  // which resolves to the HELPER rather than to src/<fn>.ts, so requiring a
  // covering src test first reported every reference twin as absent — which is
  // exactly what happened to `turbulence`, whose module has no test file at all
  // yet whose twin is written and spec'd in test/helpers.
  if (s.name !== '(anonymous)') {
    for (const [refName, refRel] of referenceHelpers) {
      if (refName.toLowerCase() !== s.name.toLowerCase() + 'reference') continue
      const spec = refRel.replace(/\.ts$/, '.test.ts')
      twins.push(
        `${existsSync(spec) ? relative(ROOT, refRel) + ' (+ own spec)' : relative(ROOT, refRel) + ' (NO SPEC)'}`
      )
    }
  }
  // Cross-module twin evidence: a `<name>CPU` declared in ANOTHER module and
  // called by a test of THAT module. Reported separately because the twin's
  // signature is not checked against this Fn's, and `getShadowRayNearFar`
  // exists twice in src/ under two incompatible signatures
  const crossModule = []
  if (s.name !== '(anonymous)') {
    for (const [twinName, decls] of globalCpuExports) {
      if (decls.some(d => d.module === s.file)) continue
      // match on the twin's TARGET, not on the twin's own name: `decorated`
      // compares an Fn name to the name it twins
      if (!decls.some(d => decorated(s.name, d.target))) continue
      const t = info.find(x => new RegExp(`\\b${twinName}\\b`).test(x.src))
      if (t)
        crossModule.push(
          `${twinName} declared in ${decls.map(d => d.module).join('/')}, called by ${t.rel}`
        )
    }
  }
  return {
    ...s,
    crossModule,
    orphanCpu,
    twins: [...new Set(twins)],
    snaps: [...new Set(snaps)],
    snapNamed: [...new Set(snapNamed)]
  }
})

// CROSS-MODULE sits beside BOTH, not inside it: the twin exists, is called,
// and is a transcription of this Fn, but it lives in another module and its
// signature was never checked against this Fn's arity. `getShadowRayNearFar`
// is exported by intersections.ts AND shadow/opticalDepthMarch.ts under
// incompatible signatures, so name equality alone cannot decide which one a
// `<name>CPU` belongs to. Reported separately so the count of BOTH means
// "same-module twin", which is checkable.
// The snapshot half of the verdict uses PER-SITE evidence only.
//
// An earlier version used `r.snaps.length`, which is the MODULE-scope count:
// any covering test that calls compileWGSL at all. That over-counts, and the
// fixture caught it — `orphanFn` has no twin and its own module's test never
// compiles it, yet it reported as snap-only because a sibling test in the same
// file compiled something. Module-scope credit is still reported, as `snaps`,
// because it is the honest ceiling on what the file proves.
const bucket = r =>
  // cross-module credit pairs the twin with MODULE-SCOPE snapshot evidence,
  // because the twin is declared elsewhere and no test names this site
  r.crossModule.length && r.snaps.length
    ? 'cross-module'
    : r.twins.length && r.snapNamed.length
      ? 'both'
      : r.twins.length
        ? 'twin-only'
        : r.snapNamed.length
          ? 'snap-only'
          : 'neither'

const exported = rows.filter(r => r.exported && r.name !== '(anonymous)')
const hist = {}
for (const r of rows) hist[bucket(r)] = (hist[bucket(r)] || 0) + 1
const hist2 = {}
for (const r of exported) hist2[bucket(r)] = (hist2[bucket(r)] || 0) + 1

const md = r =>
  `| \`${r.file}:${r.line}\` | \`${r.name}\` | ${r.kind} | ${bucket(r)} |`

// Four output shapes, each exiting on its own. They have to be exclusive: an
// earlier version printed the JSON and then fell through to the human listing,
// and another printed the summary before the markdown table, so `--md` emitted
// a header the caller then had to strip
if (asJson) {
  // JSON on stdout with NOTHING else, so a caller can pipe it into a parser.
  // The summary is suppressed rather than merged: mixing the two streams on
  // one of them forced every consumer to slice the summary off the front
  console.log(
    JSON.stringify(
      rows.map(r => ({
        file: r.file,
        line: r.line,
        kind: r.kind,
        name: r.name,
        exported: r.exported,
        bucket: bucket(r),
        orphanCpu: r.orphanCpu,
        crossModule: r.crossModule,
        twins: r.twins,
        snaps: r.snaps,
        snapNamed: r.snapNamed
      })),
      null,
      1
    )
  )
  process.exit(0)
}

if (mdWanted) {
  console.log('| site | name | kind | bucket |')
  console.log('| --- | --- | --- | --- |')
  for (const r of exported)
    if (onlyBuckets.includes(bucket(r))) console.log(md(r))
  process.exit(0)
}

console.log(`sites: ${rows.length}  exported-named: ${exported.length}`)
console.log('histogram (all sites)', JSON.stringify(hist))
console.log('histogram (exported-named)', JSON.stringify(hist2))
for (const b of onlyBuckets) {
  const list = exported.filter(r => bucket(r) === b)
  console.log(`\n=== ${b} among exported-named (${list.length}) ===`)
  for (const r of list)
    console.log(`  ${r.file}:${r.line}`.padEnd(46), r.name, r.kind)
}
process.exit(0)
