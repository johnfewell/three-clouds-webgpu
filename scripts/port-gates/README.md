# Port quality gates

Four automated checks enforcing code-quality parity with `@takram/three-clouds@0.7.6`.
Run all at once:

```bash
pnpm gates
```

Each gate exits non-zero on failure. CI runs `pnpm gates` on every PR.

## 1. TypeScript complexity — oxlint

```bash
pnpm dlx oxlint@1.80.0 -c scripts/port-gates/oxlintrc.json src
```

Clamp: **max 13** (matching the original's `CloudsEffect` constructor at 13).
Counts cyclomatic complexity per JS/TS function. Graph-time branching (JS `if`s
replacing GLSL `#ifdef` variants) is what this rule counts.

## 2. Shader-function complexity — decision-points.mjs

```bash
node scripts/port-gates/decision-points.mjs src --max 12
```

Clamp: **max 12** (matching the original's `marchClouds` at 12).
Counts decision points per TSL shader function body: `If(`, `.ElseIf(`, `.Else(`,
`Loop(`, `select(`, `cond(`, `.and(`, `.or(`, `Switch(`, `.Case(` plus JS control
flow (`if`, `for`, `while`, `do`, `case`, `?:`, `&&`, `||`) inside the body.

### Recognised shader-function forms

All require an **inline arrow callback**:

| Form | Example |
|---|---|
| `Fn` | `Fn(() => { … })`, `Fn(([a, b]) => { … })`, `Fn<[Node]>(([a]) => { … })`, `Fn((): Node<'vec3'> => { … })` |
| `FnVar` | `FnVar((a: Node, b: Node) => { … })`, `FnVar((a) => (builder) => { … })` (curried) |
| `FnLayout` | `FnLayout({ … })(([a], builder) => { … })`, `FnLayout({ … })(([a]) => a.mul(2))` (expression body) |

Generic arguments, typed parameters, return-type annotations, the curried
`(args) => (builder) => …` form, and expression bodies are all recognised.

### Structural checks (fatal when `--max` is given)

- **`unmeasured Fn`**: a `Fn`/`FnVar`/`FnLayout` call whose callback body is not
  lexically present (e.g. `Fn(function() {…})`, `Fn(helper)`, or a stored
  `FnLayout({…})` not called inline). Fix: write the arrow callback inline.
- **`flow outside Fn`**: TSL control flow (`If(`, `Loop(`, `select(`, `Switch(`, …)
  not lexically inside any measured body — shader logic assembled outside a `Fn`
  (in `setup()`, a plain helper, module scope) evades the gate. Fix: move it into
  a `Fn`. The check is lexical: a plain arrow helper that emits `If(` and is only
  ever called from inside a `Fn` still fails — make the helper a `Fn` too.

### Lizard cross-check

For GLSL baselines, renaming `.glsl`/`.frag`/`.vert` to `.c` lets Lizard's C reader
tokenize them. Add the `#if` column from `decision-points.mjs` to Lizard's `cc` and
the two agree on every function. See `BASELINE.md` §4 notes.

## 3. Comment audit — comment-audit.mjs

```bash
node scripts/port-gates/comment-audit.mjs src
```

Prints per-language totals (lines, comment/code ratio, doc blocks), the most/least
commented files, tag counts (`TODO`, `FIXME`, `HACK`, `NOTE`, `XXX`), paper/author
mentions, and all URLs cited in source.

Density targets (informational, not gated):
- Orchestration TS: 0.05–0.15 comment/code
- Math modules (TSL shaders): ≥ 0.14

JSDoc is restricted to the public surface only (see citations check §4).

## 4. Citations check — citations.mjs

```bash
node scripts/port-gates/citations.mjs src
```

Machine-checks four rules against `required-citations.json`, phase-gated by
`phase.json`:

1. **URLs**: every required URL for the current phase appears verbatim in the
   designated `where` file. A URL at a different location is `MISPLACED`.
2. **Markers**: every `TODO(port):`/`NOTE(port):` marker for the current phase
   appears verbatim in its designated file.
3. **Attribution headers**: every `src/**/*.ts` (excluding `*.test.ts`) starts with
   `// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)`,
   unless allowlisted (glue files must start with a `//` comment).
4. **JSDoc placement**: `/**` doc blocks only in `jsdocAllowlist` files (public
   surface). License headers in `/**` blocks are excluded from this check.

### Phase gating

`phase.json` contains `{ "phase": N }`. Only URLs and markers with `phase ≤ N` are
enforced. Bump the phase when a phase's acceptance work closes:

```bash
# Example: advancing to phase 1
echo '{ "phase": 1 }' > scripts/port-gates/phase.json
pnpm gates  # now enforces all phase-0 and phase-1 citations
```

At phase 0: only attribution headers and JSDoc placement are checked (no URLs or
markers have `phase: 0`).

### Data files

- `required-citations.json` — 24 URLs, 11 markers, attribution and JSDoc allowlists
- `phase.json` — current phase (0–4)

## Baselines

See `BASELINE.md` for measured baselines from `reference/clouds/src` and the upstream
WebGPU sources.

## Self-tests

Gate tool self-tests live in `test/`. Fixtures cover
all four tools: oxlintrc validation, decision-points structural checks, comment-audit
density, and citations check across all four rules. Run with `pnpm test`.

## Test results

`pnpm test` writes JUnit XML to `test-results/junit.xml` and coverage to `coverage/`.
Both directories are gitignored.
