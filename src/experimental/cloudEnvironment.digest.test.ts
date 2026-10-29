// The screen pass's programs, with experimental.cloudEnvironment on and off
//
// "The ladder is unchanged when it is off" needs more than a default of false:
// the screen pass's WGSL must be the SAME with the option on. Byte equality is
// the only assertion that says so, and it is what src/pass/graphVariantDigest
// skips for SECONDARY_GRAPH_EXPERIMENTAL on this option's account

import { createHash } from 'node:crypto'
import { Data3DTexture, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { PerspectiveCamera, WebGPUBackend, type Node } from 'three/webgpu'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import {
  readsOutsideAssigningBlock,
  varsAssigned
} from '../../test/helpers/branchScope'
import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'

interface Compiled {
  composite: string
  march: string
  shadow: string
  shadowResolve: string
  resolve: string
  environment: string
  /** The bake fragment before normalizeWGSL, which joins its lines */
  environmentRaw: string
}

function stubContextNode() {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  return tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({}) as never
  })
}

function compile(cloudEnvironment: boolean): Compiled {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  pass.cloudsContext.experimental = { cloudEnvironment }

  const contextNode = stubContextNode()
  const dst = texture(new Texture())
  const out: Compiled = {
    composite: normalizeWGSL(
      compileWGSL(pass.composite(dst), { contextNode }).fragment
    ),
    march: '',
    shadow: '',
    shadowResolve: '',
    resolve: '',
    environment: '',
    environmentRaw: ''
  }

  const anyPass = pass as unknown as {
    material: { fragmentNode: Node | null }
    shadowMaterial: { fragmentNode: Node | null }
    shadowResolveMaterial: { fragmentNode: Node | null }
    resolveMaterial: { fragmentNode: Node | null }
    shadowRT: unknown
    resolveRT: unknown
    environment: {
      material: { fragmentNode: Node | null }
      setup(): Node | null
    }
  }

  const stage = (material: Node | null, renderTarget: unknown): string =>
    material == null
      ? ''
      : normalizeWGSL(
          compileWGSL(material, { renderTarget, contextNode }).fragment
        )

  out.march = stage(anyPass.material.fragmentNode, pass.layerRT)
  out.shadow = stage(anyPass.shadowMaterial.fragmentNode, anyPass.shadowRT)
  out.shadowResolve = stage(
    anyPass.shadowResolveMaterial.fragmentNode,
    anyPass.shadowRT
  )
  out.resolve = stage(anyPass.resolveMaterial.fragmentNode, anyPass.resolveRT)

  // The environment node's own material, which only exists with the option on
  // The cube target is what pmremTexture reads, and pmremTexture needs a real
  // texture, so the bake's own fragment is read off the material instead
  const bake = anyPass.environment.material.fragmentNode
  out.environmentRaw =
    bake == null ? '' : compileWGSL(bake, { contextNode }).fragment
  out.environment = out.environmentRaw && normalizeWGSL(out.environmentRaw)
  pass.dispose()
  return out
}

let originalHasFeature: (() => boolean) | undefined

beforeAll(() => {
  // The stub reports no device features, so the quad branch folds away
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  originalHasFeature = backend.hasFeature
  backend.hasFeature = () => false
  // The STBN node fetches stbn.bin from GitHub, and in Node the stream throws
  // "ProgressEvent is not defined"
  vi.spyOn(STBNLoader.prototype, 'loadAsync').mockResolvedValue(
    new Data3DTexture()
  )
})
afterAll(() => {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  backend.hasFeature = originalHasFeature ?? (() => false)
  vi.restoreAllMocks()
})

function digest(stages: Compiled): string {
  return createHash('sha256')
    .update(
      (Object.keys(stages) as Array<keyof Compiled>)
        .map(k => `${k} ${stages[k]}`)
        .join('')
    )
    .digest('hex')
    .slice(0, 16)
}

/** The pass's own five programs, which the ladder and the captures depend on */
function screenStages(stages: Compiled): string {
  return [
    stages.composite,
    stages.march,
    stages.shadow,
    stages.shadowResolve,
    stages.resolve
  ].join('')
}

describe('the cloud environment option leaves the screen pass alone', () => {
  it('compiles every pass program identically with it on and off', () => {
    const off = compile(false)
    const on = compile(true)
    log('environment-screen-digest', {
      screenOff: digest({ ...off, environment: '', environmentRaw: '' }),
      screenOn: digest({ ...on, environment: '', environmentRaw: '' }),
      environmentBytesOff: off.environment.length,
      environmentBytesOn: on.environment.length
    })
    expect(off.march.length, 'the off graph really compiled').toBeGreaterThan(
      1000
    )
    // The whole point: a consumer who turns this on has not moved the ladder
    expect(screenStages(on)).toBe(screenStages(off))
  })

  it('REJECTS a screen pass the option changed', () => {
    // The guard is worth its lines only if it fails on the drift it exists for,
    // so it mutates what it compares rather than asserting a constant
    const off = compile(false)
    const on = compile(true)
    const broken = { ...on, march: on.march.replace('fn ', 'fn x') }
    expect(screenStages(broken)).not.toBe(screenStages(off))
  })
})

describe('the environment bake is the cloud march over the sky', () => {
  it('compiles a march loop the off graph never builds', () => {
    const off = compile(false)
    const on = compile(true)
    log('environment-fragment-shape', {
      offBytes: off.environment.length,
      onBytes: on.environment.length,
      loops: (on.environment.match(/for\s*\(/g) ?? []).length,
      samplesWeather: on.environment.includes('textureSample')
    })
    expect(off.environment, 'nothing is built with the option off').toBe('')
    expect(on.environment.length).toBeGreaterThan(1000)
    // The primary march is a Loop, so a fragment without one is not the march
    expect(on.environment).toMatch(/for\s*\(/)
  })
})

describe('cloud environment ray state', () => {
  // getRayNearFar's altitude branches are the ray state's first use, so under
  // three r186 a ray state that is not a var is declared in one branch only
  it('is assigned in a block that encloses every read', () => {
    const wgsl = compile(true).environmentRaw
    const names = varsAssigned(
      wgsl,
      /^(RaySpheresIntersections4\(|length\(|\( dot\()/
    )
    const rows = names.map(name => ({
      name,
      outside: readsOutsideAssigningBlock(wgsl, name).length
    }))
    log('environment-ray-state-scope', { rows: JSON.stringify(rows) })
    expect(names.length, 'the ray state is held in vars').toBeGreaterThan(0)
    expect(rows.filter(r => r.outside > 0)).toEqual([])
  })
})
