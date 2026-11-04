// Every TOP-LEVEL path of the private tree gets an explicit decision with a
// reason, and an unlisted path is a hard error rather than a default. The
// exclusion list has to be a decision, not a glob: `docs/**` would take
// MIGRATION.md out with MAINTAINER_REVIEW.md, and a test reads that file

/** Top-level paths copied into the public tree, with the reason they are in */
export const KEEP = [
  { path: 'core', reason: 'the lockfile and typecheck require this workspace' },
  {
    path: '.github',
    reason:
      'CI runs the same gates on the public repo, and ' +
      '.github/public-workflows/README.md documents the release workflows'
  },
  {
    path: '.gitignore',
    reason: 'the public tree ignores the same build output'
  },
  {
    path: '.prettierignore',
    reason: 'format:check needs it, and it names parity/results'
  },
  {
    path: '.prettierrc',
    reason: 'format:check needs it'
  },
  {
    path: 'CHANGELOG.md',
    reason: 'release history a public reader expects'
  },
  {
    path: 'CONTRIBUTING.md',
    reason:
      'how a stranger reports an issue or sends a change to the public repo'
  },
  {
    path: 'LICENSE',
    reason: 'the port ships MIT'
  },
  {
    path: 'README.md',
    reason: 'the front door of the public repo'
  },
  {
    path: 'INTEGRATION.md',
    reason: 'the version-matched consumer integration guide'
  },
  {
    path: 'recipes',
    reason: 'complete standalone vanilla and React consumer projects'
  },
  {
    path: 'THIRD_PARTY_NOTICES.md',
    reason: 'names every copied third-party project, and a test reads it'
  },
  {
    path: 'WEBGPU.md',
    reason: 'upstream porting notes, and a test pins its Usage snippet'
  },
  {
    path: 'assets',
    reason: 'the four baked textures the package ships'
  },
  {
    path: 'eslint.config.mjs',
    reason: 'lint needs it'
  },
  {
    path: 'examples',
    reason: 'basic, parity, storybook and r3f are the public demos'
  },
  {
    path: 'package.json',
    reason: 'the package identity'
  },
  {
    path: 'parity',
    reason: 'committed parity metrics, the evidence behind the claims'
  },
  {
    path: 'pnpm-lock.yaml',
    reason: 'a frozen install needs the committed lockfile'
  },
  {
    path: 'pnpm-workspace.yaml',
    reason: 'the workspace the lockfile resolves'
  },
  {
    path: 'reference',
    reason:
      'the vendored upstream sources are the citation target for every ' +
      'ported line, and scripts/port-gates tests run the gate tools over ' +
      'reference/, so excluding it turns pnpm test red'
  },
  {
    path: 'scripts',
    reason: 'gates, tests and the release tooling ship with the port'
  },
  { path: 'src', reason: 'the port itself' },
  { path: 'test', reason: 'the test suite is part of the package' },
  { path: 'tsconfig.json', reason: 'typecheck needs it' },
  { path: 'tsconfig.lib.json', reason: 'the library build reads it' },
  { path: 'typedoc.json', reason: 'the generated API reference config' },
  {
    path: 'vendor',
    reason:
      'the fork builds pnpm-workspace.yaml overrides point at, ' +
      'so a frozen install resolves'
  },
  { path: 'vite.config.ts', reason: 'build needs it' },
  { path: 'vitest.config.ts', reason: 'the test runner reads it' },
  {
    path: 'site',
    reason:
      'the assets-only Worker the public site is deployed as: its ' +
      'cloudflare.config.ts, wrangler.config.ts and pinned tooling'
  }
]

/** Top-level paths left out of the public tree, with the reason */
export const EXCLUDE = [
  {
    path: '.beads',
    reason: 'local issue-tracker state is not part of the public distribution'
  },
  {
    path: '.ntm',
    reason: 'agent rate-limit state, private machine bookkeeping'
  },
  {
    path: 'AGENTS.md',
    reason:
      'the private operating manual for the multi-agent fleet: br commands, ' +
      'worktree recipes, agent mail. Nothing in the tree reads it as a file, ' +
      'only cites it'
  },
  {
    path: 'docs',
    reason: 'decided per file below, because one test reads docs/MIGRATION.md'
  },
  {
    path: 'perf',
    reason:
      '5.3 MB of raw GPU benchmark receipts and one-off experiment drivers ' +
      'from dated private runs, named after the tasks that produced them'
  }
]

