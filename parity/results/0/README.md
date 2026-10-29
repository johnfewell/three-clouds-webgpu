# Phase 0: Graph Smoke Test — No Metrics

First A/B still pairs for the Phase 0 parity ladder. Side A is the WebGL
reference (`@takram/three-clouds` via CloudsEffect). Side B is the WebGPU/TSL
stub shell (ADR-001 render graph wired, march returns zero density).

The pairs will **not** match — the point is to verify the rendering graph:

| Case | Resolution | Visual checks |
|------|-----------|--------------|
| baseline-medium | 1280×720 | Sky present once, aerial perspective on geometry |
| orbit-140km | 320×180 | Curved shell visible in orbital view |
| inside-deck | 320×180 | Camera inside cloud deck, geometry punch-through |
| baseline-low | 1280×720 | Low-angle sun, atmosphere gradient |
| surface-up | 1280×720 | Looking up from surface, cloud layer overhead |
| horizon-graze | 1280×720 | Grazing horizon angle, atmosphere scattering |

## Capture method

Playwright (headed, real GPU) → `?case=<name>&capture=1` → vite capture plugin
(`canvas.toBlob()` in-frame after warmup). NeutralToneMapping, exposure 1,
pixelRatio 1, 64 warmup frames, Δtime=0.

## Images

Capture images (PNG, WebM) are local capture output, not committed; they are
gitignored and Git LFS is no longer used.
Each case's `metrics.json` and `capture.log` are the record. Binary `.bin`
files under `parity/results/` are gitignored (regenerable, ~11 MB each).
