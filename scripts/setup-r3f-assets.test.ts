import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { writeSkyAssets } from './setup-r3f-assets'

const dirs: string[] = []
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'r3f-assets-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true })
})

test('missing upstream stars fail provisioning instead of starting a broken scene', async () => {
  const dir = await fixture()
  await expect(
    writeSkyAssets(join(dir, 'assets'), join(dir, 'missing-stars.bin'))
  ).rejects.toMatchObject({ code: 'ENOENT' })
})
