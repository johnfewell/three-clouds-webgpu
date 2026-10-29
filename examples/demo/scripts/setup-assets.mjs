// Provision baked cloud textures, local star catalog, and MIT blue-noise
// atmosphere jitter volume into examples/demo/public/assets before Vite starts

import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJitterTexture } from 'three-clouds-webgpu'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../..')
const assetsDir = join(repoRoot, 'examples/demo/public/assets')
const starsPath = join(
  repoRoot,
  'node_modules/@takram/three-atmosphere/assets/stars.bin'
)

execFileSync(
  process.execPath,
  [
    join(repoRoot, 'scripts/setup-assets.mjs'),
    '--example',
    'examples/demo',
    '--from',
    'three-clouds-webgpu'
  ],
  { cwd: repoRoot, stdio: 'inherit', timeout: 30_000 }
)

await mkdir(assetsDir, { recursive: true })
await copyFile(starsPath, join(assetsDir, 'stars.bin'))

const texture = createJitterTexture()
try {
  const { data, width, height, depth } = texture.image
  if (
    !(data instanceof Uint8Array) ||
    data.length !== width * height * depth ||
    data.length === 0
  ) {
    throw new Error('Refusing an empty or malformed atmosphere jitter volume')
  }
  await writeFile(join(assetsDir, 'atmosphere-jitter.bin'), data)
} finally {
  texture.dispose()
}

console.log('[assets] demo cloud textures, stars, and atmosphere jitter ready')
