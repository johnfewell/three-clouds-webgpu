# ADR-014 — Case 45's worley divergence is the reference deviating from its own arithmetic

## Context

Case 45 (LocalWeather) has carried a persistent R/G-channel divergence between
side A (`@takram/three-clouds` 0.7.6, WebGL/ANGLE) and side B (this port) since
the first parity captures, with the B (perlin) channel exact. The investigation
resolved it across seven valid hardware receipts (runs 2–7 plus the knock-out; the
first run was voided by its own console-error control. Arms 1–12, 2026-09-02,
each prediction recorded before the run, final receipt at `51bc7e9`).

## Findings (each clause a direct measurement)

1. **The port's compiled worley equals the reference's own straight-line
   arithmetic bit-exactly** — with literal or uniform `cellCount` alike
   (arms 9/11/12: reference unrolled inline in `main()` vs the port's worley
   field — the probe's twin of the package graph, WGSL-identical modulo
   variable numbering, whose composition arm 5's control ties to the package's
   real RGBA8 target within one 8-bit count (99.997% of texels exact) — maxAbs
   0, 0.00% differ, whole row at `(c16, o0)`; the same body in a loop-free
   function: exact; the knock-out ties the uniform form to the production
   build directly).
2. **The reference's compiled looped `getWorleyNoise` (as shipped, compiled by
   ANGLE for Metal) evaluates the sine hash on a second path** that differs
   from its own unrolled arithmetic on 40.72% of worley values at that row
   (maxAbs 0.876, corr 0.603) and changes the winning feature cell on 29.97%
   of texels (arms 10/12). The deviation is present in the reference's real
   LocalWeather target (arm 5 spliced control: exact reproduction).
3. **The two paths differ only for hash arguments in ≈ [790, 3720]**, which
   LocalWeather's mid and low channels both traverse (case 45's R/G). The
   perlin channel is exact (arm 3, B channel) and does not pass through the
   looped worley function; whether its own hash arguments avoid the band was
   not measured.
4. **A runtime-uniform `cellCount` mimic does not reproduce the deviation** —
   knock-out on a throwaway branch (a record, never
   to merge): eight `f32` uniforms compiled, zero literal cellCounts,
   whole-build digest moved, and arm 3 stayed bit-identical to baseline.
   Prediction P1 refuted as staked.

Dead by measurement along the way: texture-source (H1), context (H2), hash
range (H3), the assembled-argument association (arm 8), per-cell jitter values
(arm 9), and the general claim "Tint takes the second path when the constant
cannot fold" (probe-specific; withdrawn).

## Decision

- **Case 45's worley-channel (R/G) difference is an expected difference with a
  named, measured mechanism**: the reference's compiled program deviates from
  the reference's own source arithmetic; the port does not. The ladder grades
  case 45's R/G against this ADR; thresholds record it as expected-difference,
  not as port error.
- **The port will not mimic the compiled path.** The only demonstrated mimic
  route failed (finding 4), and binding parity to a toolchain artifact of the
  reference build is rejected on principle: faithfulness targets the
  reference's source semantics, which the port already matches bit-exactly.
- **The B (perlin) channel remains exact and is not covered by this ADR** —
  any future B-channel regression on case 45 is a real defect.
- Residual R/G deltas beyond the mechanism's measured footprint fall to the
  next one-variable candidate (the weather map's `minFilter`, P3) before any
  new hypothesis is opened.

## References

- `examples/parity` LocalWeather case 45 and its capture receipts (six valid
  receipts plus the arm-12 receipt at `51bc7e9`)
- The knock-out run's record, kept as a branch and never merged
- The arm-by-arm readouts that this ADR's findings are taken from
