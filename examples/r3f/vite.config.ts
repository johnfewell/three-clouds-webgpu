import { defineConfig } from 'vite'

export default defineConfig({
  // No @vitejs/plugin-react, deliberately: adding a dependency means a pnpm
  // install every agent in the shared checkout must absorb. Vite's
  // esbuild already transforms JSX. The plugin would only add Fast Refresh
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  server: { port: 5200 },
  // The library is consumed through its workspace exports (build/r3f.js), the
  // same path a real consumer takes, NOT through a src/ alias, which would
  // demonstrate a wiring nobody else can reproduce
  optimizeDeps: { exclude: ['three-clouds-webgpu'] }
})
