// Vendored from three-geospatial storybook-webgpu/types/3d-tiles-renderer-module.d.ts
// @ b012ad06 (MIT, Copyright (c) 2024 Shota Matsuda), trimmed to the plugins
// this storybook vendors (deep-import shims: 3d-tiles-renderer-script.d.ts)
// The r3f shim is not vendored: 0.4.28 ships its own r3f types

import type { TilesRenderer } from '3d-tiles-renderer'

export {}

declare module '3d-tiles-renderer/three/plugins' {
  interface UpdateOnChangePlugin {
    tiles?: TilesRenderer | null
    needsUpdate: boolean

    init(tiles: TilesRenderer): void
    doTilesNeedUpdate(): boolean
    dispose(): void
  }
}
