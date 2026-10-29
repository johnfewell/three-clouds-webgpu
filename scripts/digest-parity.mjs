// the gate that catches a pinned main-digest that main has moved past
// before merge, rather than after it. Two passes (the merged tree, then the
// ref's own src/) over the digest tests' own recipes, so there is no second
// digest implementation to drift. The four outcomes and how to re-pin:
// docs/digest-gate.md

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const refIdx = args.indexOf('--ref')
const REF = refIdx === -1 ? 'origin/main' : args[refIdx + 1]

// The tests whose recipe is feature-independent, so they can be replayed against
// a src/ that has never heard of the branch. weatherIdentity is here because its
// own header calls it the byte-identical-off proof §7 asks every sibling to use
const REPLAYABLE = [
  'src/experimental/defaultOutputDigest.test.ts',
  'src/experimental/weatherIdentity.test.ts'
]

// The per-feature digests. These cannot be replayed (they call ctx.cloudTypes and
// friends, which a pristine src/ does not have) but they are still run on the
// merged tree, because a PR that changes the default render must fail here too
const MERGED_ONLY = [
  'src/experimental/convectiveProfile.digest.test.ts',
  'src/experimental/evolvingWeatherDigest.test.ts',
  'src/experimental/cloudTypeMap.digest.test.ts'
]

/**
 * The discriminator, pure, so a test can pin it without running git or vitest.
 * Both passes agreeing is honest, merged-only failing means the branch changed
 * the default render, both failing means the ref moved and the literal is
 * stale, and ref-only failing means the branch renders what the ref does not
 *
 * @param {boolean} mergedOk pass 1, on the merged tree
 * @param {boolean} refOk pass 2, on the ref's own src
 * @param {string} ref what pass 2 measured against
 * @returns {{ code: number, lines: string[] }}
 */
export function classify(mergedOk, refOk, ref) {
  if (mergedOk && refOk) {
    return {
      code: 0,
      lines: [
        `VERDICT: OK — the flag-off output matches ${ref}, and the pinned literals are current.`
      ]
    }
  }
  if (!mergedOk && refOk) {
    return {
      code: 1,
      lines: [
        'VERDICT: FAIL — THE BRANCH CHANGED THE DEFAULT RENDER.',
        `  The pinned literals still match ${ref}, so they are not stale; the merged`,
        '  tree disagrees with them. That is a real behaviour change to the default',
        '  path, which a cloud-variety PR is not allowed to make.'
      ]
    }
  }
  if (!mergedOk && !refOk) {
    return {
      code: 1,
      lines: [
        `VERDICT: FAIL — STALE LITERAL. ${ref}'s default output moved.`,
        '  The merged tree and the pinned literal agree with each other but not with',
        '  this ref, so the branch is innocent and the LITERAL is out of date. This is',
        '  the case that used to turn main red after merge.'
      ]
    }
  }
  return {
    code: 1,
    lines: [
      `VERDICT: FAIL — THE BRANCH DISAGREES WITH ${ref}.`,
      '  The merged tree reproduces the pinned literal but the ref does not, so the',
      '  branch is not rendering what the ref renders. Do not re-pin; investigate.'
    ]
  }
}

const sh = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })

/**
 * The checkout's status, untracked files included, so the swap can be proven
 * to leave nothing behind
 *
 * @param {string} cwd
 * @returns {string}
 */
export function treeStatus(cwd) {
  return sh('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd
  })
}

/**
 * Put the ref's src/ in place and return the paths that exist only on the ref.
 * `git checkout <ref> -- src` stages those, and `git checkout HEAD -- src`
 * never removes them, so the restore needs the list
 *
 * @param {string} ref
 * @param {string} cwd
 * @returns {string[]}
 */
export function swapToRef(ref, cwd) {
  const refOnly = sh(
    'git',
    ['diff', '--name-only', '--diff-filter=A', 'HEAD', ref, '--', 'src'],
    { cwd }
  )
    .split('\n')
    .filter(Boolean)
  sh('git', ['checkout', ref, '--', 'src'], { cwd })
  return refOnly
}

/**
 * Undo swapToRef: src/ back to HEAD, then unstage and delete every ref-only path
 *
 * @param {string[]} refOnly
 * @param {string} cwd
 */
export function restoreFromHead(refOnly, cwd) {
  sh('git', ['checkout', 'HEAD', '--', 'src'], { cwd })
  for (const rel of refOnly) {
    sh('git', ['rm', '-q', '--cached', '--ignore-unmatch', '--', rel], { cwd })
    rmSync(join(cwd, rel), { force: true })
  }
}

const log = m => console.log(m)

// Everything below swaps src/ and shells out, so it must not run on import:
// the self-test imports this file for `classify` alone
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()

