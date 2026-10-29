// Adapted from three-geospatial storybook-webgpu/.storybook/main.ts (MIT,
// Copyright (c) 2024 Shota Matsuda). Differences: no nx tsconfig-paths plugin
// (the library is consumed by package name, like every example here), assets
// served from ./public (setup-assets provisions public/assets, as examples/basic
// and examples/r3f do), and the workerpool commonjs ignore kept verbatim

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/react-vite'
import { storyNameFromExport, toId } from 'storybook/internal/csf'
import { mergeConfig, searchForWorkspaceRoot, type UserConfig } from 'vite'

import { isShowcase, SHOWCASE_FILES, SHOWCASE_STORY_IDS } from './showcase'

// The ocean ground reads three-ocean-waves from its own checkout's build, not a
// dependency. OCEAN_WAVES_DIST overrides the sibling path. Without a build the
// alias falls back to a stub that throws only when the Ocean ground is picked
const oceanDist = (
  process.env.OCEAN_WAVES_DIST ??
  fileURLToPath(
    new URL(
      '../../../../water/three-ocean-waves/packages/ocean/dist/',
      import.meta.url
    )
  )
).replace(/\/$/, '')
const oceanAvailable = existsSync(`${oceanDist}/index.js`)
const oceanMissing = fileURLToPath(
  new URL('../src/clouds/helpers/oceanMissing.ts', import.meta.url)
)
// Exact matches: a prefix alias would turn `/styles` into `index.js/styles`
const oceanAliases = [
  {
    find: /^three-ocean-waves$/,
    replacement: oceanAvailable ? `${oceanDist}/index.js` : oceanMissing
  },
  {
    find: /^three-ocean-waves\/styles$/,
    replacement: oceanAvailable ? `${oceanDist}/styles.js` : oceanMissing
  }
]

const showcase = isShowcase(process.env.STORYBOOK_SURFACE)
const showcaseIds = new Set(SHOWCASE_STORY_IDS)
// A renamed story file would otherwise ship a demo with a story missing
const missing = SHOWCASE_FILES.filter(
  path => !existsSync(fileURLToPath(new URL(path, import.meta.url)))
)
if (showcase && missing.length > 0) {
  throw new Error(`Showcase story files not found: ${missing.join(', ')}`)
}

// The id Storybook gives an entry: title and export name. Every story file
// here sets its title, so an untitled entry is a mistake, not an auto-title
function showcaseEntryId(
  fileName: string,
  entry: { title?: string; name?: string; exportName: string }
): string {
  if (entry.title == null) {
    throw new Error(`Showcase story without a title in ${fileName}`)
  }
  return toId(entry.title, entry.name ?? storyNameFromExport(entry.exportName))
}

const config: StorybookConfig = {
  stories: showcase
    ? SHOWCASE_FILES
    : ['../src/**/*.@(mdx|stories.@(js|jsx|ts|tsx))'],
  // The showcase files also hold lab stories: only the picked ids are indexed,
  // so the rest are neither listed nor reachable by URL
  experimental_indexers: showcase
    ? (indexers = []) =>
        indexers.map(indexer => ({
          ...indexer,
          createIndex: async (fileName, options) =>
            (await indexer.createIndex(fileName, options)).filter(entry =>
              showcaseIds.has(entry.__id ?? showcaseEntryId(fileName, entry))
            )
        }))
    : undefined,
  addons: [],
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  core: {
    disableWhatsNewNotifications: true
  },
  features: {
    actions: false,
    interactions: false
  },

  staticDirs: [
    '../public',
    // The WebGL reference stories' atmosphere LUTs (and stars) from the
    // installed package rather than the package's default CDN, as upstream's
    // storybook maps packages/atmosphere/assets to /atmosphere
    {
      from: '../node_modules/@takram/three-atmosphere/assets',
      to: '/atmosphere'
    }
  ],

  viteFinal: config =>
    mergeConfig(config, {
      // One three: the ocean's build imports it bare, and its own checkout has
      // a second copy that would split instanceof checks and node registries
      resolve: {
        alias: oceanAliases,
        dedupe: ['three']
      },
      // The preview drops the Ocean ground where there is no ocean build
      define: {
        'import.meta.env.STORYBOOK_OCEAN': JSON.stringify(
          String(oceanAvailable)
        )
      },
      server: {
        fs: {
          allow: [
            searchForWorkspaceRoot(process.cwd()),
            ...(oceanAvailable ? [oceanDist] : [])
          ]
        }
      },
      // The library comes through its workspace exports (build/*.js), as a real
      // consumer's would, not a src/ alias. The reference chain is pre-bundled:
      // discovering it on the first clouds-webgl story reloads mid-render
      optimizeDeps: {
        exclude: ['three-clouds-webgpu'],
        include: [
          '@takram/three-clouds',
          '@takram/three-clouds/r3f',
          '@takram/three-atmosphere/r3f',
          '@takram/three-geospatial-effects',
          '@takram/three-geospatial-effects/r3f',
          '@react-three/postprocessing',
          'postprocessing',
          'leva',
          'leva/plugin'
        ]
      },
      build: {
        commonjsOptions: {
          // Ignore built-in modules used by workerpool
          ignore: ['os', 'child_process', 'worker_threads']
        },
        sourcemap: process.env.NODE_ENV !== 'production'
      }
    } satisfies UserConfig)
}

export default config
