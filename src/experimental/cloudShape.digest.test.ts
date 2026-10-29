// The off-and-on proof for the four shape controls, in the shape
// docs/design/cloud-types.md section 7 asks every sibling to use
// The OFF arm against main is two other files, not a literal here:
// defaultOutputDigest.test.ts and graphVariantDigest.baseline.json, which pin
// main-measured digests that the graph-time branches below must not move
import { createHash } from 'node:crypto'
import { Data3DTexture, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { PerspectiveCamera, WebGPUBackend, type Node } from 'three/webgpu'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { CloudsContext } from '../CloudsContext'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import {
  buildCloudShapeDeps,
  cloudShapeDefaults,
  type CloudShapeParams
} from './cloudShape'

const digest = (wgsl: string) =>
  createHash('sha256').update(normalizeWGSL(wgsl)).digest('hex')

// The march fragment of a context with `params` applied, as WGSL. The whole
// pass rather than the density chain alone, because two of the four seams live
// in primaryMarch and the density-chain helper cannot see them
function compileMarch(ctx: CloudsContext): string {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  pass.cloudsContext.experimental = ctx.experimental
  pass.cloudsContext.cloudShape = { ...ctx.cloudShape }

  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const contextNode = tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({}) as never
  })
  // The pass builds its own materials inside setup(), and only the composite
  // reaches it, so this call is what makes the march fragment exist
  compileWGSL(pass.composite(texture(new Texture())), {
    contextNode,
    features: []
  })
  const material = (
    pass as unknown as {
      material: { fragmentNode: Node | null }
    }
  ).material
  const wgsl =
    material.fragmentNode == null
      ? ''
      : normalizeWGSL(
          compileWGSL(material.fragmentNode, {
            renderTarget: pass.layerRT,
            contextNode,
            features: []
          }).fragment
        )
  pass.dispose()
  return wgsl
}

const ON: Record<string, Partial<CloudShapeParams>> = {
  baseShadow: { baseShadowStrength: 1.4, baseShadowHeight: 0.35 },
  horizonCoverage: {
    horizonCoverageAmount: 0.25,
    horizonCoverageStart: 4000,
    horizonCoverageRamp: 30000
  },
  windSkew: { windSkewEast: 260, windSkewNorth: -90 },
  erosion: { erosionShape: 0.8 }
}

describe('the four cloud-shape controls', () => {
  let originalHasFeature: () => boolean
  beforeAll(() => {
    // The atmosphere LUT accessors ask the BACKEND for float-linear support
    // and the stub has no device (graphVariantDigest.test.ts does the same)
    const backend = WebGPUBackend.prototype as unknown as {
      hasFeature: () => boolean
    }
    originalHasFeature = backend.hasFeature
    backend.hasFeature = () => false
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

  it(
    'leaves the default graph byte-identical and moves it per feature',
    { timeout: 120_000 },
    () => {
      const off = compileMarch(new CloudsContext())
      const rows: Array<{
        feature: string
        bytes: number
        offDigest: string
        onDigest: string
        differs: boolean
      }> = []
      const onDigests = new Map<string, string>()

      for (const [feature, params] of Object.entries(ON)) {
        const ctx = new CloudsContext()
        ctx.cloudShape = { ...cloudShapeDefaults, ...params }
        const on = compileMarch(ctx)
        onDigests.set(feature, digest(on))
        rows.push({
          feature,
          bytes: on.length,
          offDigest: digest(off).slice(0, 12),
          onDigest: digest(on).slice(0, 12),
          differs: on !== off
        })
      }
      table('cloud-shape-digests', rows)

      // A measurement over zero inputs is a failed measurement, not a result
      expect(
        off.length,
        'the march fragment compiled to nothing'
      ).toBeGreaterThan(1000)
      for (const [feature, params] of Object.entries(ON)) {
        expect(
          digest(
            compileMarch(
              Object.assign(new CloudsContext(), {
                cloudShape: { ...cloudShapeDefaults, ...params }
              })
            )
          ) !== digest(off),
          `${feature} compiles to the same WGSL as the default context`
        ).toBe(true)
      }
      // Each feature is its own graph, not four names for one branch
      expect(new Set(onDigests.values()).size).toBe(Object.keys(ON).length)
    }
  )

  it('gates each seam on its own value', () => {
    const deps = buildCloudShapeDeps(cloudShapeDefaults)
    table('cloud-shape-gates', [
      { seam: 'baseShadow', neutral: deps.baseShadow == null },
      { seam: 'horizonCoverage', neutral: deps.horizonCoverage == null },
      { seam: 'windSkew', neutral: deps.windSkew == null },
      { seam: 'erosion', neutral: deps.erosion == null }
    ])
    expect(deps).toEqual({
      baseShadow: null,
      horizonCoverage: null,
      windSkew: null,
      erosion: null
    })
    // One at a time, and a negative horizon amount is a real setting
    expect(
      buildCloudShapeDeps({ ...cloudShapeDefaults, erosionShape: -0.5 }).erosion
    ).not.toBeNull()
    expect(
      buildCloudShapeDeps({
        ...cloudShapeDefaults,
        horizonCoverageAmount: -0.2
      }).horizonCoverage
    ).not.toBeNull()
    expect(
      buildCloudShapeDeps({ ...cloudShapeDefaults, windSkewNorth: 1 }).windSkew
    ).not.toBeNull()
    // baseShadowStrength has no meaning below zero, so only positive opens it
    expect(
      buildCloudShapeDeps({ ...cloudShapeDefaults, baseShadowStrength: -1 })
        .baseShadow
    ).toBeNull()
    expect(
      buildCloudShapeDeps({ ...cloudShapeDefaults, baseShadowStrength: 0.1 })
        .baseShadow
    ).not.toBeNull()
  })

  it('rebuilds the pass when a knob moves', () => {
    const ctx = new CloudsContext()
    const before = ctx.graphVersion
    expect(ctx.checkCloudShape()).toBe(false)
    ctx.cloudShape = { ...cloudShapeDefaults, baseShadowStrength: 0.5 }
    expect(ctx.checkCloudShape()).toBe(true)
    expect(ctx.graphVersion).toBeGreaterThan(before)
    // A magnitude moving inside an open feature rebuilds too, because every
    // magnitude is a graph-time literal
    const after = ctx.graphVersion
    ctx.cloudShape = { ...cloudShapeDefaults, baseShadowStrength: 0.6 }
    expect(ctx.checkCloudShape()).toBe(true)
    expect(ctx.graphVersion).toBeGreaterThan(after)
    expect(ctx.checkCloudShape()).toBe(false)
  })

  it('reaches the cache key, so three cannot serve the old program', () => {
    const off = new CloudsContext().graphFlags()
    const on = new CloudsContext()
    on.cloudShape = { ...cloudShapeDefaults, erosionShape: 0.5 }
    table('cloud-shape-graph-flags', [
      {
        field: 'cloudShape',
        off: off.cloudShape,
        on: on.graphFlags().cloudShape
      }
    ])
    expect(on.graphFlags().cloudShape).not.toBe(off.cloudShape)
    // Every experimental combination shares one cloudShape value, so the new
    // flag cannot be folded into experimentalFlags and change those digests
    expect(on.graphFlags().experimentalFlags).toBe(off.experimentalFlags)
  })
})
