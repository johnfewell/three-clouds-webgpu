// Vendored from three-geospatial storybook-webgpu/src/plugins/fade/TilesFadePlugin.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Verbatim.

import { TilesFadePlugin as TilesFadePluginBase } from '3d-tiles-renderer/three/plugins'

import { FadeMaterialManager } from './FadeMaterialManager'

export class TilesFadePlugin extends TilesFadePluginBase {
  declare protected _fadeMaterialManager: unknown

  constructor(...args: ConstructorParameters<typeof TilesFadePluginBase>) {
    super(...args)
    this._fadeMaterialManager = new FadeMaterialManager()
  }
}