/** Second-level decisions inside an included directory */
export const DOCS_KEEP = [
  {
    path: 'docs/API.md',
    reason: 'generated public signatures, semantics and runtime defaults'
  },
  {
    path: 'docs/CONSUMER_CONTRACT.md',
    reason: 'setup diagnostics, readiness and resource ownership'
  },
  { path: 'docs/adr', reason: 'design decisions, cited from README and src' },
  {
    path: 'docs/design',
    reason: 'the layer model the knobs implement'
  },
  {
    path: 'docs/BENCHMARKS.md',
    reason: 'published numbers with the method beside them'
  },
  {
    path: 'docs/EXPERIMENTAL.md',
    reason: 'the reference for the opt-in experimental renderer options'
  },
  {
    path: 'docs/night-sky.md',
    reason: 'how to wire the moon and stars behind the clouds'
  },
  {
    path: 'docs/digest-gate.md',
    reason: 'how the pinned-digest gate in scripts/ works and how to re-pin'
  },
  {
    path: 'docs/graph-variant-matrix.md',
    reason:
      'how the pass graph variant digest matrix is built and how to extend it, ' +
      'read by whoever adds an experimental option'
  },
  {
    path: 'docs/experimental',
    reason: 'illustrations and notes the experimental options guide links to'
  },
  {
    path: 'docs/images',
    reason: 'the README hero screenshot that links to the live demo'
  },
  {
    path: 'docs/MIGRATION.md',
    reason:
      'the key audit table, read verbatim by ' +
      'examples/parity/src/parityState.test.ts'
  },
  {
    path: 'docs/RELEASE.md',
    reason:
      'the release procedure is the operator-facing document for the ' +
      'published repo, so it ships; the private tasks and the -dev remote ' +
      'it names are left to the transform, or flagged for a human rewrite'
  }
]

/** Everything under docs/ that is not in DOCS_KEEP, each with a reason */
export const DOCS_EXCLUDE = [
  {
    path: 'docs/MAINTAINER_REVIEW.md',
    reason:
      'a review checklist over private PR numbers and open tasks, linked ' +
      'from README.md and WEBGPU.md, so those links are reported'
  },
  { path: 'docs/UPSTREAM_PR.md', reason: 'the private upstream PR plan' },
  {
    path: 'docs/UPSTREAM_DRYRUN.md',
    reason:
      'an internal analysis of the UPSTREAM repo against a private clone, ' +
      'dated and full of one-off plans; the porting notes a public reader ' +
      'wants already live in WEBGPU.md'
  },
  {
    path: 'docs/ATMOSPHERE-COST-STUDY.md',
    reason: 'a dated internal investigation with open private tasks'
  },
  {
    path: 'docs/PERFORMANCE-PROFILING.md',
    reason: 'the writeup of the excluded perf/ receipts'
  },
  {
    path: 'docs/enumeration-method.md',
    reason: 'how this fleet enumerates work, not how the port works'
  },
  {
    path: 'docs/audit',
    reason:
      'a dated licence audit with its open findings, written for this ' +
      'release rather than by the port'
  },
  { path: 'docs/profiling', reason: 'raw profiling dumps' },
  {
    path: 'docs/experiments',
    reason: 'internal performance experiment writeups and raw artifacts'
  }
]

/**
 * The decision for one repo-relative path.
 *
 * Returns `{ keep: true }` or `{ keep: false, reason }`, and THROWS for a path
 * no rule covers, so a new top-level directory cannot slip into the public
 * tree by being unmentioned.
 */
export function decide(path) {
  if (
    path === 'UPGRADE_LOG.md' ||
    path === 'docs/PUBLIC_LAUNCH.md' ||
    path === 'docs/PUBLIC_SYNC.md' ||
    path === '.github/workflows/public-sync.yml' ||
    path === '.github/workflows/publish-release.yml' ||
    path === 'scripts/release/public-sync-policy.json' ||
    /^scripts\/release\/(?:export-public|export-verify|bead-refs|audit-remotes|public-sync|release-candidate|publish-release)\./.test(
      path
    ) ||
    /^scripts\/release\/(?:exportPublic|exportVerify|auditRemotes|publicSync|publishRelease)\.test\.ts$/.test(
      path
    )
  ) {
    return {
      keep: false,
      reason:
        'private export and migration tooling stays with the development repository'
    }
  }
  const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : path
  const rest = path.slice(top.length + (path.length > top.length ? 1 : 0))

  if (top === 'docs') {
    const whole = DOCS_KEEP.find(
      d => d.path === path || path.startsWith(`${d.path}/`)
    )
    if (whole) return { keep: true, reason: whole.reason }
    const dropped = DOCS_EXCLUDE.find(
      d => path === d.path || path.startsWith(`${d.path}/`)
    )
    if (dropped) return { keep: false, reason: dropped.reason }
    throw new Error(`no manifest entry for ${path}`)
  }

  const kept = KEEP.find(d => d.path === top)
  if (kept) return { keep: true, reason: kept.reason, rest }
  const dropped = EXCLUDE.find(d => d.path === top)
  if (dropped) return { keep: false, reason: dropped.reason }
  throw new Error(`no manifest entry for ${path} (top level ${top})`)
}

/** Every exclusion the manifest can produce, for the report */
export function excludedRoots() {
  return [...EXCLUDE, ...DOCS_EXCLUDE].map(d => d.path)
}
