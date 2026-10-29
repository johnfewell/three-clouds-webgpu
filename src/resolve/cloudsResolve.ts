// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: cloudsResolve.frag (177 lines)

import type { Texture } from 'three'
import {
  float,
  Fn,
  If,
  int,
  ivec2,
  mix,
  struct,
  textureLoad,
  uv,
  vec4
} from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

import { bayerIndex2D, referenceBayerRow } from './bayer'
import { varianceClipping, varianceClippingUv } from './varianceClipping'

const NEIGHBOR_OFFSETS_9 = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 0],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
] as const

// Cite: cloudsResolve.frag:49–61
// The weight a full-resolution resolve gives the current frame
// Cite: CloudsResolveMaterial.ts:78
export const CLOUDS_TEMPORAL_ALPHA = 0.1

function createGetClosestFragment(depthVelocityBuffer: Texture) {
  return /*#__PURE__*/ Fn(([coord]: [Node<'ivec2'>]) => {
    const result = vec4(1e5, 0, 0, 0).toVar()
    for (const [dx, dy] of NEIGHBOR_OFFSETS_9) {
      const neighbor = textureLoad(
        depthVelocityBuffer,
        ivec2(coord.x.add(dx), coord.y.add(dy)),
        int(0)
      )
      If(neighbor.r.lessThan(result.r), () => {
        result.assign(neighbor)
      })
    }
    return result
  })
}

export function getClosestFragmentCPU(
  buffer: { r: number; g: number; b: number; a: number }[],
  width: number,
  cx: number,
  cy: number
): { r: number; g: number; b: number; a: number } {
  let best = { r: 1e5, g: 0, b: 0, a: 0 }
  for (const [dx, dy] of NEIGHBOR_OFFSETS_9) {
    const nx = cx + dx
    const ny = cy + dy
    if (nx >= 0 && nx < width && ny >= 0) {
      const idx = ny * width + nx
      const n = buffer[idx]
      if (n != null && n.r < best.r) {
        best = n
      }
    }
  }
  return best
}

export function isCurrentFrameCPU(
  pixelX: number,
  pixelY: number,
  frame: number
): boolean {
  return bayerIndex2D(pixelX % 4, pixelY % 4) === frame % 16
}

// Precomputed Bayer lookup table [y*4+x] → bayerIndex2D(x, y)
const BAYER_TABLE: readonly number[] = (() => {
  const table: number[] = []
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      table.push(bayerIndex2D(x, y))
    }
  }
  return table
})()

export interface CloudsResolveDeps {
  cloudHistoryValid?: Node<'bool'>
  shadowHistoryValid?: Node<'bool'>
  colorBuffer: Texture
  depthVelocityBuffer: Texture
  // A live handle, not a Texture: .value is updated each frame for the
  // ping-pong, so the swap is what the shader samples
  colorHistoryNode: TextureNode
  resolveWidth: Node<'float'>
  resolveHeight: Node<'float'>
  frame: Node<'float'>
  varianceGamma: Node<'float'>
  temporalAlpha: Node<'float'>
}

// Cite: cloudsResolve.frag:63–118
export function buildTemporalUpscale(deps: CloudsResolveDeps) {
  const getClosestFragment = createGetClosestFragment(deps.depthVelocityBuffer)
  const varClip = varianceClippingUv(deps.colorBuffer)

  return Fn(() => {
    const fullResUv = uv()
    // Full-res pixel coords (equivalent to ivec2(gl_FragCoord.xy))
    const coordX = fullResUv.x.mul(deps.resolveWidth).toInt()
    const coordY = fullResUv.y.mul(deps.resolveHeight).toInt()

    // Low-res coords (integer division by 4)
    const lowResCoord = ivec2(coordX.div(int(4)), coordY.div(int(4)))

    // WebGL's gl_FragCoord is bottom-up and this uv is top-down, so select the
    // same physical Bayer row. Cite: cloudsResolve.frag:163
    // (bayerIndices[coord.x % 4][coord.y % 4])
    const cellX = coordX.sub(coordX.div(int(4)).mul(int(4)))
    const cellY = referenceBayerRow(coordY, deps.resolveHeight)
    const flatIdx = cellY.mul(int(4)).add(cellX)

    const bayerValue = int(BAYER_TABLE[0]).toVar()
    for (let i = 1; i < 16; i++) {
      If(flatIdx.equal(int(i)), () => {
        bayerValue.assign(int(BAYER_TABLE[i]))
      })
    }

    const frameInt = deps.frame.toInt()
    const frame16 = frameInt.sub(frameInt.div(int(16)).mul(int(16)))
    const isCurrentFrame = bayerValue.equal(frame16)

    const currentColor = textureLoad(deps.colorBuffer, lowResCoord, int(0))
    const result = currentColor.toVar()

    If(isCurrentFrame, () => {
      // Cite: cloudsResolve.frag:75–82 (output texel just rendered)
    }).Else(() => {
      const depthVelocity = getClosestFragment(lowResCoord)
      const velocity = depthVelocity.gb
      const prevUv = fullResUv.sub(velocity).toVar()

      const inBounds = prevUv.x
        .greaterThanEqual(float(0))
        .and(prevUv.x.lessThanEqual(float(1)))
        .and(prevUv.y.greaterThanEqual(float(0)))
        .and(prevUv.y.lessThanEqual(float(1)))

      If(inBounds, () => {
        // Bilinear history sample (Cite: cloudsResolve.frag:99)
        const historyColor = deps.colorHistoryNode
          .sample(prevUv)
          .level(float(0))
        // Cite: cloudsResolve.frag:100 (vec2/textureOffset overload at vUv)
        const clipped = varClip(
          fullResUv,
          currentColor,
          historyColor,
          deps.varianceGamma
        )
        result.assign(clipped)
      })
    })

    return result
  })()
}

