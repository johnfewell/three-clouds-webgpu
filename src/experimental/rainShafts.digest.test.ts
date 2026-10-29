// The off-proof for the storm shafts, in the shape docs/design/cloud-types.md
// section 7 asks every sibling to use: a default context must still compile to
// exactly what main did
//
// The subject is the WHOLE pass: no sampler on main could stand for it

import { createHash } from 'node:crypto'
import { Data3DTexture, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { PerspectiveCamera, WebGPUBackend, type Node } from 'three/webgpu'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import BASELINE from '../pass/graphVariantDigest.baseline.json'

// graphVariantDigest.baseline.json's `default` entry on the pinned main: every
// program the pass owns, with every experimental option at its default. Read
// rather than retyped, so the two cannot drift
const MAIN_DEFAULT_DIGEST = BASELINE.default

interface PassMaterials {
  composite: string
  march: string
  shadow: string
  shadowResolve: string
  resolve: string
}

// graphVariantDigest.test.ts's compilePass, at its `default` variant: no scene
// depth, no subgroups
function compilePass(rainShafts: boolean): PassMaterials {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  // On the pass's own context, which is the only one the graph reads
  if (rainShafts) pass.cloudsContext.experimental = { rainShafts: true }
  const dst = texture(new Texture())
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const contextNode = tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({}) as never
  })

  const out: PassMaterials = {
    composite: normalizeWGSL(
      compileWGSL(pass.composite(dst), { contextNode, features: [] }).fragment
    ),
    march: '',
    shadow: '',
    shadowResolve: '',
    resolve: ''
  }

  const anyPass = pass as unknown as {
    material: { fragmentNode: Node | null }
    shadowMaterial: { fragmentNode: Node | null }
    shadowResolveMaterial: { fragmentNode: Node | null }
    resolveMaterial: { fragmentNode: Node | null }
    shadowRT: unknown
  }
  if (anyPass.material.fragmentNode != null) {
    out.march = normalizeWGSL(
      compileWGSL(anyPass.material.fragmentNode, {
        renderTarget: pass.layerRT,
        contextNode,
        features: []
      }).fragment
    )
  }
  if (anyPass.shadowMaterial.fragmentNode != null) {
    out.shadow = normalizeWGSL(
      compileWGSL(anyPass.shadowMaterial.fragmentNode, {
        renderTarget: anyPass.shadowRT,
        contextNode,
        features: []
      }).fragment
    )
  }
  if (anyPass.shadowResolveMaterial.fragmentNode != null) {
    out.shadowResolve = normalizeWGSL(
      compileWGSL(anyPass.shadowResolveMaterial.fragmentNode, {
        renderTarget: anyPass.shadowRT,
        contextNode,
        features: []
      }).fragment
    )
  }
  if (anyPass.resolveMaterial.fragmentNode != null) {
    out.resolve = normalizeWGSL(
      compileWGSL(anyPass.resolveMaterial.fragmentNode, {
        renderTarget: pass.resolveRT,
        contextNode,
        features: []
      }).fragment
    )
  }
  pass.dispose()
  return out
}

function digestOf(materials: PassMaterials): string {
  return createHash('sha256')
    .update(
      (Object.keys(materials) as Array<keyof PassMaterials>)
        .map(k => `${k} ${materials[k]}`)
        .join('')
    )
    .digest('hex')
    .slice(0, 16)
}

// Compiled once each and kept, because a second compile of the same graph in
// one process is not guaranteed to hash the same, and the off arm has to be the
// same bytes the literal was taken from
interface Arm {
  digest: string
  bytes: number
  march: string
}

const memo = new Map<boolean, Arm>()

function digestWith(rainShafts: boolean): Arm {
  const cached = memo.get(rainShafts)
  if (cached != null) return cached
  const materials = compilePass(rainShafts)
  const present = (Object.keys(materials) as Array<keyof PassMaterials>).filter(
    k => materials[k].length > 0
  )
  const out = {
    digest: digestOf(materials),
    bytes: materials[present[0]!].length,
    march: materials.march
  }
  memo.set(rainShafts, out)
  return out
}

// The cell mask's Perlin, and the shaft's lean constant as the compiler prints
// it, so "the graph moved" cannot be satisfied by some unrelated difference
const CELL_PERLIN = 'mx_perlin_noise_float_0('
const LEAN = '0.9285456809284321'

describe(
  'rain shafts are byte-identical to main when off',
  { timeout: 600_000 },
  () => {
    let originalHasFeature: () => boolean
    beforeAll(() => {
      // The atmosphere LUT accessors ask the BACKEND for float-linear support and
      // the stub has no device, so every compile reports garbage
      const backend = WebGPUBackend.prototype as unknown as {
        hasFeature: () => boolean
      }
      originalHasFeature = backend.hasFeature
      backend.hasFeature = () => false
      // The STBN node fetches stbn.bin from GitHub, and in Node the stream throws
      vi.spyOn(STBNLoader.prototype, 'loadAsync').mockResolvedValue(
        new Data3DTexture()
      )
    })
    afterAll(() => {
      const backend = WebGPUBackend.prototype as unknown as {
        hasFeature: () => boolean
      }
      backend.hasFeature = originalHasFeature
    })

    it('the pass with the option off is the pass main compiled', () => {
      const off = digestWith(false)
      table('rain-shafts-off-digest', [
        {
          field: 'whole-pass sha256 (16)',
          expected: MAIN_DEFAULT_DIGEST,
          actual: off.digest,
          delta: off.digest === MAIN_DEFAULT_DIGEST ? 0 : 1
        },
        { field: 'first program bytes', expected: '>0', actual: off.bytes }
      ])
      log('rain shafts off digest', {
        digest: off.digest,
        matchesMain: off.digest === MAIN_DEFAULT_DIGEST,
        bytes: off.bytes
      })
      // A digest of nothing would satisfy this by not existing
      expect(off.digest).not.toBe('')
      expect(off.bytes).toBeGreaterThan(0)
      expect(off.digest).toBe(MAIN_DEFAULT_DIGEST)
    })

    it('the pass with the option on emits a different graph', () => {
      const off = digestWith(false)
      const on = digestWith(true)
      const perlin = (arm: Arm) =>
        (arm.march.match(/mx_perlin_noise_float_0\(/g) ?? []).length
      log('rain shafts on digest', {
        off: off.digest,
        on: on.digest,
        differsFromOff: on.digest !== off.digest,
        offPerlinCalls: perlin(off),
        onPerlinCalls: perlin(on),
        onHasLean: on.march.includes(LEAN),
        offHasLean: off.march.includes(LEAN)
      })
      // Without this the test above could pass because the guarded block emits
      // nothing at all, which is the failure this whole pair exists to catch
      expect(on.digest).not.toBe(off.digest)
      expect(on.bytes).toBeGreaterThan(0)
      // The march shader is where the shafts live, so the cell lattice and the
      // lean constant are what the option has to add to it, and `bytes` is the
      // small composite rather than the program that grew
      expect(on.march.length).toBeGreaterThan(off.march.length)
      expect(on.march.includes(LEAN)).toBe(true)
      expect(off.march.includes(LEAN)).toBe(false)
      expect(off.march.includes(CELL_PERLIN)).toBe(false)
      expect(perlin(on)).toBeGreaterThan(perlin(off))
    })
  }
)
