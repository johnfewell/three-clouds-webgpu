import { defineConfig } from 'vite'

import { capturePlugin } from './vite-plugin-capture'
import { gatesPlugin } from './vite-plugin-gates'
import { resultsPlugin } from './vite-plugin-results'

export default defineConfig({
  // The showcase is published below the repository path on GitHub Pages
  // A relative base keeps the same build portable to any static subpath
  base: './',
  build: {
    outDir: 'dist'
  },
  plugins: [capturePlugin(), gatesPlugin(), resultsPlugin()]
})
