// The off-proof for the cirrus deck, in the shape docs/design/cloud-types.md
// section 7 asks every sibling to use: a default context must still compile to
// exactly what main did, and the option must reach the march program
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
function compilePass(cirrusDeck: boolean): PassMaterials {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  // On the pass's own context, which is the only one the graph reads
  if (cirrusDeck) pass.cloudsContext.experimental = { cirrusDeck: true }
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
const memo = new Map<boolean, PassMaterials>()

function materialsWith(cirrusDeck: boolean): PassMaterials {
  const cached = memo.get(cirrusDeck)
  if (cached != null) return cached
  const materials = compilePass(cirrusDeck)
  memo.set(cirrusDeck, materials)
  return materials
}

// Explicit-LOD reads in a program. The deck adds exactly one, its texture
const sampleLevels = (wgsl: string): number =>
  (wgsl.match(/textureSampleLevel\(/g) ?? []).length

describe(
  'the cirrus deck is byte-identical to main when off',
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
      const off = materialsWith(false)
      const digest = digestOf(off)
      table('cirrus-deck-off-digest', [
        {
          field: 'whole-pass sha256 (16)',
          expected: MAIN_DEFAULT_DIGEST,
          actual: digest,
          delta: digest === MAIN_DEFAULT_DIGEST ? 0 : 1
        },
        { field: 'march bytes', expected: '>0', actual: off.march.length }
      ])
      // A digest of nothing would satisfy this by not existing
      expect(off.march.length).toBeGreaterThan(0)
      expect(digest).toBe(MAIN_DEFAULT_DIGEST)
    })

    it('the option adds the deck to the march and nothing else', () => {
      const off = materialsWith(false)
      const on = materialsWith(true)
      const keys = Object.keys(off) as Array<keyof PassMaterials>
      const rows: Array<{ field: string; expected: string; actual: string }> =
        keys.map(key => ({
          field: key,
          expected: key === 'march' ? 'differs' : 'same',
          actual: on[key] === off[key] ? 'same' : 'differs'
        }))
      rows.push({
        field: 'march textureSampleLevel calls, on - off',
        expected: '1',
        actual: String(sampleLevels(on.march) - sampleLevels(off.march))
      })
      table('cirrus-deck-on-programs', rows)
      log('cirrus deck on digest', {
        off: digestOf(off),
        on: digestOf(on),
        offMarchBytes: off.march.length,
        onMarchBytes: on.march.length
      })
      // Without this the off proof could pass because the guarded block emits
      // nothing at all, which is the failure this pair exists to catch
      expect(on.march).not.toBe(off.march)
      for (const key of keys) {
        if (key !== 'march') expect(on[key], key).toBe(off[key])
      }
      expect(sampleLevels(on.march) - sampleLevels(off.march)).toBe(1)
    })
  }
)
