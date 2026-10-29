# The pinned-digest gate (`scripts/digest-parity.mjs`)

Why this exists, and how to re-pin when it fires.

## The problem

Every cloud-variety PR proves its flag-off render is byte-identical to main by
pinning a literal of main's output: `defaultOutputDigest`'s WGSL and uniform
digests, `weatherIdentity`, and the per-feature weather / media / shadow / march
digests. Each literal is a snapshot of main at some past commit.

When main promotes a default or `normalizeWGSL` changes shape, every one of those
literals goes stale. Nothing noticed until merge, because `merge-check` ran
typecheck only and a PR's own CI ran against its own old main. Five cloud-variety
PRs in a row turned main red this way.

## What the gate does

Two passes, and it reuses the tests' own recipes rather than reimplementing them,
so there is no second digest implementation to drift:

1. **merged tree** — run every digest test on the tree as merged. This is the
   only state in which a stale literal is true regardless of which side moved.
2. **the ref's own `src/`** — `git checkout <ref> -- src/`, keeping this
   checkout's test files, helpers and `node_modules`, and run the
   feature-independent tests again. Every digest recipe reaches the graph through
   `src/` and nothing else, so swapping `src/` alone is enough. This checkout's
   copy of each test file is kept because it carries the literal under test: the
   ref's own copy would compare the ref against itself and pass trivially, which
   is the one result that would make the gate useless.

## The four outcomes

| merged | ref | meaning |
| --- | --- | --- |
| pass | pass | honest: the flag-off output equals the ref, literals current |
| fail | pass | **the branch changed the default render** |
| fail | fail | **stale literal**: the ref moved, re-measure |
| pass | fail | the branch renders what the ref does not |

Keeping the two middle rows apart is the point. The gate blocks either way, but
only the distinction tells you whether to re-pin a literal or to fix the branch.
A gate that collapsed them would still protect main and still cost an
investigation every time.

## When it fires

- **STALE LITERAL** — the branch is innocent. Re-measure as each file header
  says and re-pin. Pass 2 replays this checkout's own tests against the ref, so
  the replacement values are exactly what the failure output printed.
- **THE BRANCH CHANGED THE DEFAULT RENDER** — do not re-pin. Something in the
  branch moved the default path, which a cloud-variety PR must not do. Find it.
- **THE BRANCH DISAGREES WITH THE REF** — do not re-pin. The branch reproduces
  the literal but the ref does not, so the two render different things.

## Running it

```sh
node scripts/digest-parity.mjs               # against origin/main
node scripts/digest-parity.mjs --ref <sha>   # against a specific commit
node scripts/merge-check.mjs <pr>            # includes it
node scripts/merge-check.mjs <pr> --no-digest-parity   # typecheck only
```

`merge-check` runs it on the merged tree inside its own temporary worktree, which
already has its own install, so it costs one extra vitest pass and a `git
checkout` of `src/` — no second worktree and no second install.

## Safety

The gate refuses to run when `src/` has uncommitted changes, because it swaps
`src/` and restores it. Restoration is unconditional: `git checkout HEAD -- src`
runs from an `exit` handler, on `SIGINT`/`SIGTERM` and on an uncaught exception,
and it only deletes a replayed file that is *not* tracked at HEAD, so it never
removes a test it is gating.

## Why the test is small

`classify` is exported and pure, so `scripts/digest-parity.test.ts` pins the
four-way verdict without running git or vitest. The end-to-end proof is
expensive, so the cheap test guards the part that decides whether a merge is
blocked. Both failing rows were also red-proved end to end before that test
existed.