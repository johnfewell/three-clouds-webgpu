// The public site: an assets-only Worker serving dist/site, which
// scripts/release/build-site.mjs assembles and scans. From this directory:
// cf deploy --mode preview for approval, then cf deploy for the live name
import { defineConfig } from '@cloudflare/config'

export default defineConfig(({ mode }) => ({
  worker: {
    name:
      mode === 'preview'
        ? 'three-clouds-webgpu-preview'
        : 'three-clouds-webgpu',
    compatibilityDate: '2026-10-28',
    assets: {
      htmlHandling: 'auto-trailing-slash',
      notFoundHandling: '404-page'
    }
  }
}))
