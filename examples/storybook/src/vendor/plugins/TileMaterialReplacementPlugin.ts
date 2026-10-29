// Vendored from three-geospatial storybook-webgpu/src/plugins/TileMaterialReplacementPlugin.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Verbatim.

import type { Tile, TilesRenderer } from '3d-tiles-renderer'
import { Mesh, type Material, type Object3D, type Texture } from 'three'
import { MeshLambertNodeMaterial } from 'three/webgpu'

import { reinterpretType } from '@takram/three-geospatial'

function replaceMaterials(mesh: Mesh, materialHandler: () => Material): void {
  const prevMaterial = mesh.material
  if (Array.isArray(prevMaterial)) {
    throw new Error('Multiple materials are not supported yet.')
  }

  const nextMaterial = materialHandler()
  if (
    'map' in prevMaterial &&
    prevMaterial.map != null &&
    'map' in nextMaterial
  ) {
    reinterpretType<Texture | null>(prevMaterial.map)
    reinterpretType<Texture | null>(nextMaterial.map)
    nextMaterial.map = prevMaterial.map
  }

  mesh.material = nextMaterial
  prevMaterial.dispose()
}

const defaultMaterial = (): Material => new MeshLambertNodeMaterial()

export class TileMaterialReplacementPlugin {
  tiles?: TilesRenderer
  priority = -1000

  private readonly materialHandler: () => Material

  constructor(materialHandler: () => Material = defaultMaterial) {
    this.materialHandler = materialHandler
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
    scene.traverse(object => {
      if (object instanceof Mesh) {
        replaceMaterials(object, this.materialHandler)
      }
    })
  }
}
