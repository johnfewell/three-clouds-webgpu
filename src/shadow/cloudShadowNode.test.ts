// The public cloud shadow for a consumer's own materials. Cite:
// ADR-007 (the shadow consumers), clouds.frag:221-250 (the sampler entry point)

// WHY a digest and not a screenshot: a pixel test would pass for a
// reimplementation that merely looks similar. The sampler is shared by
// construction, and this fails the moment that stops being true

import { createHash } from 'node:crypto'
import { Matrix4, Vector2, Vector3 } from 'three'
import { uniform, vec3, vec4 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { clouds } from '../CloudsPassNode'
import {
  createCloudShadowNode,
  type CloudShadowNodeDeps
} from './cloudShadowNode'
import { createCloudShadowTransmittance } from './sampleCloudShadowOpticalDepth'

const digest = (wgsl: string): string =>
  createHash('sha256').update(wgsl).digest('hex')

// The nine deps the ground consumer assembles by hand, plus the world -> ECEF
// matrix the public node adds. Kept explicit so the two arms of the
// equivalence test cannot drift apart through the pass's private uniforms
function makeDeps(pass: ReturnType<typeof clouds>): CloudShadowNodeDeps {
  return {
    descriptor: pass.cloudShadow,
    viewMatrix: uniform(new Matrix4()),
    cameraNear: uniform(0.1),
    sunDirection: uniform(new Vector3(0, 0, 1)),
    bottomRadius: uniform(6360000),
    ecefToWorldMatrix: uniform(new Matrix4()),
    worldToECEFMatrix: uniform(new Matrix4()),
    altitudeCorrection: uniform(new Vector3()),
    worldToUnit: uniform(1 / 6360000),
    temporalJitter: uniform(new Vector2()),
    resolution: uniform(new Vector2(2048, 2048))
  }
}

async function compileFragment(node: unknown): Promise<string> {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  return compileWGSL(node as never).fragment
}

describe('cloudShadowAt', () => {
  setCurrentSpec('cloudShadowAt')

  it("is the ground consumer's transmittance, byte for byte", async () => {
    const pass = clouds({ sceneDepth: null })
    const deps = makeDeps(pass)

    // Arm A: what the aerial perspective calls, verbatim from the reference
    // consumer's own recipe (examples/basic/src/main.ts:186, parity
    // sideB.ts:391): world -> ECEF metres, plus the altitude correction
    const ground = createCloudShadowTransmittance(deps.descriptor, deps)
    // Both arms take the position as a vec3 NODE and splat it into the vec4, so
    // the digests compare the two graphs and not the two ways of writing a
    // literal
    const position = vec3(1, 2, 3)
    const armA = await compileFragment(
      vec3(
        ground(
          deps.worldToECEFMatrix
            .mul(vec4(position.x, position.y, position.z, 1))
            .xyz.add(deps.altitudeCorrection),
          3,
          0
        )
      )
    )

    // Arm B: the public node, which must be the same graph with the conversion
    // folded in
    const armB = await compileFragment(
      vec3(createCloudShadowNode(deps)(position, 3, 0))
    )

    const digests = { ground: digest(armA), public: digest(armB) }
    log('cloudShadowAt-equivalence', {
      ...digests,
      identical: digests.ground === digests.public,
      wgslChars: armA.length
    })

    // Same maths, not a lookalike. A divergence here means the public node has
    // forked from the consumer the aerial pass grades against
    expect(digests.public).toBe(digests.ground)
  })

  it('reads the atlas with an EXPLICIT LOD inside the PCF loop', async () => {
    const pass = clouds({ sceneDepth: null })
    const fragment = await compileFragment(
      vec3(pass.cloudShadowAt(vec3(1, 2, 3)))
    )

    // an implicit-LOD sample under per-pixel If/Break is undefined in
    // WGSL and Dawn returns ~zeros, which reads as "the feature is off" rather
    // than "the feature is wrong"
    const explicitLod = (fragment.match(/textureSampleLevel/g) ?? []).length
    const implicitLod = (fragment.match(/textureSample\(/g) ?? []).length

    log('cloudShadowAt-atlas-read', {
      textureSampleLevel: explicitLod,
      textureSample: implicitLod,
      textureLoad: (fragment.match(/textureLoad/g) ?? []).length,
      hasExp: fragment.includes('exp(')
    })

    // Without this the material would sample zeros and render unshadowed, and
    // nothing about the frame would say why
    expect(explicitLod).toBeGreaterThan(0)
    expect(implicitLod).toBe(0)
    expect(fragment).toContain('exp(')
  })

  it('multiplies a material by a 0..1 transmittance (CPU twin)', async () => {
    const { cpuCloudShadowTransmittance } = await import('./cloudShadowNode')
    // The optical depths the ground consumer's sampler produces: 0 in the open
    // sky, and thick under a cloud. exp(-od) is what a material multiplies by,
    // so 0 is FULLY SHADOWED and 1 is fully lit
    const rows = [0, 0.5, 1, 2.302585092994046, 5]
    const table = rows.map(od => ({
      opticalDepth: od,
      expected: Math.exp(-od),
      actual: cpuCloudShadowTransmittance(od)
    }))
    for (const row of table) {
      log('cloudShadowAt-cpu-twin', row)
      expect(row.actual).toBeCloseTo(row.expected, 12)
    }
    // A material multiplying by the RAW optical depth would darken in the open
    // sky, the inverse of the shadow
    expect(cpuCloudShadowTransmittance(0)).toBe(1)
    expect(cpuCloudShadowTransmittance(5)).toBeLessThan(0.01)
    for (const row of table) {
      expect(row.actual).toBeGreaterThanOrEqual(0)
      expect(row.actual).toBeLessThanOrEqual(1)
    }
  })

  it('leaves the pass alone: no descriptor write, no graph rebuild', () => {
    const pass = clouds({ sceneDepth: null })
    const descriptor = pass.cloudShadow
    // SENTINELS, not the initial values. far and topHeight both start at 0,
    // and a helper that wrote 0 into a 0 would pass a before/after comparison
    descriptor.far.value = 12_345
    descriptor.topHeight.value = 54_321
    descriptor.cascadeCount = 3
    descriptor.texelSize.value.set(1 / 2048, 1 / 1024)
    const snapshot = () => ({
      map: descriptor.map,
      mapNode: descriptor.mapNode.value,
      cascadeCount: descriptor.cascadeCount,
      far: descriptor.far.value,
      topHeight: descriptor.topHeight.value,
      texelSize: descriptor.texelSize.value.toArray(),
      // Identity, not value: a replaced Matrix4 of equal value would read the
      // same to toEqual and orphan every consumer that captured the array
      matrices: descriptor.matrices.array.slice(),
      inverseMatrices: descriptor.inverseMatrices.array.slice(),
      intervals: descriptor.intervals.array.slice(),
      graphVersion: pass.cloudsContext.graphVersion
    })
    const before = snapshot()

    pass.cloudShadowAt(vec3(1, 2, 3))
    // A second call must reuse the builder rather than minting another one,
    // which would double the sampler in every consuming material
    pass.cloudShadowAt(vec3(4, 5, 6))
    const after = snapshot()

    const identityHeld = (['matrices', 'inverseMatrices', 'intervals'] as const)
      .flatMap(key => after[key].map((v, i) => v === before[key][i]))
      .every(Boolean)

    log('cloudShadowAt-pass-untouched', {
      mapHeld: after.map === before.map,
      mapNodeHeld: after.mapNode === before.mapNode,
      arrayIdentityHeld: identityHeld,
      cascadeCount: after.cascadeCount,
      far: after.far,
      topHeight: after.topHeight,
      graphVersionHeld: after.graphVersion === before.graphVersion
    })

    // The helper is opt-in by construction: asking for it must not reach into
    // the pass's own state, or an unused call site could change a pixel
    expect(after).toEqual(before)
    expect(identityHeld).toBe(true)
    expect(after.graphVersion).toBe(before.graphVersion)
  })
})
