// Vendored from three-geospatial storybook/src/helpers/Globe.tsx @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda) — the WebGL reference storybook.
// Edited: TileCreasedNormalsPlugin shared with the WebGPU vendor tree (it is
// renderer-agnostic); TilesPlugin args in 3d-tiles-renderer 0.4.28's array form.

import type { TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer'
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/core/plugins'
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/plugins'
import {
  TilesAttributionOverlay,
  TilesPlugin,
  TilesRenderer
} from '3d-tiles-renderer/r3f'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState, type FC, type ReactNode, type Ref } from 'react'
import { mergeRefs } from 'react-merge-refs'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

import { radians } from '@takram/three-geospatial'

import { TileCreasedNormalsPlugin } from '../../vendor/plugins/TileCreasedNormalsPlugin'
import { googleMapsApiKeyAtom, needsApiKeyAtom } from './states'

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')

export interface GlobeProps {
  ref?: Ref<TilesRendererImpl>
  children?: ReactNode
}
export const Globe: FC<GlobeProps> = ({ ref, children }) => {
  const inputApiKey = useAtomValue(googleMapsApiKeyAtom)
  const apiKey =
    inputApiKey !== ''
      ? inputApiKey
      : import.meta.env.STORYBOOK_GOOGLE_MAP_API_KEY

  const [tiles, setTiles] = useState<TilesRendererImpl | null>(null)
  const setNeedsApiKey = useSetAtom(needsApiKeyAtom)
  useEffect(() => {
    if (tiles == null) {
      return
    }
    const callback = (): void => {
      setNeedsApiKey(true)
    }
    tiles.addEventListener('load-error', callback)
    return () => {
      tiles.removeEventListener('load-error', callback)
    }
  }, [tiles, setNeedsApiKey])

  return (
    <TilesRenderer
      ref={mergeRefs([ref, setTiles])}
      // Reconstruct tiles when API key changes.
      key={apiKey}
    >
      {(import.meta.env.STORYBOOK_GOOGLE_MAP_API_KEY ?? apiKey ?? '') !== '' ? (
        <TilesPlugin
          plugin={GoogleCloudAuthPlugin}
          args={[
            {
              apiToken: apiKey,
              autoRefreshToken: true
            }
          ]}
        />
      ) : (
        <TilesPlugin
          plugin={CesiumIonAuthPlugin}
          args={[
            {
              apiToken: import.meta.env.STORYBOOK_ION_API_TOKEN,
              assetId: '2275207', // Google Photorealistic Tiles
              autoRefreshToken: true
            }
          ]}
        />
      )}
      <TilesPlugin plugin={GLTFExtensionsPlugin} dracoLoader={dracoLoader} />
      <TilesPlugin plugin={TileCompressionPlugin} />
      <TilesPlugin plugin={UpdateOnChangePlugin} />
      <TilesPlugin plugin={TilesFadePlugin} />
      <TilesPlugin
        plugin={TileCreasedNormalsPlugin}
        args={[{ creaseAngle: radians(30) }]}
      />
      {children}
      <TilesAttributionOverlay />
    </TilesRenderer>
  )
}
