// Copy the baked cloud textures into an example's public/assets. The default
// URLs are relative, so an unprovisioned example 404s all four. One
// implementation, parameterised by source package: parity's side A provisions
// from the reference, basic from the port. Flags: setupAssetsArgs.mjs

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureJitterFixture, JITTER_FIXTURE_BYTES } from './jitterFixture.mjs'
import {
  formatSetupAssetsUsage,
  parseSetupAssetsArgs
} from './setupAssetsArgs.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const ASSETS = [
  { name: 'local_weather.png', expectedBytes: 679_653 },
  { name: 'shape.bin', expectedBytes: 2_097_152 },
  { name: 'shape_detail.bin', expectedBytes: 32_768 },
  { name: 'turbulence.png', expectedBytes: 49_691 }
]

// An unknown flag used to be ignored once --example and --from were both
// present, and the copy ran anyway
const parsed = parseSetupAssetsArgs(process.argv.slice(2))
if (parsed.help) {
  console.log(formatSetupAssetsUsage())
  process.exit(0)
}
if (!parsed.ok) {
  console.error(`[assets] ${parsed.error}`)
  process.exit(1)
}

const exampleArg = parsed.values.example
const fromArg = parsed.values.from

const EXAMPLE_ROOT = resolve(REPO_ROOT, exampleArg)
const SRC_DIR = join(
  EXAMPLE_ROOT,
  'node_modules',
  ...fromArg.split('/'),
  'assets'
)
const DST_DIR = join(EXAMPLE_ROOT, 'public/assets')

if (!existsSync(SRC_DIR)) {
  console.error(`[assets] source not found: ${SRC_DIR}`)
  console.error(
    `[assets] ${fromArg} is not installed under ${exampleArg} — run pnpm install first`
  )
  process.exit(1)
}

if (!existsSync(DST_DIR)) {
  mkdirSync(DST_DIR, { recursive: true })
}

let ok = true
for (const asset of ASSETS) {
  const src = join(SRC_DIR, asset.name)
  const dst = join(DST_DIR, asset.name)

  if (!existsSync(src)) {
    console.error(`[assets] ${asset.name} MISSING from source`)
    ok = false
    continue
  }

  copyFileSync(src, dst)
  const { size } = statSync(dst)
  if (size !== asset.expectedBytes) {
    console.error(
      `[assets] ${asset.name} ${size} MISMATCH(expected ${asset.expectedBytes})`
    )
    ok = false
  } else {
    console.log(`[assets] ${asset.name} ${size} OK`)
  }
}

if (!ok) {
  process.exit(1)
}

// The `**/stbn.bin` route fixture is a repository-level generated file rather
// than an example asset, but every path that needs it already runs this script
// and a missing file reads as a harness timeout. See the fixture README
const jitterPath = ensureJitterFixture()
const jitterBytes = statSync(jitterPath).size
if (jitterBytes !== JITTER_FIXTURE_BYTES) {
  console.error(`[assets] jitter fixture ${jitterBytes} MISMATCH`)
  process.exit(1)
}
console.log(`[assets] jitter fixture ${jitterBytes} OK`)
