// Give the emitted declarations specifiers `moduleResolution: node16` can
// follow: vite-plugin-dts keeps the source's extensionless ones, so `./x`
// becomes `./x.js` and node16 resolves that to `./x.d.ts`. See docs/RELEASE.md
//   node scripts/dts-extensions.mjs            rewrite types/ in place
//   node scripts/dts-extensions.mjs --check    report only, exit 1 if dirty
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bexport\s*\*\s*from\s*)['"]([^'"]+)['"]/g

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

function hasExtension(specifier) {
  return /\.[cm]?[jt]sx?$/.test(specifier) || /\.json$/.test(specifier)
}

function declarationsIn(root) {
  const out = []
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.d.ts')) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out.sort()
}

// A specifier is resolvable if the declaration it names sits next to the
// importing file, either as `<spec>.d.ts` or as `<spec>/index.d.ts`
function rewriteSource(source, fromDir) {
  const unresolved = []
  const rewritten = []
  const out = source.replace(SPECIFIER, (match, prefix, specifier) => {
    if (!isRelative(specifier) || hasExtension(specifier)) {
      return match
    }
    const target = resolve(fromDir, specifier)
    if (existsSync(`${target}.d.ts`)) {
      rewritten.push(specifier)
      return `${prefix}'${specifier}.js'`
    }
    if (existsSync(join(target, 'index.d.ts'))) {
      rewritten.push(specifier)
      return `${prefix}'${specifier}/index.js'`
    }
    unresolved.push(specifier)
    return match
  })
  return { out, rewritten, unresolved }
}

function main(argv) {
  const check = argv.includes('--check')
  const rootArg = argv.find(a => !a.startsWith('-'))
  const root = resolve(rootArg ?? 'types')

  if (!existsSync(root)) {
    console.error(`REFUSING: ${root} does not exist. Run \`pnpm build\` first.`)
    process.exitCode = 1
    return
  }

  const files = declarationsIn(root)
  if (files.length === 0) {
    console.error(`REFUSING: found 0 declaration files under ${root}.`)
    process.exitCode = 1
    return
  }

  let changedFiles = 0
  let rewritten = 0
  const unresolved = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const {
      out,
      rewritten: hits,
      unresolved: misses
    } = rewriteSource(source, dirname(file))
    unresolved.push(...misses.map(m => `${file}: ${m}`))
    if (out === source) {
      continue
    }
    changedFiles++
    rewritten += hits.length
    if (!check) {
      writeFileSync(file, out)
    }
  }

  const mode = check ? 'would rewrite' : 'rewrote'
  console.log(
    `declarations scanned : ${files.length}\n` +
      `files ${mode.padEnd(12)}: ${changedFiles}\n` +
      `specifiers ${mode.padEnd(12)}: ${rewritten}`
  )

  if (unresolved.length > 0) {
    console.error(
      `REFUSING: ${unresolved.length} relative specifier(s) name no declaration ` +
        `file and would ship unresolvable:\n  ${unresolved.join('\n  ')}`
    )
    process.exitCode = 1
    return
  }

  if (check && changedFiles > 0) {
    console.error(
      'REFUSING: --check found declarations without extensions. Run without --check.'
    )
    process.exitCode = 1
  }
}

if (process.argv[1] === import.meta.filename) {
  main(process.argv.slice(2))
}
