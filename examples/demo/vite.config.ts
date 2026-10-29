import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Resolve three-ocean-waves from its sibling build when present, or fall back
// to a clear runtime stub when building without the sibling checkout
const defaultOceanDist = fileURLToPath(
  new URL(
    '../../../water/three-ocean-waves/packages/ocean/dist/',
    import.meta.url
  )
)
const oceanDist = (process.env.OCEAN_WAVES_DIST ?? defaultOceanDist).replace(
  /\/?$/,
  '/'
)
const oceanStub = fileURLToPath(
  new URL('./src/oceanMissing.ts', import.meta.url)
)
const oceanAvailable = existsSync(`${oceanDist}index.js`)

const oceanAliases = [
  {
    find: /^three-ocean-waves$/,
    replacement: oceanAvailable ? `${oceanDist}index.js` : oceanStub
  },
  {
    find: /^three-ocean-waves\/styles$/,
    replacement: oceanAvailable ? `${oceanDist}styles.js` : oceanStub
  }
]

const defaultPort = Number(process.env.PORT) || 5241

export default defineConfig({
  define: {
    'import.meta.env.VITE_OCEAN_AVAILABLE': JSON.stringify(
      String(oceanAvailable)
    )
  },
  base: './',
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react'
  },
  resolve: {
    alias: oceanAliases,
    dedupe: ['three']
  },
  optimizeDeps: {
    exclude: ['three-clouds-webgpu']
  },
  server: {
    port: defaultPort,
    strictPort: true
  },
  preview: {
    port: defaultPort,
    strictPort: true
  }
})
