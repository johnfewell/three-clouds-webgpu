import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  esbuild: {
    jsxDev: false
  },
  plugins: [
    dts({
      outDir: 'types',
      entryRoot: 'src',
      tsconfigPath: resolve(__dirname, 'tsconfig.lib.json'),
      pathsToAliases: false
    })
  ],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        webgpu: resolve(__dirname, 'src/webgpu/index.ts'),
        r3f: resolve(__dirname, 'src/r3f/index.ts')
      },
      formats: ['es']
    },
    rollupOptions: {
      // React and r3f are externals: a second React copy in the bundle breaks
      // hooks, and `react/jsx-runtime` must be listed because the automatic JSX
      // transform imports it rather than `react`
      external: [
        /^@takram\//,
        /^three\/?/,
        /^react($|\/)/,
        /^@react-three\//,
        'tiny-invariant',
        'type-fest'
      ],
      output: {
        chunkFileNames: 'shared.js'
      }
    }
  }
})
