// The consumer examples are typechecked here rather than by `tsc` alone, because
// their diagnostics fall into two classes that must be treated differently and
// TypeScript cannot tell them apart for us.
//
// DENY — the module graph is broken. A missing export or an unresolvable module
// means the example cannot execute a single line, which is exactly what happened
// to examples/r3f: it imported mrt/normalView/output/pass from 'three/webgpu'
// (they live in 'three/tsl'), shipped, and no gate saw it while 1537 tests and a
// 63-case ladder stayed green. These codes are UNWAIVABLE AND UNCONFIGURABLE:
// there is no flag, no environment variable and no per-file escape, because the
// moment a deny can be waived it will be, at 2am, by someone who needs a merge.
//
// SKEW — three 0.185's TSL `Node` generic against takram's published builds,
// which are compiled for <= 0.184. A declaration-level artifact of a version
// skew we do not control (the packed-consumer struct skew); NOT the
// struct-API runtime break, which the pinned fork builds fix. These are waivable.
//
// `@ts-expect-error` cannot express this split: TypeScript has no code-scoped
// suppression, so a directive silences whatever sits on its line. Four of them
// on the r3f import block would have hidden the module-load failure behind a
// green check — the gate green over the defect it exists to catch.
//
// Cite: the examples typecheck-and-smoke gate.
import { existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

/** Broken module graph. Never waivable. Do not add an escape hatch here. */
export const DENY_CODES = new Map([
  [2305, 'module has no exported member'],
  [2307, 'cannot find module or its type declarations'],
  [2724, 'module has no exported member named X'],
  [2688, 'cannot find type definition file']
])

/** three 0.185 Node-generic skew against takram's published builds. Waivable. */
export const SKEW_CODES = new Map([
  [2322, 'type is not assignable'],
  [2339, 'property does not exist on type'],
  [2345, 'argument is not assignable to parameter'],
  [2769, 'no overload matches this call']
])

/**
 * A waiver matches on file, code and the TRIMMED SOURCE TEXT of the offending
 * line — never a line number. A line-matched waiver slides silently onto a
 * different statement the next time anyone inserts a line above it, which is the
 * same class of defect as a source guard matching its own explanatory comment
 */

// EMPTY, and it must stay empty. Its six entries described three 0.185
// Node-generic skews in examples/basic and examples/r3f that no gate typechecked,
// because `pnpm typecheck` never ran those tsconfigs. They are fixed at the call
// sites now, and all three example projects are typechecked.

/**
 * @typedef {object} Waiver
 * @property {string} file
 * @property {number} code
 * @property {string} anchor
 */

/** @type {Waiver[]} */
export const WAIVERS = []

function diagnosticsFor(tsconfigPath) {
  const full = resolve(tsconfigPath)
  const read = ts.readConfigFile(full, ts.sys.readFile)
  if (read.error != null) {
    throw new Error(
      `cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`
    )
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(full)
  )
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true }
  })
  return ts.getPreEmitDiagnostics(program).filter(d => d.file != null)
}

function describe(diagnostic, root) {
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start ?? 0
  )
  const text = diagnostic.file.getFullText().split('\n')[line] ?? ''
  return {
    code: diagnostic.code,
    file: relative(root, diagnostic.file.fileName),
    line: line + 1,
    anchor: text.trim(),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  }
}

/**
 * @returns {{ok: boolean, failures: string[], counts: object}}
 */
export function checkProjects(
  tsconfigPaths,
  waivers = WAIVERS,
  root = process.cwd()
) {
  const failures = []
  const counts = { deny: 0, skew: 0, waived: 0, unclassified: 0 }
  const used = new Set()

  for (const cfg of tsconfigPaths) {
    for (const raw of diagnosticsFor(cfg)) {
      const d = describe(raw, root)
      if (DENY_CODES.has(d.code)) {
        counts.deny++
        failures.push(
          `REAL DEFECT ${d.file}:${d.line} TS${d.code} (${DENY_CODES.get(d.code)}) — ${d.message}`
        )
        continue
      }
      if (!SKEW_CODES.has(d.code)) {
        counts.unclassified++
        failures.push(
          `UNCLASSIFIED ${d.file}:${d.line} TS${d.code} — ${d.message}. Triage it into DENY or SKEW deliberately; this gate will not absorb a new class silently.`
        )
        continue
      }
      counts.skew++
      const i = waivers.findIndex(
        w => w.file === d.file && w.code === d.code && w.anchor === d.anchor
      )
      if (i === -1) {
        failures.push(
          `UNWAIVED SKEW ${d.file}:${d.line} TS${d.code} — ${d.message}. If this is the known version skew, add a waiver naming the anchor; if it is new, it is not skew.`
        )
      } else {
        counts.waived++
        used.add(i)
      }
    }
  }

  // A waiver that no longer covers anything is a permanent green over unknown
  // ground: when upstream ships 0.185-compatible builds these stop matching and
  // the gate must go red until they are deleted, so it announces the end of the
  // skew instead of carrying it invisibly.
  waivers.forEach((w, i) => {
    if (!used.has(i)) {
      failures.push(
        `STALE WAIVER ${w.file} TS${w.code} "${w.anchor}" matched nothing — the error is gone. Delete this entry.`
      )
    }
  })

  return { ok: failures.length === 0, failures, counts }
}

const PROJECTS = ['examples/basic/tsconfig.json', 'examples/r3f/tsconfig.json']

/**
 * The examples import the library by package name, so an absent or stale
 * `types/` makes every one of those imports a TS2305/TS2307 — which this gate
 * would print as a REAL DEFECT. That false alarm cost a debugging session on
 * 2026-09-03 (the second cause). Refuse to report rather than mislead.
 */
export function preflight(root = process.cwd()) {
  const dts = join(root, 'types', 'index.d.ts')
  if (!existsSync(dts)) {
    return 'types/index.d.ts is absent — run `pnpm build` first. Without it every library import reports as a missing module and this gate cannot tell that from a real defect.'
  }
  const src = join(root, 'src', 'index.ts')
  if (existsSync(src) && statSync(src).mtimeMs > statSync(dts).mtimeMs) {
    return 'types/index.d.ts is older than src/index.ts — run `pnpm build` first. A stale types/ reports a real export as missing.'
  }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const stale = preflight()
  if (stale != null) {
    console.log(`[example-diagnostics] REFUSING: ${stale}`)
    process.exit(2)
  }
  const { ok, failures, counts } = checkProjects(
    args.length > 0 ? args : PROJECTS
  )
  console.log(
    `[example-diagnostics] deny ${counts.deny} · skew ${counts.skew} (waived ${counts.waived}) · unclassified ${counts.unclassified}`
  )
  for (const f of failures) console.log(`[example-diagnostics] ${f}`)
  if (!ok) {
    console.log(`[example-diagnostics] FAIL — ${failures.length} problem(s)`)
    process.exit(1)
  }
  console.log('[example-diagnostics] OK')
}
