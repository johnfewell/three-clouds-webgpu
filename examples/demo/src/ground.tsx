import { useThree } from '@react-three/fiber'
import type {
  Tile,
  TilesRenderer as TilesRendererImpl
} from '3d-tiles-renderer'
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/core/plugins'
import { TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f'
import {
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/three/plugins'
import { useEffect, useLayoutEffect, useMemo, type FC } from 'react'
import {
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type Material,
  type Object3D,
  type Texture
} from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { float } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'

import {
  Ellipsoid,
  Geodetic,
  PointOfView,
  radians,
  reinterpretType
} from '@takram/three-geospatial'

import { hasIonToken, ionToken, type GroundState } from './resolveGround'

export {
  GROUND_LOCATIONS,
  groundLabel,
  hasIonToken,
  hasOcean,
  ionToken,
  resolveGround
} from './resolveGround'
export type {
  GroundLocationKey,
  GroundValue,
  GroundState,
  PointOfViewProps
} from './resolveGround'

export const WATER_BODIES = {
  look: { title: 'Water: clear ocean (Groundswell look)', preset: null },
  coastalClear: { title: 'Water: coastal clear', preset: 'coastal-clear' },
  coastalTurbid: { title: 'Water: coastal turbid', preset: 'coastal-turbid' }
} as const

export type WaterBody = keyof typeof WATER_BODIES

// The ocean surface writes 0 to the lit MRT channel so it keeps its own
// shading while everything else writes 1 for the aerial post-lighting pass
export function groundMRT(ocean: boolean): Record<string, Node> {
  return ocean ? { lit: float(1) } : {}
}

const frameScratch = new Matrix4()
const inverseScratch = new Matrix4()
const rotationScratch = new Quaternion()
const ecefScratch = new Vector3()

export function useGroundCamera(
  ground: GroundState,
  matrixWorldToECEF: Matrix4
): Vector3 {
  const camera = useThree(({ camera }) => camera)
  const controls = useThree(
    state => state.controls as { target?: Vector3; update?: () => void } | null
  )
  const {
    longitude,
    latitude,
    height = 0,
    heading,
    pitch,
    distance
  } = ground.pov
  const { ocean } = ground

  const [frame, target] = useMemo(() => {
    const f = new Matrix4()
    if (ocean) {
      Ellipsoid.WGS84.getNorthUpEastFrame(
        new Geodetic(radians(longitude), radians(latitude), 0).toECEF(
          ecefScratch
        ),
        f
      )
    }
    const t = new Geodetic(
      radians(longitude),
      radians(latitude),
      height
    ).toECEF()
    return [f, t.applyMatrix4(inverseScratch.copy(f).invert())]
  }, [ocean, longitude, latitude, height])

  useLayoutEffect(() => {
    matrixWorldToECEF.copy(frame)
    const targetECEF = ecefScratch.copy(target).applyMatrix4(frame)
    new PointOfView(distance, radians(heading), radians(pitch)).decompose(
      targetECEF,
      camera.position,
      camera.quaternion,
      camera.up
    )
    inverseScratch.copy(frame).invert()
    rotationScratch.setFromRotationMatrix(inverseScratch)
    camera.position.applyMatrix4(inverseScratch)
    camera.quaternion.premultiply(rotationScratch)
    camera.up.applyQuaternion(rotationScratch)
    camera.updateMatrixWorld()
    if (controls?.target != null) {
      controls.target.copy(target)
      controls.update?.()
    }
  }, [
    frame,
    target,
    matrixWorldToECEF,
    camera,
    controls,
    heading,
    pitch,
    distance
  ])

  useEffect(
    () => () => {
      matrixWorldToECEF.copy(frameScratch.identity())
    },
    [matrixWorldToECEF]
  )

  return target
}

function replaceMaterials(mesh: Mesh, materialHandler: () => Material): void {
  const prevMaterial = mesh.material
  if (Array.isArray(prevMaterial)) return
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

const defaultTileMaterial = (): Material => new MeshBasicNodeMaterial()

class TileMaterialReplacementPlugin {
  tiles?: TilesRendererImpl
  priority = -1000
  private readonly materialHandler: () => Material

  constructor(materialHandler: () => Material = defaultTileMaterial) {
    this.materialHandler = materialHandler
  }

  init(tiles: TilesRendererImpl): void {
    this.tiles = tiles
    tiles.forEachLoadedModel((scene, tile) => {
      this.processTileModel(scene, tile)
    })
  }

  processTileModel(scene: Object3D, _tile: Tile): void {
    scene.traverse(object => {
      if (object instanceof Mesh) {
        replaceMaterials(object, this.materialHandler)
      }
    })
  }
}

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')

export const GroundTiles: FC<{ ground: GroundState }> = ({ ground }) => {
  if (!ground.tiles || !hasIonToken) return null
  return (
    <TilesRenderer key={ionToken} errorTarget={12}>
      <TilesPlugin
        plugin={CesiumIonAuthPlugin}
        args={[
          {
            apiToken: ionToken,
            assetId: '2275207',
            autoRefreshToken: true
          }
        ]}
      />
      <TilesPlugin plugin={GLTFExtensionsPlugin} dracoLoader={dracoLoader} />
      <TilesPlugin plugin={TileCompressionPlugin} />
      <TilesPlugin plugin={UpdateOnChangePlugin} />
      <TilesPlugin plugin={TileMaterialReplacementPlugin} />
    </TilesRenderer>
  )
}
