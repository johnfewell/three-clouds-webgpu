// The atmosphere's internal noise loader is redirected to the port's MIT
// blue-noise volume. Provision local assets before Vite, and never fetch
// during a capture
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJitterTexture } from 'three-clouds-webgpu'

export async function writeSkyAssets(
  assets: string,
  starsPath: string
): Promise<void> {
  await mkdir(assets, { recursive: true })
  await copyFile(starsPath, join(assets, 'stars.bin'))
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
    await writeFile(join(assets, 'atmosphere-jitter.bin'), data)
  } finally {
    texture.dispose()
  }
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  execFileSync(
    process.execPath,
    [
      join(root, 'scripts/setup-assets.mjs'),
      '--example',
      'examples/r3f',
      '--from',
      'three-clouds-webgpu'
    ],
    { cwd: root, stdio: 'inherit', timeout: 30_000 }
  )
  await writeSkyAssets(
    join(root, 'examples/r3f/public/assets'),
    join(root, 'node_modules/@takram/three-atmosphere/assets/stars.bin')
  )
  console.log('[assets] local stars and MIT blue-noise atmosphere jitter ready')
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}
