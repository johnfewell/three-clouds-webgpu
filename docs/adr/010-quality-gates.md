# ADR-010 — Quality gates policy

## Context

The port must maintain the same code-quality bar as the original `@takram/three-clouds@0.7.6`. The source's shipped code was measured on 2026-08-30 to establish baselines: TypeScript cyclomatic complexity max 13 (`CloudsEffect` constructor), GLSL per-function decision points max 12 (`marchClouds` in `clouds.frag:472`), and comment density 0.05 for orchestration TS / 0.14 for GLSL shader math. The port replaces GLSL preprocessor variants with graph-time JS branching and splits the monolithic `marchClouds` into separate TSL `Fn` bodies, so both metrics need their own gates.

## Decision

- **TypeScript complexity**: oxlint `complexity` rule at `max: 13`, run on every `.ts`/`.tsx` in `src/`. TSL modules' graph-time branching (JS `if`s replacing GLSL `#ifdef`) is what this rule counts.
- **Shader-function complexity**: `scripts/port-gates/decision-points.mjs` counts decision points per `Fn`/`FnVar`/`FnLayout({…})(…)` body — TSL control flow (`If(`, `.ElseIf(`, `.Else(`, `Loop(`, `select(`, `cond(`, `.and(`, `.or(`, `Switch(`, `.Case(`) plus JS control flow inside it. Gate at 12.
- **Structural checks** (fatal): `unmeasured Fn` — a shader-function call whose callback body is not lexically present; `flow outside Fn` — any TSL control-flow call outside every measured body. All march, density, lighting, shadow, and resolve logic must live inside measured shader-function bodies.
- **Comment audit**: `comment-audit.mjs` prints density, doc blocks, TODO tags, and URL lists for review. Orchestration files target 0.05–0.15 comment/code; math modules ≥ 0.14. JSDoc only on the public surface (`CloudsContext`, `CloudsPassNode`, `clouds()`, `CloudLayer`, preset keys). Every ported function keeps its source URL; every source `TODO` survives as `// TODO(port): …`.
- **Citations check**: `citations.mjs` machine-checks attribution headers, `TODO(port)` markers, required URLs, and JSDoc allowlist against `required-citations.json`, phase-gated by `phase.json`.
- **Enforcement**: `pnpm gates` runs all four checks, locally and in CI; oxlint and decision-points exit non-zero over their clamps.

## Consequences

- The source's monolithic `marchClouds` (9 runtime + 17 preprocessor decision points) splits into `primaryMarch`, `secondarySunMarch`, `shadowLengthMarch`, `hazeMarch`, etc. — each under 12.
- Graph-time variants (the GLSL `#ifdef`s) become plain JS `if`s counted by oxlint, keeping TypeScript under 13.
- `decision-points.mjs` recognises `Fn(…)`, `FnVar(…)`, and the curried `FnLayout({…})(…)` with any inline arrow callback form (typed, generic, expression-bodied). Self-tested on fixtures and verified against the vendored upstream WebGPU sources.
- See `scripts/port-gates/README.md` and `BASELINE.md` for measured baselines.

## References

- `scripts/port-gates/README.md`, `BASELINE.md`
- `@takram/three-clouds@0.7.6` source baselines (oxlint, decision-points, comment-audit)
