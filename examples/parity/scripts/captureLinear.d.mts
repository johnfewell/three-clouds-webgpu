// Types for captureLinear.mjs: plain JS because capture.mjs (a node script)
// consumes it and the unit suite (TypeScript) pins it
export const LINEAR_FILES: {
  readonly A: string
  readonly B: string
  readonly meta: string
}
export function writeLinearReadbacks(
  outDir: string,
  readbacks: { width: number; height: number; a64: string; b64: string }
): { bytes: number }
export function readLinearReadback(path: string): Float32Array
