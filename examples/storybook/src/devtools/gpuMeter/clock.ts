// GPU clock correction. The M4's GPU clock follows the load, so raw ms of a
// light frame overstate its work. After each sampled frame the meter times a
// fixed ALU probe and reports ms at the fast clock, as #355 and the perf map do

// The probe of examples/parity/scripts/benchmarks/clock.mjs, character for
// character, so the perf map's fast-state time below applies to it
export const PROBE_WGSL = `@group(0) @binding(0) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 1e-6; var y = 1.0;
  for (var i = 0u; i < 2048u; i++) { x = fma(x, 1.0000001, 0.5); y = fma(y, 0.9999999, x * 1e-9); }
  o[id.x] = x + y; }`

export const PROBE_WORKGROUPS = 1024
export const PROBE_BUFFER_BYTES = 65536 * 4

// The probe's time in the M4 mini's fast clock state, from the 2026-10-08
// perf map. Another GPU needs its own value
export const FAST_PROBE_MS = 0.4

// GPU ms of work at the fast clock, or null without a usable probe
export function clockCorrected(
  rawMs: number,
  probeMs: number | null,
  fastProbeMs = FAST_PROBE_MS
): number | null {
  if (probeMs == null || !Number.isFinite(probeMs) || probeMs <= 0) {
    return null
  }
  return (rawMs * fastProbeMs) / probeMs
}
