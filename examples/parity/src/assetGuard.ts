// missing assets used to present as a
// startup TIMEOUT, naming nothing. Provisioning runs as `predev`, but a runner
// that launches Vite directly skips every hook, so this guard lives in the
// HARNESS BOOT and refuses by NAME however the server was started

import { sitePath } from './sitePath'

/** The four baked textures `scripts/setup-assets.mjs` provisions */
export type ParityAsset =
  'local_weather.png' | 'shape.bin' | 'shape_detail.bin' | 'turbulence.png'

export const PARITY_ASSETS: readonly ParityAsset[] = [
  'local_weather.png',
  'shape.bin',
  'shape_detail.bin',
  'turbulence.png'
] as const

export class MissingParityAssetsError extends Error {
  readonly missing: readonly string[]
  constructor(missing: readonly string[]) {
    super(
      `[parity] missing assets: ${missing.join(', ')} — run \`pnpm setup-assets\` ` +
        `in examples/parity (or \`pnpm dev\`, which runs it via predev). ` +
        `These 404 rather than fail loudly, so the harness would otherwise hang ` +
        `at startup instead of telling you this.`
    )
    this.name = 'MissingParityAssetsError'
    this.missing = missing
  }
}

/**
 * Refuse at boot if any baked asset is unreachable.
 *
 * A HEAD per asset rather than one probe: the point is to name *which* files
 * are missing, and a single probe would report the first and hide the rest.
 */
export async function assertParityAssets(
  fetchImpl: typeof fetch = fetch,
  base = sitePath('assets/')
): Promise<void> {
  const results = await Promise.all(
    PARITY_ASSETS.map(async name => {
      try {
        const res = await fetchImpl(`${base}${name}`, { method: 'HEAD' })
        // fetch resolves at headers. Settle the empty HEAD body so the browser
        // does not report a successful availability probe as requestfailed
        await res.arrayBuffer()
        return res.ok ? null : name
      } catch {
        return name
      }
    })
  )
  const missing = results.filter((n): n is ParityAsset => n != null)
  if (missing.length > 0) {
    throw new MissingParityAssetsError(missing)
  }
}
