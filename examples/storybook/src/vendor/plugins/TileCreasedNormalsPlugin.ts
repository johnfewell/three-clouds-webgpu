// Vendored from three-geospatial storybook-webgpu/src/plugins/TileCreasedNormalsPlugin.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Verbatim.

import type { Tile, TilesRenderer } from '3d-tiles-renderer'
import {
  BufferGeometry,
  Mesh,
  type BufferAttribute,
  type Object3D
} from 'three'

import { queueTask } from '../worker/pool'
import {
  fromBufferAttributeLike,
  toBufferAttributeLike
} from '../worker/tasks/computeCreasedNormalAttribute'

async function computeCreasedNormalAttributeAsync(
  geometry: BufferGeometry,
  creaseAngle?: number
): Promise<BufferAttribute> {
  const position = toBufferAttributeLike(geometry.getAttribute('position'))
  const result = await queueTask(
    'computeCreasedNormalAttribute',
    [position[0], creaseAngle],
    { transfer: position[1] }
  )
  return fromBufferAttributeLike(result)
}

export interface TileCreasedNormalsPluginOptions {
  creaseAngle?: number
}

export class TileCreasedNormalsPlugin {
  tiles?: TilesRenderer
  readonly options: TileCreasedNormalsPluginOptions
  priority = -1000

  constructor(options?: TileCreasedNormalsPluginOptions) {
    this.options = { ...options }
  }

  // Plugin method
  init(tiles: TilesRenderer): void {
    this.tiles = tiles

    tiles.forEachLoadedModel((scene, tile) => {
      this.processTileModel(scene, tile)
    })
  }

  // Plugin method
  processTileModel(scene: Object3D, tile: Tile): void {
    const meshes: Mesh[] = []
    scene.traverse(object => {
      if (object instanceof Mesh && object.geometry instanceof BufferGeometry) {
        // Synchronously convert to non-indexed geometries:
        const { geometry } = object
        if (geometry.index != null) {
          object.geometry = geometry.toNonIndexed()
          geometry.dispose()
        }
        meshes.push(object)
      }
    })
    for (const mesh of meshes) {
      computeCreasedNormalAttributeAsync(
        mesh.geometry,
        this.options.creaseAngle
      )
        .then(normal => {
          mesh.geometry.setAttribute('normal', normal)
        })
        .catch((error: unknown) => {
          console.error(error)
        })
    }
  }
}