async function main() {
  // ---------------------------------------------------------------- preflight
  const dirty = sh('git', ['status', '--porcelain', '--', 'src']).trim()
  if (dirty) {
    console.error('REFUSING: src/ has uncommitted changes.')
    console.error(
      'The replay swaps src/ and restores it; a dirty src/ would be lost.'
    )
    console.error(dirty)
    process.exit(2)
  }

  const stash = mkdtempSync(join(tmpdir(), 'digest-parity-'))
  const saved = new Map()
  let restored = false
  const statusBefore = treeStatus(process.cwd())
  let refOnly = []

  // Restore src/ from HEAD, whatever happened above
  function restore() {
    if (restored) return
    restored = true
    try {
      restoreFromHead(refOnly, process.cwd())
      for (const rel of saved.keys()) {
        const abs = join(process.cwd(), rel)
        // Only remove what this script introduced. A replayed test file that is
        // also tracked at HEAD was restored by the checkout above and must stay,
        // or the gate deletes the very test it is gating
        let tracked = true
        try {
          sh('git', ['ls-files', '--error-unmatch', rel], { stdio: 'pipe' })
        } catch {
          tracked = false
        }
        if (!tracked && existsSync(abs)) rmSync(abs)
      }
    } catch (e) {
      console.error(
        `RESTORE FAILED, src/ may be at ${REF}. Run: git checkout HEAD -- src`
      )
      console.error(String(e))
    }
    rmSync(stash, { recursive: true, force: true })
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
    process.on(sig, () => {
      restore()
      if (sig !== 'exit') process.exit(130)
    })
  }
  process.on('uncaughtException', e => {
    console.error(String(e))
    restore()
    process.exit(2)
  })

  // Keep this checkout's version of each test file: it carries the LITERAL under
  // test. The ref's own copy would compare the ref against itself and pass
  // trivially, which is the one result that would make this gate useless
  for (const rel of REPLAYABLE) {
    const to = join(stash, basename(rel))
    copyFileSync(rel, to)
    saved.set(rel, to)
  }

  const runTests = files => {
    try {
      const out = sh('pnpm', ['exec', 'vitest', 'run', ...files], {
        stdio: 'pipe'
      })
      return { ok: true, out }
    } catch (e) {
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  const VERDICT_LINES = l =>
    l
      .split('\n')
      .filter(x => /FAIL|AssertionError|Tests |expected/.test(x))
      .slice(0, 20)

  // ------------------------------------------------------------------- merged
  log(`# digest parity, ref ${REF}\n`)
  log('## pass 1/2: the merged tree, every digest test')
  const merged = runTests([...REPLAYABLE, ...MERGED_ONLY])
  log(merged.ok ? '   PASS' : '   FAIL')

  // ------------------------------------------------------- the ref's own src/
  log(`\n## pass 2/2: pristine ${REF} src/, this checkout's literals`)
  refOnly = swapToRef(REF, process.cwd())
  for (const rel of saved.keys()) {
    mkdirSync(dirname(rel), { recursive: true })
    copyFileSync(saved.get(rel), rel)
  }
  const refState = runTests(REPLAYABLE)
  restore()
  log(refState.ok ? '   PASS' : '   FAIL')
  const statusAfter = treeStatus(process.cwd())
  if (statusAfter !== statusBefore) {
    console.error('REFUSING: the replay left the checkout changed.')
    console.error(`before:\n${statusBefore}\nafter:\n${statusAfter}`)
    process.exit(2)
  }

  // ------------------------------------------------------------------ verdict
  const literals = []
  for (const rel of REPLAYABLE) {
    for (const m of sh('cat', [rel]).matchAll(/'([0-9a-f]{64})'/g)) {
      literals.push({ file: rel, value: m[1] })
    }
  }

  log('')
  const { code, lines } = classify(merged.ok, refState.ok, REF)
  for (const l of lines) log(l)
  if (code === 1 && !merged.ok && !refState.ok) {
    log('  Every pinned main digest is now suspect:')
    for (const { file, value } of literals) log(`    ${file}  ${value}`)
    log(
      `  Re-measure as each file header says, then re-pin. Because pass 2 replays`
    )
    log(
      `  this checkout's own tests against ${REF}, the replacement values are`
    )
    log('  exactly what the failure detail below printed.')
  }

  if (!merged.ok) {
    log('\n--- merged-tree failure detail ---')
    log(VERDICT_LINES(merged.out).join('\n'))
  }
  if (!refState.ok) {
    log(`\n--- pristine ${REF} failure detail (the actual values) ---`)
    log(VERDICT_LINES(refState.out).join('\n'))
  }
  process.exit(code)
}
