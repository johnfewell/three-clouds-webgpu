// Digest helper for the byte-identical-off proof in docs/design/cloud-types.md
// §7. Test infra rather than library code, so it lives beside compileWGSL

import { createHash } from 'node:crypto'
import {
  Data3DTexture,
  NearestFilter,
  RGBAFormat,
  Texture,
  UnsignedByteType
} from 'three'
import { texture, context as tslContext } from 'three/tsl'
import {
  PerspectiveCamera,
  WebGPUBackend,
  type Node,
  type NodeMaterial
} from 'three/webgpu'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

import { clouds, type CloudsPassNode } from '../../src/CloudsPassNode'
import { compileWGSL, normalizeWGSL } from './compileWGSL'

interface PassInternals {
  material: NodeMaterial
  shadowMaterial: NodeMaterial
  layerRT: unknown
  shadowRT: unknown
}

export interface MarchDigests {
  march: string
  shadow: string
}

// The march reads the atmosphere through the builder context, and both of its
// fragments are mrt() nodes whose attachment indices resolve against the bound
// target's texture names. Same setup as CloudsPassNode.test.ts's compiles
function builderContext() {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  return tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({})
  })
}

function compileFragment(fragment: Node | null, renderTarget: unknown): string {
  if (fragment == null) throw new Error('a march material has no fragment')
  return compileWGSL(fragment, {
    renderTarget,
    contextNode: builderContext()
  }).fragment
}

// normalizeWGSL first: it pins the nodeVar3-style counters, so an unrelated
// node added upstream cannot move this digest
function digestWGSL(wgsl: string): string {
  return createHash('sha256').update(normalizeWGSL(wgsl)).digest('hex')
}

// Compiling the composite runs the pass's build(), which mints the two march
// materials. Both are digested because the feature reaches the primary march
// and the shadow march through two samplers
function compilePass(pass: CloudsPassNode): MarchDigests {
  compileWGSL(pass.composite(texture(new Texture())), {
    contextNode: builderContext()
  })
  const anyPass = pass as unknown as PassInternals
  return {
    march: digestWGSL(
      compileFragment(anyPass.material.fragmentNode, anyPass.layerRT)
    ),
    shadow: digestWGSL(
      compileFragment(anyPass.shadowMaterial.fragmentNode, anyPass.shadowRT)
    )
  }
}

function makePass(): CloudsPassNode {
  const pass = clouds({ sceneDepth: null })
  // A local jitter volume, so a compile never reaches for STBNLoader and the
  // network. Same shape and filters as parameterUniforms' placeholder
  const stbn = new Data3DTexture(new Uint8Array(4), 1, 1, 1)
  stbn.format = RGBAFormat
  stbn.type = UnsignedByteType
  stbn.minFilter = NearestFilter
  stbn.magFilter = NearestFilter
  pass.cloudsContext.stbnTexture = stbn
  return pass
}

// The atmosphere LUT asks the BACKEND whether float-linear sampling is
// supported, and the compile stub's backend has no device
function withBackendPatched<T>(run: () => T): T {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  const hasFeature = backend.hasFeature
  backend.hasFeature = () => false
  try {
    return run()
  } finally {
    backend.hasFeature = hasFeature
  }
}

// Both halves of docs/design/cloud-types.md §7 off one context: the feature is
// a boolean in `experimental`, so flipping it bumps graphVersion and the next
// composite compile rebuilds the graph
export function offAndOnDigests(): {
  off: MarchDigests
  on: MarchDigests
} {
  return withBackendPatched(() => {
    const pass = makePass()
    const off = compilePass(pass)
    pass.cloudsContext.experimental = { evolvingWeather: true }
    const on = compilePass(pass)
    pass.cloudsContext.experimental = { evolvingWeather: false }
    return { off, on }
  })
}

// The shadow march's normalised WGSL for a layer set edited on a fresh pass, so
// a layer flag reaches the graph without a frame poll
export function shadowWGSLForLayers(
  edit: (layers: CloudsPassNode['cloudsContext']['cloudLayers']) => void
): string {
  return withBackendPatched(() => {
    const pass = makePass()
    edit(pass.cloudsContext.cloudLayers)
    compileWGSL(pass.composite(texture(new Texture())), {
      contextNode: builderContext()
    })
    const anyPass = pass as unknown as PassInternals
    return normalizeWGSL(
      compileFragment(anyPass.shadowMaterial.fragmentNode, anyPass.shadowRT)
    )
  })
}
