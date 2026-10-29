// Google Photorealistic 3D Tiles through Cesium Ion (asset 2275207), ported
// from three-geospatial storybook/src/helpers/Globe.tsx @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda), Ion branch only: that is the
// credential available. The token is VITE_ION_TOKEN from
// examples/r3f/.env.local, which is gitignored

import { useFrame } from '@react-three/fiber'
import type { TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer'
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/core/plugins'
import {
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/plugins'
import {
  GlobeControls,
  TilesAttributionOverlay,
  TilesPlugin,
  TilesRenderer
} from '3d-tiles-renderer/r3f'
import { useEffect, useState, type FC, type ReactNode } from 'react'
import { Mesh, type Material } from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

import { smokeProbe, type R3FTilesProbe } from './smokeProbe'

// Google Photorealistic Tiles, as an Ion asset
const ION_ASSET_ID = '2275207'

// GOOGLE'S TILES ARE DRACO-COMPRESSED. Without GLTFExtensionsPlugin and a
// Draco decoder only the coarse ancestors decode, which reads as "the tiles
// are low resolution" rather than as a decode failure
const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')

export const ionToken: string | undefined = import.meta.env.VITE_ION_TOKEN

const PROBE_EVERY = 30

// Smoke knob, read only under ?e2e=1: an error-target arm for the smoke,
// which also turns the auth plugin's recommended settings off so it applies
const smokeErrorTarget = Number(
  smokeProbe != null
    ? (new URLSearchParams(location.search).get('tilesErrorTarget') ?? NaN)
    : NaN
)

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

// What the loaded tile meshes carry: Google's tiles arrive unlit (basic
// materials) and without normals, which is what the post-lit composite sees
function sampleTiles(
  tiles: TilesRendererImpl,
  frame: number,
  loadEnds: number,
  loadErrors: number
): R3FTilesProbe {
  // stats is on the instance but not in 0.4.28's declarations
  const { stats } = tiles as unknown as { stats: Record<string, number> }
  let meshes = 0
  let withNormals = 0
  let basicMaterials = 0
  let otherMaterials = 0
  let transparentMaterials = 0
  tiles.group.traverse(object => {
    if (!(object instanceof Mesh)) return
    meshes++
    if (object.geometry.getAttribute('normal') != null) withNormals++
    for (const material of materialsOf(object)) {
      if (material.type.startsWith('MeshBasic')) basicMaterials++
      else otherMaterials++
      if (material.transparent) transparentMaterials++
    }
  })
  return {
    sampledAtFrame: frame,
    errorTarget: tiles.errorTarget,
    visible: stats.visible ?? 0,
    active: stats.active ?? 0,
    inFrustum: stats.inFrustum ?? 0,
    loaded: stats.loaded ?? 0,
    inCache: stats.inCache ?? 0,
    queued: stats.queued ?? 0,
    downloading: stats.downloading ?? 0,
    parsing: stats.parsing ?? 0,
    failed: stats.failed ?? 0,
    loadEnds,
    loadErrors,
    meshes,
    withNormals,
    basicMaterials,
    otherMaterials,
    transparentMaterials
  }
}

// Only under ?e2e=1: fills smokeProbe.tiles for the credentialed smoke
const TilesProbe: FC<{ tiles: TilesRendererImpl | null }> = ({ tiles }) => {
  const [counts] = useState({ loadEnds: 0, loadErrors: 0, frame: 0 })
  useEffect(() => {
    if (tiles == null || smokeProbe == null) return
    const onEnd = (): void => {
      counts.loadEnds++
    }
    const onError = (): void => {
      counts.loadErrors++
    }
    tiles.addEventListener('tiles-load-end', onEnd)
    tiles.addEventListener('load-error', onError)
    return () => {
      tiles.removeEventListener('tiles-load-end', onEnd)
      tiles.removeEventListener('load-error', onError)
    }
  }, [tiles, counts])
  useFrame(() => {
    if (tiles == null || smokeProbe == null) return
    counts.frame++
    if (counts.frame % PROBE_EVERY !== 0) return
    smokeProbe.tiles = sampleTiles(
      tiles,
      counts.frame,
      counts.loadEnds,
      counts.loadErrors
    )
  })
  return null
}

export const Globe: FC<{ children?: ReactNode }> = ({ children }) => {
  const [tiles, setTiles] = useState<TilesRendererImpl | null>(null)
  if (ionToken == null || ionToken === '') {
    // Refusing beats rendering an empty globe: a missing token otherwise looks
    // exactly like tiles that failed to load, and the two need different fixes
    throw new Error(
      'examples/r3f: VITE_ION_TOKEN is not set. Add it to examples/r3f/.env.local'
    )
  }
  return (
    <TilesRenderer
      ref={setTiles}
      // The auth plugin's recommended settings set the error target (20) and
      // the cache sizes once the tileset loads, so a prop here is overridden
      // unless those settings are off, as the smoke's error-target arm does
      {...(Number.isFinite(smokeErrorTarget)
        ? { errorTarget: smokeErrorTarget }
        : {})}
    >
      {
        // Array form, not upstream's bare object: TilesPlugin accepts both at
        // runtime, but only the array form is typed in 0.4.28. One element, so
        // it spreads to the same single-object call
      }
      <TilesPlugin
        plugin={CesiumIonAuthPlugin}
        args={[
          {
            apiToken: ionToken,
            assetId: ION_ASSET_ID,
            autoRefreshToken: true,
            useRecommendedSettings: !Number.isFinite(smokeErrorTarget)
          }
        ]}
      />
      <TilesPlugin plugin={GLTFExtensionsPlugin} dracoLoader={dracoLoader} />
      <TilesPlugin plugin={TileCompressionPlugin} />
      <TilesPlugin plugin={UpdateOnChangePlugin} />
      <TilesPlugin plugin={TilesFadePlugin} />
      {
        // GlobeControls makes the camera interactive AND drives tile
        // refinement: LOD follows the camera, so a camera that never moves
        // never asks for better tiles
      }
      <GlobeControls enableDamping />
      <TilesAttributionOverlay />
      {smokeProbe != null && <TilesProbe tiles={tiles} />}
      {children}
    </TilesRenderer>
  )
}
