# ADR-015 — layers-4-shadow: temporal shadow-resolve sensitivity

Status: proposed. Maintainer decision 2026-09-24, option (1): record the gap as a
known difference with a named mechanism rather than chase it.

## Context

`layers-4-shadow` scores SSIM 0.970221 (committed
`parity/results/3/layers-4-shadow/metrics.json`), below the phase-4 bar of
0.98. The gap was investigated on 2026-09-24 with a corrected instrument,
over eight recorded checkpoints between 11:49Z and 12:24Z. The case ran at
1280×720 with warm-up 64 and a pinned frame, and both sides ran the clouds pass
at full resolution so their pixels correspond 1:1.

## Findings (each one a measurement, cited by its checkpoint)

1. **The instrument is validated on both sides** (CHECKPOINT 1, 11:49:46Z).
   Known values were written through the direct path and through the per-sample
   slot path. Both sides reproduce them exactly to fp16 (B/A = 1.000). The
   cross-side floor is std 0.0002, with extremes at ±0.17 %. This measurement
   replaces the retracted slot-based numbers from 2026-09-24 02:50Z.
2. **Stages a (density) and b (primary march) match** (CHECKPOINT 2,
   11:53:08Z). A fixed-position probe through each side's compiled
   `sampleWeather` / `sampleMedia` gives weather B/A = 1.00000 exactly, and
   extinction and scattering B/A at the fp16 floor (std 0.00016). The STBN
   jitter is bit-identical on every pixel. First-hit distance and step count
   are identical on 99.65 % and 99.94 % of cloud pixels, and the residual
   threshold flips are symmetric. Opacity B/A has median, p10 and p90 of
   1.00000.
3. **The first departing stage is the BSM (shadow-map) optical depth**
   (CHECKPOINT 3, 11:53:34Z). The local sun-march OD, extinction, sample
   height, powder and sky gradient all match to 0.2 % at p10/p90. BSM OD on
   the deck has B/A median 1.106, p10 0.725 and p90 3.147.
4. **The departure lives in the shadow temporal pass** (CHECKPOINT 4,
   11:57:00Z). With `temporalPass` and `temporalJitter` off on both sides, the
   deck BSM B/A is 1.00000 at the median (p10 0.938, p90 1.028), and the deck
   means agree to −0.5 %.
5. **A single raw shadow frame agrees, and the history does not** (CHECKPOINT
   5, 12:00:24Z; direct atlas readback, ratio statistics). In the raw frame,
   cascades 0 and 2 agree to within 0.8 % and 0.07 %, and cascade 1 has a ±12 %
   per-texel spread around a median of 1.00000. The temporal history differs
   per texel by ±20–45 %, with a net bias of only +0.5 to +1.7 %.
6. **The reference's temporal resolve is ill-conditioned in this setup, and
   the port reproduces it correctly** (CHECKPOINT 6, 12:07:59Z, as corrected by
   CHECKPOINT 7, 12:17:03Z). The first resolves on each side match a CPU twin
   of the reference algorithm to within 0.1 %: 9-tap variance clip,
   `varianceGamma` 1, `clipAABB`, `temporalAlpha` 0.01, and the same eight
   offsets. The twin starts from a zero history and is fed each side's own raw
   frame for 65 renders of the pinned frame. It reproduces the measured
   cross-side history spread: on cascade 0, a twin p10/p90 of 0.93/1.07 against
   a measured 0.93/1.09. Raw per-texel differences of 0.07–0.7 % therefore come
   out as ±4–9 % history differences, a 10–50× amplification. Knocking out the
   velocity on both sides does not close the gap. CHECKPOINT 7 retracts the
   round-off-velocity mechanism proposed in CHECKPOINT 6.
7. **The raw differences are edge-texel threshold flips** (CHECKPOINT 8,
   12:24:04Z). 91.8 % of cascade-1 texels have identical sample counts and
   steps on both sides (96.9 % on cascade 0 and 98.5 % on cascade 2). The
   remaining texels are whole-sample jumps at cloud edges: N × step B/A is
   exactly 0.5, 0.67, 1.5 or 2.0, where a sample crosses
   `minDensity`/`minExtinction` on one side only, most visibly at mip 0.5.
   The cascade matrices are identical (c1) or differ only by fp64 round-off,
   and the constants and resolve arithmetic match. No logic defect was
   localised.
8. **D1, B's shadow `updateInterval`, is real and small** (CHECKPOINT 8). The
   port defaults to 2, the reference resolves every frame, and the harness never
   pinned it. Pinning B to 1 moves SSIM from 0.970221 to 0.971488 (each arm
   captured twice, deterministic), a gain of +0.0013 or about 13 % of the gap.
   The harness now pins it.
9. **Bound.** With `temporalPass` off on both sides the case scored 0.9764.
   That measurement was taken before a compaction, on an older main, so it is a
   bound on what the temporal path costs and not a floor.

## Decision

- **The remainder of `layers-4-shadow`'s gap to 0.98, after that pin, is a
  known difference with a named mechanism.** Per-texel threshold flips at
  cloud edges in the raw shadow render (finding 7) pass through the
  reference's own ill-conditioned temporal shadow resolve (finding 6). Every
  stage before the BSM lookup matches (findings 2–3), and the port's resolve
  arithmetic matches the reference.
