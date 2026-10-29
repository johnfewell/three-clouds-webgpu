// The recipe docs/design/cloud-types.md section 7 asks every sibling to use:
// digest the compiled density chain of a clouds context, off and on
// It lives in test/helpers rather than in the test so the OFF arm can be
// measured on a worktree at origin/main, where this file and the test that
// pins the literal are the only two files to copy

import { createHash } from 'node:crypto'
import {
  Data3DTexture,
  DataTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Vector4
} from 'three'
import {
  float,
  texture as tslTexture,
  texture3D as tslTexture3D,
  uniform,
  vec2,
  vec3
} from 'three/tsl'

import type { CloudsContext } from '../../src/CloudsContext'
import { createSampleMedia } from '../../src/density/sampleShape'
import { createSampleWeather } from '../../src/density/sampleWeather'
import {
  createLayerUniforms,
  updateLayerUniforms
} from '../../src/layerUniforms'
import { compileWGSL, normalizeWGSL } from './compileWGSL'

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function tex2D() {
  const t = new DataTexture(
    new Uint8Array([128, 128, 128, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType
  )
  t.minFilter = LinearMipMapLinearFilter
  t.magFilter = LinearFilter
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.generateMipmaps = true
  t.needsUpdate = true
  return t
}

function tex3D() {
  const t = new Data3DTexture(new Uint8Array([128]), 1, 1, 1)
  t.format = RedFormat
  t.type = UnsignedByteType
  t.minFilter = LinearFilter
  t.magFilter = LinearFilter
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.wrapR = RepeatWrapping
  t.needsUpdate = true
  return t
}

/**
 * The density chain as CloudsPassNode wires it: the layer uniforms from
 * updateLayerUniforms, the structure literals from CloudLayers.structure, the
 * context's own turbulence, detail and experimental flags, and a 1x1
 * placeholder for each texture, so the digest is over the graph and not over
 * texture data.
 *
 * `shadow` selects the arm the pass builds for the cloud shadow map, which
 * gates the shadowLayerMask multiply in createSampleWeather.
 */
export function compileDefaultChain(
  ctx: CloudsContext,
  shadow: boolean
): string {
  const u = createLayerUniforms()
  updateLayerUniforms(u, ctx)
  const structure = ctx.cloudLayers.structure
  const shape = tslTexture3D(tex3D())
  const detail = tslTexture3D(tex3D())
  ;(shape as unknown as { updateMatrix: boolean }).updateMatrix = false
  ;(detail as unknown as { updateMatrix: boolean }).updateMatrix = false
  const weather = createSampleWeather(
    tslTexture(tex2D()),
    uniform(new Vector2(100, 100)),
    uniform(new Vector2(0, 0)),
    u.minLayerHeights,
    u.maxLayerHeights,
    u.weatherExponents,
    u.shapeAlteringBiases,
    uniform(ctx.coverage),
    u.coverageFilterWidths,
    u.shadowLayerMask,
    ctx.cloudLayers.localWeatherChannels,
    shadow,
    structure
  )
  const media = createSampleMedia(
    shape,
    uniform(new Vector3(0.0003, 0.0003, 0.0003)),
    uniform(new Vector3(0, 0, 0)),
    u.shapeAmounts,
    detail,
    uniform(new Vector3(0.001, 0.001, 0.001)),
    uniform(new Vector3(0, 0, 0)),
    u.shapeDetailAmounts,
    tslTexture(tex2D()),
    uniform(new Vector2(20, 20)),
    uniform(350),
    uniform(new Vector2(100, 100)),
    uniform(new Vector2(0, 0)),
    u.densityScales,
    u.densityProfileExpTerms,
    u.densityProfileExponents,
    u.densityProfileLinearTerms,
    u.densityProfileConstantTerms,
    // The pass's own flags, read from the context rather than restated: on a
    // default context 'high' quality means turbulence and detail are on and
    // every experimental option is off
    ctx.turbulence,
    ctx.shapeDetail,
    ctx.experimental.distantShapeDetailFade,
    structure
  )
  const height = float(1800)
  const density = weather(vec2(0.5, 0.5), height, float(0))
  const out = media(
    density,
    density,
    vec3(6361800, 0, 0),
    vec2(0.5, 0.5),
    float(0),
    float(0.3)
  )
  return normalizeWGSL(compileWGSL(out).fragment)
}

/**
 * One digest over both arms of one context. Compiling twice costs little and
 * catches a change that only reaches the shadow branch, which the primary arm
 * alone would report as unchanged.
 */
export function defaultChainDigest(ctx: CloudsContext): string {
  return sha256(
    `${compileDefaultChain(ctx, false)}\n${compileDefaultChain(ctx, true)}`
  )
}

export function defaultChainBytes(ctx: CloudsContext): number {
  return (
    compileDefaultChain(ctx, false).length +
    compileDefaultChain(ctx, true).length
  )
}

/**
 * Every number the shader reads for a layer set, as one canonical string. A
 * preset that leaked into the default would move this even if the compiled
 * graph did not, so it is the second half of the off proof.
 */
export function packLayerUniformState(ctx: CloudsContext): string {
  const u = createLayerUniforms()
  updateLayerUniforms(u, ctx)
  const scalars: Record<string, number> = { coverage: ctx.coverage }
  const vectors: Record<string, number[]> = {}
  for (const [key, node] of Object.entries(u)) {
    const value = (node as { value: number | Vector2 | Vector3 | Vector4 })
      .value
    if (typeof value === 'number') scalars[key] = value
    else vectors[key] = value.toArray()
  }
  const structure = ctx.cloudLayers.structure
  return JSON.stringify({
    scalars,
    vectors,
    channels: ctx.cloudLayers.localWeatherChannels,
    castsShadow: ctx.cloudLayers.castsShadow,
    structureKey: [
      structure.active.join(''),
      structure.weatherExponentOne ? 'w' : '-',
      structure.expTermZero ? 'e' : '-'
    ].join('')
  })
}

export function layerUniformStateDigest(ctx: CloudsContext): string {
  return sha256(packLayerUniformState(ctx))
}