// Cite: cloudsResolve.frag:120–152
export function buildTemporalAntialiasing(deps: CloudsResolveDeps) {
  const getClosestFragment = createGetClosestFragment(deps.depthVelocityBuffer)
  const varClip = varianceClipping(deps.colorBuffer)

  return Fn(() => {
    const coordX = uv().x.mul(deps.resolveWidth).toInt()
    const coordY = uv().y.mul(deps.resolveHeight).toInt()
    const coord = ivec2(coordX, coordY)

    const currentColor = textureLoad(deps.colorBuffer, coord, int(0))
    const depthVelocity = getClosestFragment(coord)
    const velocity = depthVelocity.gb
    const prevUv = uv().sub(velocity).toVar()

    const result = currentColor.toVar()

    const inBounds = prevUv.x
      .greaterThanEqual(float(0))
      .and(prevUv.x.lessThanEqual(float(1)))
      .and(prevUv.y.greaterThanEqual(float(0)))
      .and(prevUv.y.lessThanEqual(float(1)))

    If(inBounds, () => {
      const historyColor = deps.colorHistoryNode.sample(prevUv).level(float(0))
      const clipped = varClip(coord, currentColor, historyColor, float(1))
      result.assign(mix(clipped, currentColor, deps.temporalAlpha))
    })

    return result
  })()
}

// One resolve pass for colour and shadow length. Cite: cloudsResolve.frag:63–152
// writes both from one fragment (MRT), sharing the Bayer test, the closest-
// fragment search and the reprojection, and clips each output on its own buffer

// A separate shadow-length pass cost 1.8 ms of a 13.4 ms frame at 2880×1800

export const cloudsResolveStruct = /*#__PURE__*/ struct(
  { color: 'vec4', shadowLength: 'vec4' },
  'CloudsResolveOutput'
)

export interface CloudsResolveShadowLengthDeps {
  shadowLengthBuffer: Texture
  // .value follows the history swap, like colorHistoryNode
  shadowLengthHistoryNode: TextureNode
}

export interface CloudsResolveOutputs {
  color: Node<'vec4'>
  // null when the pass has no shadow-length attachment (lightShafts off)
  shadowLength: Node<'vec4'> | null
}

