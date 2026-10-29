import type { Tile, TilesRenderer } from '3d-tiles-renderer'
import { Mesh, type Material, type Object3D } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

function replaceMaterials(mesh: Mesh, materialHandler: () => Material): void {
  const prevMaterial = mesh.material
  if (Array.isArray(prevMaterial)) return

  const nextMaterial = materialHandler()
  if (
    'map' in prevMaterial &&
    prevMaterial.map != null &&
    'map' in nextMaterial
  ) {
    ;(nextMaterial as { map?: unknown }).map = prevMaterial.map
  }
  mesh.material = nextMaterial
  prevMaterial.dispose()
}

// Replaces tile materials with unlit node materials for post-lit aerial shading
export class TileMaterialReplacementPlugin {
  priority = -1000

  constructor(
    private readonly materialHandler: () => Material = () =>
      new MeshBasicNodeMaterial()
  ) {}

  init(tiles: TilesRenderer): void {
    tiles.forEachLoadedModel((scene, tile) => {
      this.processTileModel(scene, tile)
    })
  }

  processTileModel(scene: Object3D, _tile?: Tile): void {
    scene.traverse(object => {
      if (object instanceof Mesh) {
        replaceMaterials(object, this.materialHandler)
      }
    })
  }
}
