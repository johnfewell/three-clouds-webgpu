// Vendored from three-geospatial storybook-webgpu/types/3d-tiles-renderer-script.d.ts
// @ b012ad06 (MIT, Copyright (c) 2024 Shota Matsuda), trimmed to the fade
// plugin's deep imports. Ambient on purpose (no top-level import): a `declare
// module` in a module file augments and cannot create these modules

declare module '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js' {
  import type { Material } from 'three'

  export function wrapFadeMaterial(
    material: Material,
    previousOnBeforeCompile: unknown
  ): {
    fadeIn: { value: number }
    fadeOut: { value: number }
    fadeTexture: { value: unknown }
  }
}

declare module '3d-tiles-renderer/src/three/plugins/fade/FadeMaterialManager.js' {
  import type { Material } from 'three'

  export class FadeMaterialManager {
    protected prepareMaterial(material: Material): void
  }
}
