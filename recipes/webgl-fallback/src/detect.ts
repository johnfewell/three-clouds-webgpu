import type { Backend } from './settings'

/**
 * Which branch to build. The choice is made before any renderer exists and
 * never revisited: `navigator.gpu` present AND an adapter granted means
 * WebGPU, anything else means the WebGL original. `?backend=webgl` or
 * `?backend=webgpu` forces a branch for testing. Forcing WebGPU where there
 * is none fails in the branch, which is the honest outcome.
 */
export async function detectBackend(
  search = location.search
): Promise<Backend> {
  const forced = new URLSearchParams(search).get('backend')
  if (forced === 'webgl' || forced === 'webgpu') return forced
  const gpu = (
    navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } }
  ).gpu
  if (gpu?.requestAdapter == null) return 'webgl'
  try {
    const adapter = await gpu.requestAdapter()
    return adapter == null ? 'webgl' : 'webgpu'
  } catch {
    return 'webgl'
  }
}
