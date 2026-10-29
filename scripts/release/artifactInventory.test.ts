import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  hash,
  verifyFiles
} from '../../examples/parity/scripts/consumer-native/proof.mjs'
import { log } from '../../test/helpers/log'
import { fileDigest, sha256 } from './pack-provenance.mjs'
import { digest, publicationFiles } from './public-scan.mjs'
import { digestFiles, regularFilesWithin } from './qualify-consumer.mjs'

// the inventory the consumer qualification and the native proof
// share, pinned byte for byte to what the two separate walkers produced,
// and the refusals each caller keeps

const FIXTURE = {
  'a.txt': 'alpha\n',
  'a/b.txt': 'beta\n',
  'a/c/d.bin': 'delta',
  'z.md': '# zed\n'
}
// Recorded from the unmodified walkers before the consolidation
const GOLDEN = {
  qualifySha256:
    'e2f47cbcaae970f783f660431ef7c8be9e8b1b1f04af041472c72094b4f21d27',
  provenanceSha256:
    '055942383882f5ddec89aab259054be5f31824bc6a90beac2a5dc9175369e405',
  sortedOrder: ['a.txt', 'a/b.txt', 'a/c/d.bin', 'z.md'],
  // The publication scan walks each level sorted, so the directory a comes
  // before the file a.txt. It is not the shared inventory on purpose
  publicationOrder: ['a/b.txt', 'a/c/d.bin', 'a.txt', 'z.md']
}

const roots: string[] = []
function fixture(contents: Record<string, string> = FIXTURE): string {
  const root = mkdtempSync(join(tmpdir(), 'clouds-inventory-'))
  roots.push(root)
  for (const [path, text] of Object.entries(contents)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const refuse = (kind: string, path: string): never => {
  throw new Error(`test refusal: ${kind} ${path}`)
}

describe('the shared artifact inventory', () => {
  it('reproduces the receipts the separate walkers wrote', () => {
    const root = fixture()
    const qualify = digestFiles(root)
    const provenance = fileDigest(root, Object.keys(FIXTURE))
    const publication = publicationFiles(root).map(file => file.path)
    const native = verifyFiles(root, qualify, true)
    log('inventory-golden', [
      {
        field: 'digestFiles sha256',
        expected: GOLDEN.qualifySha256,
        actual: qualify.sha256
      },
      {
        field: 'fileDigest sha256',
        expected: GOLDEN.provenanceSha256,
        actual: provenance.sha256
      },
      {
        field: 'publication order',
        expected: GOLDEN.publicationOrder.join(' '),
        actual: publication.join(' ')
      }
    ])
    expect(regularFilesWithin(root, refuse)).toEqual(GOLDEN.sortedOrder)
    expect(Object.keys(qualify.files)).toEqual(GOLDEN.sortedOrder)
    expect(qualify.sha256).toBe(GOLDEN.qualifySha256)
    expect(Object.keys(provenance.files)).toEqual(GOLDEN.sortedOrder)
    expect(provenance.sha256).toBe(GOLDEN.provenanceSha256)
    expect(publication).toEqual(GOLDEN.publicationOrder)
    expect(native).toBe(GOLDEN.qualifySha256)
  })

  it('is one sha256 under three names, the public scan keeping its own copy', () => {
    const bytes = Buffer.from('the same bytes')
    expect(hash).toBe(sha256)
    expect(digest).not.toBe(sha256)
    expect(digest(bytes)).toBe(sha256(bytes))
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('refuses a symlink through the caller, naming the kind and the path', () => {
    const root = fixture()
    symlinkSync(join(root, 'a.txt'), join(root, 'alias'))
    const seen: Array<[string, string]> = []
    expect(() =>
      regularFilesWithin(root, (kind, path) => {
        seen.push([kind, path])
        throw new Error('stopped')
      })
    ).toThrow('stopped')
    expect(seen).toEqual([['symlink', join(root, 'alias')]])
    expect(() => digestFiles(root)).toThrow('Refusing symlink in artifact')
    expect(() => verifyFiles(root, digestFiles(fixture()), true)).toThrow(
      'artifact contains a symlink'
    )
  })

  it('refuses a special file through the caller', () => {
    const root = fixture()
    execFileSync('mkfifo', [join(root, 'pipe')])
    expect(() => regularFilesWithin(root, refuse)).toThrow(
      `test refusal: special ${join(root, 'pipe')}`
    )
    expect(() => digestFiles(root)).toThrow('Refusing non-file artifact')
    expect(() => verifyFiles(root, digestFiles(fixture()), true)).toThrow(
      'artifact contains a special file'
    )
  })

  it('throws itself when a refusal returns instead of throwing', () => {
    const root = fixture()
    symlinkSync(join(root, 'a.txt'), join(root, 'alias'))
    expect(() =>
      regularFilesWithin(root, (() => undefined) as unknown as () => never)
    ).toThrow('REFUSING: symlink in artifact inventory')
  })

  it('returns [] for an empty root and leaves the zero-file refusal to each caller', () => {
    const root = fixture({})
    expect(regularFilesWithin(root, refuse)).toEqual([])
    expect(() => digestFiles(root)).toThrow('Refusing empty artifact')
    expect(() => verifyFiles(root, digestFiles(fixture()), true)).toThrow(
      'file inventory changed'
    )
    expect(() => regularFilesWithin(join(root, 'missing'), refuse)).toThrow(
      'ENOENT'
    )
  })

  it('keeps the two sites coherent under tampering', () => {
    const root = fixture()
    const manifest = digestFiles(root)
    expect(verifyFiles(root, manifest, true)).toBe(manifest.sha256)
    writeFileSync(join(root, 'a/b.txt'), 'beta!\n')
    expect(() => verifyFiles(root, manifest)).toThrow('changed file')
    expect(digestFiles(root).sha256).not.toBe(manifest.sha256)
    writeFileSync(join(root, 'a/b.txt'), FIXTURE['a/b.txt'])
    writeFileSync(join(root, 'extra.txt'), 'extra')
    expect(() => verifyFiles(root, manifest, true)).toThrow(
      'file inventory changed'
    )
    expect(verifyFiles(root, manifest)).toBe(manifest.sha256)
  })
})
