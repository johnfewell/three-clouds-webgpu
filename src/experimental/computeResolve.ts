// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: cloudsResolve.frag:49-152, varianceClipping.glsl:42-105

import type { Texture } from 'three'
import {
  clamp,
  float,
  Fn,
  If,
  int,
  ivec2,
  localId,
  max,
  mix,
  sqrt,
  texture,
  textureLoad,
  textureSize,
  textureStore,
  uint,
  vec2,
  vec4,
  workgroupArray,
  workgroupBarrier,
  workgroupId
} from 'three/tsl'
import type { Node, StorageTexture, TextureNode } from 'three/webgpu'

import { bayerIndices, referenceBayerRow } from '../resolve/bayer'
import type {
  CloudsResolveDeps,
  CloudsResolveShadowLengthDeps
} from '../resolve/cloudsResolve'
import { clipAABB, OFFSETS_9 } from '../resolve/varianceClipping'

// Include the bilinear footprint and odd-resolution upscale drift in the
// halo. Every lane participates in loading and the barrier, even out of bounds.
export function createResolveTile(
  input: Texture | TextureNode,
  size: Node<'vec2'>,
  stride: number,
  halo: number,
  layer?: Node<'float'>
) {
  const width = stride + halo * 2
  const count = width * width
  const shared = workgroupArray('vec4', count) as unknown as {
    element(index: Node<'int'>): Node<'vec4'>
  }
  // The fill builds its own tile origin per branch: three r186 declares a node
  // shared with the loads inside the fill's If, and lanes that skip it read 0
  const base = () => ivec2(workgroupId.xy).mul(int(stride)).sub(int(halo))
  const loadBase = base()
  const fill = Fn(() => {
    const lane = localId.y.mul(uint(8)).add(localId.x).toInt()
    for (let block = 0; block < Math.ceil(count / 64); block++) {
      const index = lane.add(block * 64)
      If(index.lessThan(count), () => {
        const coord = base().add(ivec2(index.mod(width), index.div(int(width))))
        const texel =
          layer == null
            ? textureLoad(input, coord, int(0))
            : textureLoad(input, coord, int(0)).depth(layer)
        shared.element(index).assign(texel)
      })
    }
  }, 'void')
  const load = Fn(([coord]: [Node<'ivec2'>]) => {
    const local = coord.sub(loadBase)
    return shared.element(local.y.mul(width).add(local.x))
  })
  const sample = Fn(([uv]: [Node<'vec2'>]) => {
    const p = uv.mul(size).sub(0.5)
    const origin = p.floor()
    const weight = p.sub(origin)
    const lo = ivec2(clamp(origin, vec2(0), size.sub(1)))
    const hi = ivec2(clamp(origin.add(1), vec2(0), size.sub(1)))
    return mix(
      mix(load(lo), load(ivec2(hi.x, lo.y)), weight.x),
      mix(load(ivec2(lo.x, hi.y)), load(hi), weight.x),
      weight.y
    )
  })
  return { fill, load, sample }
}

type ResolveTile = ReturnType<typeof createResolveTile>

export function createTileClip(
  tile: ResolveTile,
  size: Node<'vec2'>,
  upscale: boolean,
  opaque = false
) {
  return Fn(
    ([coord, uv, current, history, gamma]: [
      Node<'ivec2'>,
      Node<'vec2'>,
      Node<'vec4'>,
      Node<'vec4'>,
      Node<'float'>
    ]) => {
      const moment1 = current.toVar()
      const moment2 = current.mul(current).toVar()
      for (const [dx, dy] of OFFSETS_9) {
        const value = upscale
          ? tile.sample(uv.add(vec2(dx, dy).div(size)))
          : tile.load(coord.add(ivec2(dx, dy)))
        const neighbor = opaque ? vec4(value.rgb, 1) : value
        moment1.addAssign(neighbor)
        moment2.addAssign(neighbor.mul(neighbor))
      }
      const mean = moment1.div(9)
      const deviation = sqrt(
        max(moment2.div(9).sub(mean.mul(mean)), float(0))
      ).mul(gamma)
      return clipAABB(mean, history, mean.sub(deviation), mean.add(deviation))
    }
  )
}

export function createTileClosest(tile: ResolveTile) {
  return Fn(([coord]: [Node<'ivec2'>]) => {
    const result = vec4(1e5, 0, 0, 0).toVar()
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const value = tile.load(coord.add(ivec2(dx, dy)))
        If(value.r.lessThan(result.r), () => {
          result.assign(value)
        })
      }
    }
    return result
  })
}

function currentBayerCell(
  coord: Node<'ivec2'>,
  frame: Node<'float'>,
  height: Node<'float'>
) {
  return Fn(() => {
    const index = referenceBayerRow(coord.y, height).mul(4).add(coord.x.mod(4))
    const cell = int(0).toVar()
    for (let i = 1; i < 16; i++) {
      If(index.equal(i), () => {
        cell.assign(int(bayerIndices[i]))
      })
    }
    return cell.equal(frame.toInt().mod(16))
  })()
}

