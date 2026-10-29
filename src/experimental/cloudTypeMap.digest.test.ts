// the morph is opt-in, so with it off the port's compiled WGSL must
// be byte-identical to origin/main's. The cloud-types.md 7 shape: digest the
// WGSL, not a screenshot, and check both halves. See docs/EXPERIMENTAL.md for
// what the literal below was measured against

import { createHash } from 'node:crypto'
import { Data3DTexture, PerspectiveCamera, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { WebGPUBackend, type Node } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import { createCloudTypeMap } from './cloudTypeMap'

// sha256 of normalizeWGSL(fragment) with cloudTypeMap off. Re-pinned for the
// stbnMarch rename, then for the shells moving to the core intersection helper
const MAIN_MARCH_FRAGMENT_SHA256 =
  '63572e09b1e3055a978fcee87a065d1124ef7915f9365e31d40ea72f3eade298'

function digest(wgsl: string): string {
  return createHash('sha256').update(normalizeWGSL(wgsl)).digest('hex')
}

interface PassInternals {
  material: { fragmentNode: Node }
}

const internals = (p: CloudsPassNode): PassInternals =>
  p as unknown as PassInternals

// The march fragment reaches the atmosphere's LUT builder, which asks the
// backend for a device feature the compile stub does not have. Same stub the
// PCF test in CloudsPassNode.test.ts uses
function withoutDevice<T>(run: () => T): T {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  const original = backend.hasFeature
  backend.hasFeature = () => false
  const stbnLoad = vi
    .spyOn(STBNLoader.prototype, 'loadAsync')
    .mockResolvedValue(new Data3DTexture())
  try {
    return run()
  } finally {
    backend.hasFeature = original
    stbnLoad.mockRestore()
  }
}

function atmosphereContext(): Node {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const contextNode = tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({})
  })
  if (contextNode == null) throw new Error('tslContext returned null')
  return contextNode
}

/** Compile the march fragment of one context in its current flag state */
function marchFragment(pass: CloudsPassNode): string {
  // Builds the whole pass graph for the flag state it is in now
  compileWGSL(pass.composite(texture(new Texture())))
  const fragmentNode = internals(pass).material.fragmentNode
  if (fragmentNode == null) throw new Error('the march has no fragment')
  return compileWGSL(fragmentNode, {
    renderTarget: pass.layerRT,
    contextNode: atmosphereContext()
  }).fragment
}

describe('the morph is byte-identical-off (docs/design/cloud-types.md 7)', () => {
  setCurrentSpec('cloudTypeMap-digest')

  // ONE test on purpose. Building the pass leaves residue a second test in the
  // same file inherits, and a literal from a two-test file never reproduced
  it('digests the march fragment as main does when off, and moves when on', () => {
    const [off, on] = withoutDevice(() => {
      const pass = clouds({ sceneDepth: null })
      pass.cloudsContext.cloudTypes.setMap(
        createCloudTypeMap({ size: 32, cells: 2 })
      )
      // The map is authored on purpose. Only the flag gates it, so a map with
      // no flag must leave the program alone
      const before = digest(marchFragment(pass))
      pass.cloudsContext.experimental = { cloudTypeMap: true }
      const after = digest(marchFragment(pass))
      return [before, after] as const
    })
    log('march fragment digest', [
      {
        field: 'sha256 (morph off)',
        expected: MAIN_MARCH_FRAGMENT_SHA256,
        actual: off
      },
      { field: 'sha256 (morph on)', expected: '!= off', actual: on }
    ])
    // 1. off equals main. A feature that never reached the shader would pass
    //    this alone
    expect(off).toBe(MAIN_MARCH_FRAGMENT_SHA256)
    // 2. on differs. A feature that leaked into the default path, or a blend
    //    that dropped its weights, would pass that alone
    expect(on).not.toBe(off)
  })
})