- **One accepted[] entry, pattern `layers-4-shadow`, with an executable
  floor.** `floor.ssim` is set from a `layers-4-shadow` capture taken after
  that pin, minus the 1.1e-5 cross-session floor (`acceptedPolicy`): gated
  SSIM 0.971489361 at the reference L over two deterministic arms, so the floor
  is **0.971478**. Below it the case fails as beyond
  the accepted footprint.
- **The 0.98 phase-4 bar is unchanged for every other case.** Other cases in
  the shadow family do not inherit this entry.
- **The port will not mimic the other side's round-off.** Faithfulness
  targets the reference's source semantics, and the port matches them at
  every stage measured.
- **The gap stays open for a future fix.** Candidate levers
  include conditioning the resolve (its history initialisation) or the
  edge-texel threshold behaviour at fractional LOD. Either one would move
  both sides, so neither can be adopted as a port-side change.

## Amendment 1 - the amplification is common-mode, so no port-side change reduces it

The Decision above left two levers open: the edge-texel threshold behaviour and
the conditioning of the temporal resolve. Both were measured, and neither is
reachable from the port.

**Method.** The port's own CPU twins of the reference resolve
(`src/shadow/shadowResolve.ts` and `src/resolve/varianceClipping.ts`) were driven
with a synthetic raw shadow atlas pair whose difference matches finding 7's
measured signature: whole-sample flips on 8 % of texels, `extinctionSum /
sampleCount` ratio exactly 0.5, 0.67, 1.5 or 2.0, and 0.4 % relative noise
elsewhere. Spreads below are (p90 - p10) of the per-texel B/A ratio on the
meanExtinction channel; **gain** is history spread over raw spread. No GPU, no
capture, no lock.

**The amplification reproduces.** At the reference's own conditioning
(temporalAlpha 0.01, varianceGamma 1, 64 frames, zero history) the gain is
**13.68**, inside the 10-50x window finding 6 reported. The mechanism is
confirmed as finding 7's whole-sample flips rather than a noise floor: the gain
is 0.61 at zero flips (the resolve is a net *contractor*), 7.77 at 4 %, 13.68 at
8 % and 24.12 at 16 %.

**It is the un-converged transient, not a steady-state error.** The case's
64-frame warm-up leaves the resolve only 47.4 % converged (1 - 0.99^64):

| frames | converged | gain |
|---|---|---|
| 1 | 1.0 % | 24.00 |
| 32 | 27.5 % | 18.22 |
| **64** | **47.4 %** | **13.68** |
| 256 | 92.4 % | 3.62 |
| 1024 | 100 % | 2.01 |
| 4096 | 100 % | 1.94 |

The gain falls monotonically with convergence and asymptotes near 1.94, so the
10-50x window is simply where a 64-frame warm-up lands. Finding 9's
temporal-off bound of 0.9764 is the gain = 1.00 row of the same sweep.

**The crux: it is common-mode.** Holding side A at the reference resolve and
sweeping side B's `temporalAlpha`:

| alphaA | alphaB | raw gap | history gap | ratio |
|---|---|---|---|---|
| 0.01 | **0.01 (reference)** | 0.6858 | **9.3840** | **13.68** |
| 0.01 | 0.05 | 0.6858 | 101.93 | 148.63 |
| 0.01 | 0.10 | 0.6858 | 109.72 | 159.99 |
| 0.01 | 0.50 | 0.6858 | 109.97 | 160.36 |
| 0.01 | 1.00 | 0.6858 | 109.97 | 160.36 |

Damping side B alone makes the measured disagreement **11x worse**. Seeding side
B's history with the current frame alone is worse still, at 109.97 (**11.7x**).
The amplification is a symmetric operator each side applies to its own raw
frame, so the measured gap is a function of the *raw* difference, and only a
change made on both sides can reduce it. A port-side change is by definition not
one, so it cannot help.

**varianceGamma is not a lever.** Sweeping 0.5 to 4 moves the gain by under
12 % and non-monotonically (15.33, 13.68, 13.19, 13.15). It is retired from the
candidate list.

### Considered and rejected

A fix of the right shape exists and is not port-side: seeding the history with
the current frame on **both** sides reaches gain 1.94, as does capturing after
convergence. Both change the reference's algorithm, which the Decision above
refuses, so they are recorded here rather than as follow-up work.

This also settles what the Decision anticipated when it said the levers "move
BOTH sides". They do, which is exactly why a port-side change cannot deliver
them. **The remainder of the gap is irreducible for a faithful port**, which is
the second limb of the Decision.

### Reproducing

The harness was a measurement, not a regression guard, so it was not committed.
Recreate it against the two CPU twins named above. The gain-versus-flip-fraction
table is the natural guard for any future change to the shadow resolve.

## Not covered

- B's first render after a history reset does not match the twin at k = 1
  (CHECKPOINT 6 §2 and CHECKPOINT 8 §2b). The case runs warm-up 64, so it
  does not reach this path. It is a separate small item and not register
  material.
- Any `layers-4-shadow` score below the floor, or any departure at stages a
  or b, is a new failure and outside this ADR.

## References

- `parity/results/3/layers-4-shadow/metrics.json` and its committed capture log
- The eight checkpoints of the 2026-09-24 investigation, 11:49:46Z to 12:24:04Z,
  and the maintainer decision at 16:55:22Z
- ADR-011 (parity methodology, cross-session floor)
- ADR-014 (the precedent for an accepted entry with an executable floor)
The follow-up investigation this amendment records: the negative result on
both candidate levers, measured on CPU against the port's own resolve twins.