export function buildCloudsResolve(
  deps: CloudsResolveDeps,
  shadowLength: CloudsResolveShadowLengthDeps | null,
  temporalUpscale: boolean
): CloudsResolveOutputs {
  const withShadowLength = shadowLength != null

  const resolve = Fn(() => {
    const fullResUv = uv()
    const coordX = fullResUv.x.mul(deps.resolveWidth).toInt()
    const coordY = fullResUv.y.mul(deps.resolveHeight).toInt()
    const coord = ivec2(coordX, coordY)
    // The buffers are marched at quarter resolution under the upscale and at
    // full resolution otherwise, and the clipping neighbourhood follows
    const bufferCoord = temporalUpscale
      ? ivec2(coordX.div(int(4)), coordY.div(int(4)))
      : coord

    const currentColor = textureLoad(deps.colorBuffer, bufferCoord, int(0))
    const color = currentColor.toVar()
    const currentShadowLength = withShadowLength
      ? vec4(
          textureLoad(shadowLength.shadowLengthBuffer, bufferCoord, int(0)).rgb,
          1
        )
      : vec4(0)
    const shadowLengthOut = currentShadowLength.toVar()

    const accumulate = createCloudsAccumulation(
      deps,
      shadowLength,
      temporalUpscale,
      {
        coord,
        bufferCoord,
        fullResUv,
        currentColor,
        color,
        currentShadowLength,
        shadowLengthOut
      }
    )

    if (temporalUpscale) {
      // WebGL's gl_FragCoord is bottom-up and this uv is top-down, so select
      // the same physical Bayer row. Cite: cloudsResolve.frag:163
      const cellX = coordX.sub(coordX.div(int(4)).mul(int(4)))
      const cellY = referenceBayerRow(coordY, deps.resolveHeight)
      const flatIdx = cellY.mul(int(4)).add(cellX)
      const bayerValue = int(BAYER_TABLE[0]).toVar()
      for (let i = 1; i < 16; i++) {
        If(flatIdx.equal(int(i)), () => {
          bayerValue.assign(int(BAYER_TABLE[i]))
        })
      }
      const frameInt = deps.frame.toInt()
      const frame16 = frameInt.sub(frameInt.div(int(16)).mul(int(16)))
      // Cite: cloudsResolve.frag:75–82. The texel just rendered is output
      // without accumulation, every other texel reprojects its history
      If(bayerValue.equal(frame16).not(), () => {
        accumulate().toStack()
      })
    } else {
      accumulate().toStack()
    }

    if (withShadowLength && deps.shadowHistoryValid != null) {
      // Cloud advection is not the motion of a sun shaft. Use its fresh
      // estimate whenever the colour buffer carries a wind-corrected vector
      If(deps.shadowHistoryValid.not(), () => {
        shadowLengthOut.assign(currentShadowLength)
      })
    }
    return cloudsResolveStruct(color, shadowLengthOut)
  })

  const out = resolve()
  return {
    color: out.get('color') as Node<'vec4'>,
    shadowLength: withShadowLength
      ? (out.get('shadowLength') as Node<'vec4'>)
      : null
  }
}

function createCloudsAccumulation(
  deps: CloudsResolveDeps,
  shadowLength: CloudsResolveShadowLengthDeps | null,
  temporalUpscale: boolean,
  state: {
    coord: Node<'ivec2'>
    bufferCoord: Node<'ivec2'>
    fullResUv: Node<'vec2'>
    currentColor: Node<'vec4'>
    color: Node<'vec4'>
    currentShadowLength: Node<'vec4'>
    shadowLengthOut: Node<'vec4'>
  }
) {
  const {
    coord,
    bufferCoord,
    fullResUv,
    currentColor,
    color,
    currentShadowLength,
    shadowLengthOut
  } = state
  const getClosestFragment = createGetClosestFragment(deps.depthVelocityBuffer)
  const withShadowLength = shadowLength != null
  return Fn(() => {
    const depthVelocity = getClosestFragment(bufferCoord)
    const velocity = depthVelocity.gb
    const prevUv = fullResUv.sub(velocity).toVar()
    const inBounds = prevUv.x
      .greaterThanEqual(float(0))
      .and(prevUv.x.lessThanEqual(float(1)))
      .and(prevUv.y.greaterThanEqual(float(0)))
      .and(prevUv.y.lessThanEqual(float(1)))
    const valid =
      deps.cloudHistoryValid != null
        ? inBounds.and(deps.cloudHistoryValid)
        : inBounds
    If(valid, () => {
      // Bilinear history samples (Cite: cloudsResolve.frag:99, 107). In this
      // non-uniform branch an explicit LOD keeps filtering without undefined
      // derivatives. These targets have no mip chain
      const historyColor = deps.colorHistoryNode.sample(prevUv).level(float(0))
      if (temporalUpscale) {
        // Cite: cloudsResolve.frag:100 (vec2/textureOffset overload at vUv)
        const varClip = varianceClippingUv(deps.colorBuffer)
        color.assign(
          varClip(fullResUv, currentColor, historyColor, deps.varianceGamma)
        )
      } else {
        const varClip = varianceClipping(deps.colorBuffer)
        const clipped = varClip(coord, currentColor, historyColor, float(1))
        color.assign(mix(clipped, currentColor, deps.temporalAlpha))
      }
      if (withShadowLength) {
        const historyShadowLength = vec4(
          shadowLength.shadowLengthHistoryNode.sample(prevUv).level(float(0))
            .rgb,
          1
        )
        if (temporalUpscale) {
          const varClipSL = varianceClippingUv(shadowLength.shadowLengthBuffer)
          shadowLengthOut.assign(
            varClipSL(
              fullResUv,
              currentShadowLength,
              historyShadowLength,
              deps.varianceGamma
            )
          )
        } else {
          const varClipSL = varianceClipping(shadowLength.shadowLengthBuffer)
          const clipped = varClipSL(
            coord,
            currentShadowLength,
            historyShadowLength,
            float(1)
          )
          shadowLengthOut.assign(
            mix(clipped, currentShadowLength, deps.temporalAlpha)
          )
        }
      }
    })
  }, 'void')
}