export function buildComputeCloudsResolve(
  deps: CloudsResolveDeps,
  shadow: CloudsResolveShadowLengthDeps | null,
  upscale: boolean,
  output: StorageTexture,
  shadowOutput?: StorageTexture
) {
  const size = vec2(textureSize(texture(deps.colorBuffer)) as never)
  const stride = upscale ? 2 : 8
  const halo = upscale ? 3 : 1
  const colorTile = createResolveTile(deps.colorBuffer, size, stride, halo)
  const depthTile = createResolveTile(
    deps.depthVelocityBuffer,
    size,
    stride,
    halo
  )
  const shadowTile =
    shadow == null
      ? null
      : createResolveTile(shadow.shadowLengthBuffer, size, stride, halo)
  const closest = createTileClosest(depthTile)
  const clipColor = createTileClip(colorTile, size, upscale)
  const clipShadow =
    shadowTile == null ? null : createTileClip(shadowTile, size, upscale, true)

  return Fn(() => {
    colorTile.fill().toStack()
    depthTile.fill().toStack()
    shadowTile?.fill().toStack()
    workgroupBarrier()
    const coord = ivec2(workgroupId.xy.mul(uint(8)).add(localId.xy))
    const fullSize = vec2(deps.resolveWidth, deps.resolveHeight)
    // No early return before the barrier: partial edge workgroups must also
    // finish filling the tile, or the kernel can deadlock
    If(
      coord.x
        .lessThan(deps.resolveWidth.toInt())
        .and(coord.y.lessThan(deps.resolveHeight.toInt())),
      () => {
        const uv = vec2(coord).add(0.5).div(fullSize)
        const bufferCoord = upscale ? coord.div(int(4)) : coord
        const current = colorTile.load(bufferCoord)
        const color = current.toVar()
        const currentShadow =
          shadowTile == null
            ? vec4(0)
            : vec4(shadowTile.load(bufferCoord).rgb, 1)
        const shaft = currentShadow.toVar()
        const accumulate = createComputeAccumulation(
          deps,
          shadow,
          upscale,
          closest,
          clipColor,
          clipShadow,
          { uv, bufferCoord, current, color, currentShadow, shaft }
        )
        if (upscale)
          If(
            currentBayerCell(coord, deps.frame, deps.resolveHeight).not(),
            () => {
              accumulate().toStack()
            }
          )
        else accumulate().toStack()
        if (deps.shadowHistoryValid != null) {
          If(deps.shadowHistoryValid.not(), () => {
            shaft.assign(currentShadow)
          })
        }
        textureStore(output, coord, color).toWriteOnly()
        if (shadowOutput != null)
          textureStore(shadowOutput, coord, shaft).toWriteOnly()
      }
    )
  })().computeKernel([8, 8, 1])
}

function createComputeAccumulation(
  deps: CloudsResolveDeps,
  shadow: CloudsResolveShadowLengthDeps | null,
  upscale: boolean,
  closest: ReturnType<typeof createTileClosest>,
  clipColor: ReturnType<typeof createTileClip>,
  clipShadow: ReturnType<typeof createTileClip> | null,
  state: {
    uv: Node<'vec2'>
    bufferCoord: Node<'ivec2'>
    current: Node<'vec4'>
    color: Node<'vec4'>
    currentShadow: Node<'vec4'>
    shaft: Node<'vec4'>
  }
) {
  const { uv, bufferCoord, current, color, currentShadow, shaft } = state
  return Fn(() => {
    const prevUv = uv.sub(closest(bufferCoord).gb)
    let valid = prevUv.x
      .greaterThanEqual(0)
      .and(prevUv.x.lessThanEqual(1))
      .and(prevUv.y.greaterThanEqual(0))
      .and(prevUv.y.lessThanEqual(1))
    if (deps.cloudHistoryValid != null)
      valid = valid.and(deps.cloudHistoryValid)
    If(valid, () => {
      const history = deps.colorHistoryNode.sample(prevUv).level(float(0))
      const gamma = upscale ? deps.varianceGamma : float(1)
      const clipped = clipColor(bufferCoord, uv, current, history, gamma)
      color.assign(
        upscale ? clipped : mix(clipped, current, deps.temporalAlpha)
      )
      if (shadow != null && clipShadow != null) {
        const historyShaft = vec4(
          shadow.shadowLengthHistoryNode.sample(prevUv).level(float(0)).rgb,
          1
        )
        const clippedShaft = clipShadow(
          bufferCoord,
          uv,
          currentShadow,
          historyShaft,
          gamma
        )
        shaft.assign(
          upscale
            ? clippedShaft
            : mix(clippedShaft, currentShadow, deps.temporalAlpha)
        )
      }
    })
  }, 'void')
}
