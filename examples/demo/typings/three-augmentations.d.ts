// Runtime members on NodeLibrary in three 0.185.1 not yet in @types/three 0.185.0

import type { Light, ToneMapping } from 'three'

export {}

declare module 'three/src/renderers/common/nodes/NodeLibrary.js' {
  export default interface NodeLibrary {
    addToneMapping(toneMappingNode: unknown, toneMapping: ToneMapping): void
    addLight(
      lightNodeClass: new (...args: never[]) => unknown,
      lightClass: new (...args: never[]) => Light
    ): void
  }
}
