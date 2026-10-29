// pins that the guard refuses BY NAME,
// listing every missing asset, and that its list still matches what
// scripts/setup-assets.mjs provisions. The drift check READS that script:
// importing it would run its argv parsing and process.exit

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  assertParityAssets,
  MissingParityAssetsError,
  PARITY_ASSETS
} from './assetGuard'

// Not String(input): a Request stringifies to '[object Object]', so the mock
// would answer 200 to everything and stop discriminating (eslint's
// no-base-to-string caught it, no test would have)
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url

const okFetch: typeof fetch = () =>
  Promise.resolve(new Response(null, { status: 200 }))
const missingFetch: typeof fetch = input =>
  Promise.resolve(
    new Response(null, {
      status: urlOf(input).includes('shape.bin') ? 404 : 200
    })
  )
const throwingFetch: typeof fetch = () =>
  Promise.reject(new TypeError('network'))

describe('parity asset boot guard', () => {
  it('passes when every asset resolves', async () => {
    await expect(assertParityAssets(okFetch)).resolves.toBeUndefined()
  })

  it('refuses BY NAME, and names the instruction', async () => {
    await expect(assertParityAssets(missingFetch)).rejects.toThrow(
      /missing assets: shape\.bin/
    )
    await expect(assertParityAssets(missingFetch)).rejects.toThrow(
      /pnpm setup-assets/
    )
  })

  it('names EVERY missing asset, not just the first', async () => {
    // The timeout it replaces reported nothing, and a guard that reported only
    // the first would send you round the loop once per file
    await expect(assertParityAssets(throwingFetch)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof MissingParityAssetsError &&
        e.missing.length === PARITY_ASSETS.length
    )
  })

  it('settles every HEAD response before returning or refusing', async () => {
    const calls: Array<{ name: string; method: string | undefined }> = []
    const settled: string[] = []
    const fetchWithTrackedBodies: typeof fetch = (input, init) => {
      const name = urlOf(input).split('/').at(-1) ?? ''
      calls.push({ name, method: init?.method })
      const response = new Response(null, {
        status: name === 'shape.bin' ? 404 : 200
      })
      const arrayBuffer = response.arrayBuffer.bind(response)
      response.arrayBuffer = async () => {
        settled.push(name)
        return arrayBuffer()
      }
      return Promise.resolve(response)
    }

    await expect(assertParityAssets(fetchWithTrackedBodies)).rejects.toThrow(
      /missing assets: shape\.bin/
    )
    expect(calls).toEqual(PARITY_ASSETS.map(name => ({ name, method: 'HEAD' })))
    expect(settled.sort()).toEqual([...PARITY_ASSETS].sort())
  })

  it('covers exactly what setup-assets.mjs provisions', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'scripts', 'setup-assets.mjs'),
      'utf8'
    )
    const block = src.slice(src.indexOf('const ASSETS = ['))
    const provisioned = [
      ...block.slice(0, block.indexOf(']')).matchAll(/name: '([^']+)'/g)
    ].map(m => m[1])

    expect(
      provisioned.length,
      'could not parse the ASSETS list out of setup-assets.mjs — the drift ' +
        'check is blind, which is worse than absent'
    ).toBeGreaterThan(0)
    expect(
      [...provisioned].sort(),
      'the boot guard and the provisioning script disagree about which assets ' +
        'exist; whichever is short reintroduces the silent hang for that file'
    ).toEqual([...PARITY_ASSETS].sort())
  })
})
