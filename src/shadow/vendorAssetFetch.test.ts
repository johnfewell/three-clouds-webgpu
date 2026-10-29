// A CPU graph build must not reach the network. The vendor defaults it touches
// fetch 1 MB assets whose loader constructs `ProgressEvent`, a browser global,
// after the test body returned: a red check with green tests, seen only
// under load
import { DepthTexture, PerspectiveCamera, Texture } from 'three'
import { float, texture, context as tslContext, vec2 } from 'three/tsl'
import { WebGPUBackend } from 'three/webgpu'
import { afterAll, describe, expect, it } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { vendorAssetRequests } from '../../test/helpers/setup'
import { aerialPerspectiveWithCloudShadow } from './aerialShadowAdapter'

// The compile stub has no device; hasFeature() would deref null
;(
  WebGPUBackend.prototype as unknown as { hasFeature: () => boolean }
).hasFeature = () => false

// Counts every ProgressEvent three's loader constructs. A real `ProgressEvent`
// does not exist in node, so this stands in for it: any construction at all
// means the loader was going to throw, wherever it happened
const progressEvents: number[] = []

function buildAerialGraph(): void {
  const ctx = new AtmosphereContext()
  ;(ctx as never as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const cn = tslContext({
    getAtmosphere: () => ctx,
    getClouds: () => ({})
  }) as never
  const node = aerialPerspectiveWithCloudShadow(
    texture(new Texture()),
    texture(new DepthTexture(4, 4)),
    vec2(0, 0),
    float(1),
    texture(new Texture())
  )
  compileWGSL(node as never, { contextNode: cn })
}

describe('a node test builds graphs without touching the network', () => {
  it('answers the vendor assets from memory instead of fetching 2 MB', () => {
    const before = vendorAssetRequests.count
    buildAerialGraph()
    // The graph still builds. What changed is that nothing left the process
    expect(vendorAssetRequests.count).toBeGreaterThan(before)
  })

  it('never constructs a ProgressEvent, so no callback can land after teardown', async () => {
    const original = Reflect.get(globalThis, 'ProgressEvent')
    Reflect.set(
      globalThis,
      'ProgressEvent',
      class {
        constructor(_type: string, init: { loaded?: number }) {
          progressEvents.push(init.loaded ?? 0)
        }
      }
    )
    const before = vendorAssetRequests.count
    try {
      buildAerialGraph()
      // the window load opens on its own: the reader loop ticks after the body
      await new Promise(resolve => setTimeout(resolve, 250))
    } finally {
      if (original === undefined)
        Reflect.deleteProperty(globalThis, 'ProgressEvent')
      else Reflect.set(globalThis, 'ProgressEvent', original)
    }
    // Both halves, so this cannot pass on network timing. With the stub gone
    // the counter does not move, whatever the network happens to do
    expect(vendorAssetRequests.count).toBeGreaterThan(before)
    expect(progressEvents).toEqual([])
  })

  it('node has no ProgressEvent, which is why the loader must not run', () => {
    // The failing shape: a rejection raised after the body returns. Vitest
    // surfaces it as an unhandled error and exits 1 with every test passing,
    // which is why this is a guard on its own rather than a comment
    expect(typeof Reflect.get(globalThis, 'ProgressEvent')).toBe('undefined')
  })
})

// Kept out of the suite's own lifetime: nothing should still be reading here
afterAll(() => {
  expect(progressEvents).toEqual([])
})
