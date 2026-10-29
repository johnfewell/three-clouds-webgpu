# Phase A exit test

This test ends Phase A of the raw WebGPU core. It renders the
same five ladder cases two ways:

- **the three package:** the parity harness's side B, as shipped;
- **the core:** `core/src/runtime` running the emitted description, with every
  uniform computed by the core's CPU state (`core/src/cpu`, via
  `RuntimeSession`).

It then compares the two per texture, byte for byte.

```sh
pnpm --filter three-clouds-core prove               # both phases
node core/scripts/exit-test.mjs --phase prepare     # CPU only
node core/scripts/exit-test.mjs --phase gpu         # needs a WebGPU Chrome
PARITY_GPU=hardware pnpm e2e --grep "core exit"     # the same, in the hardware e2e suite
```

It exits 1 on any differing byte, any GPU error, any case that compared
nothing, any control that did not move the output, any missing case, and any
injected fault that was not caught.

It is part of every full hardware e2e run (`coreExit.spec.ts`, skipped on
software). That adds about 2 minutes and about 3 GB of oracle recordings. The
spec deletes the recordings after every outcome, a timeout included, and
fails if any remain. The reports, descriptions and hashes (about 7 MB) stay
in `test-results/e2e/core-exit/`.

## Phases

1. **prepare** (CPU):
   - `ensureFreshBuild`: typecheck, then `pnpm build`. The oracle page serves
     `build/`, while the emitter compiles from `src/`, so the two must be the
     same source. With `PARITY_SKIP_BUILD=1`, which the e2e entry uses because
     the suite builds once, it instead refuses a `build/` older than `src/`.
   - For each case, `emit-runtime.mjs` writes `description.json`,
     `state.json` and `setup.json`.
   - Writes `prepared.json`: HEAD, dirty paths, the served `build/shared.js`
     SHA-256 and its resolved root, and each emitted file's SHA-256.
2. **gpu**:
   - Refuses to run if HEAD or the served build hash changed since prepare.
   - For each case, `prove-runtime.mjs`:
     1. records the three oracle: build once, reset, 10 frames, then the
        linear readback, all through the WebGPU hook;
     2. lines up the oracle's passes with the description's and checks each
        pair runs the same pipeline;
     3. replays the core runtime from `setup.json` over the harness's own
        frame plan;
     4. compares every copyable texture both sides name.
   - Then the injected faults run on the first case, against its oracle.
   - Writes `exit-report.json` and `exit-report.md`.

## Cases

Five distinct graphs: each case compiles WGSL modules no other case has.

| case | graph it adds |
| --- | --- |
| baseline-medium | the default graph, the spike's case |
| temporal-on-orbit | temporal upscale: quarter-resolution march, Bayer resolve, frame index advancing |
| shafts-low-sun | light shafts and cloud shadow under a low sun |
| layers-4-shadow | four active layers, a different compiled layer structure, with shadow |
| shadow-cascades-4x1024 | a low sun on four 1024² cascades |

## What each number means

| column | meaning |
| --- | --- |
| textures compared | textures both sides name that can be copied out. depth24plus cannot, and is listed as skipped |
| identical | of those, how many match in every texel byte (rows unpadded) |
| max byte diff | the largest absolute byte difference over all compared textures |
| sun nudge: linear bytes moved | control: the CPU-state sun nudged by 1e-4 must move this many bytes of the linear output |
| extra frame: linear bytes moved | control: two frames past the oracle must move the linear output |

Each control must be greater than 0, or the case fails as "comparator not
proven live". The coverage+1% control from cc_a3's proof is recorded too.

**Injected faults.** baseline-medium is replayed against its own oracle with
a fault in the **compared** run: the sun nudged, then one frame past the
oracle's. Each must FAIL on differing bytes. A fault that compares identical
fails the exit test.

**Traceability.** `exit-report.json` records:
- HEAD and the served build hash, at prepare and again at the gpu run;
- the SHA-256 of each emitted file and of each case's `report.json`;
- per texture, the SHA-256 of the unpadded texel bytes the core produced,
  next to the oracle's in `report.json`.

## Not computed by the core

These buffers come from the three run's bytes, not from the CPU state.
`exit-report.md` lists them per case:
- the full-screen quad's and the harness scene's vertex and index buffers
  (`ShadowPass.vertex*`, `ground.*`);
- the star catalogue (`Stars.vertex*`, `Stars.index`);
- the harness scene's object uniforms (`ground.object`);
- three's mip-blit uniform for the weather texture
  (`mipmap-rgba8unorm-2d-array.g0b2`).

Every buffer with a clouds or atmosphere field map is computed by the core.

## Not covered

- Moving cameras and time sequences. The oracle protocol pins time and the
  camera. Sequences are covered on the CPU by `core/src/cpu/frame.test.ts`
  against the live port, not on the GPU here.
- Experimental options, debug views and `lights` lighting mode: Phase A
  non-goals.
- Other GPUs. The evidence below is from one Mac mini (Chrome, Dawn on Metal).

## Evidence

2026-10-08, on the Mac mini:

| run | HEAD | result |
| --- | --- | --- |
| script, gpu window 13:14-13:15 | 0ef77c77 | 5/5 PASS, 103/103 textures identical |
| script with faults, 13:17-13:18 | a1fa2f3a | 5/5 PASS, both faults caught (sun 496,272 B, frame 4,540,778 B) |
| e2e entry, 13:20-13:22 | 936e79fa | 1 passed (1.7 min). Same numbers |
| final script run, 13:25-13:27 | 986253a5, clean tree | 5/5 PASS, 103/103 identical, both faults caught. Same numbers |

The control counts are identical across all three runs, so the result is
deterministic on this machine. The served build was `a0b9d46e…` in every run.
