# Test Conventions

## Layout

- Unit tests live next to the module: `src/density/globeUv.test.ts`
- Cross-module and integration tests live in `test/`
- End-to-end tests live in `examples/parity/e2e/`
- Test helpers live in `test/helpers/`

## Shader Fn Testing

Every TSL shader `Fn` gets two kinds of tests:

1. **CPU twin test** — a pure JS reimplementation verified against the shader's expected math using `expectClose` from `test/helpers/cpuTwin.ts`
2. **WGSL snapshot/inspection test** — compile via `compileWGSL` from `test/helpers/compileWGSL.ts` and assert the generated WGSL contains expected patterns

## Context and Pass Testing

- Context/pass classes get bookkeeping tests on the stubs from `test/helpers/contextStub.ts`
- Use `rendererStub()` for pass tests that need `setRenderTarget`/`render` spies

## Logging

Every test logs its computed-vs-expected table via `test/helpers/log.ts`. Logs write to `test-results/unit/<spec>.log` (always) and to stdout when `TEST_LOG=1`.

## Commands

```sh
pnpm test              # run all tests
pnpm test:watch        # watch mode
TEST_LOG=1 pnpm test -- <pattern>   # run with logging to stdout
pnpm test -- --reporter=verbose     # verbose reporter
```

## Helpers

- `compileWGSL(fragmentNode, opts?)` — compile TSL to WGSL without a GPU
- `normalizeWGSL(wgsl)` — collapse whitespace and strip node numbering for stable comparison
- `expectWGSL(wgsl).toContain(...)` — assertion sugar for WGSL inspection
- `createContextStub()` — atmosphere + clouds context for compile tests
- `rendererStub()` — spy-equipped renderer for pass bookkeeping tests
- `frameStub(frameId, camera?)` — frame object for updateBefore tests
- `expectClose(actual, expected, opts?)` — numeric comparison with tolerance and table logging
- `quadrature(f, a, b, n)` — trapezoidal integration for analytic checks
- `seededRandom(seed)` — deterministic RNG (never use `Math.random` in tests)
- `log(scope, data)` — structured test logging
