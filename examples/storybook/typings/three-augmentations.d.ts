// Members three 0.185.1 has at runtime but @types/three 0.185.0 lacks
// (NodeLibrary.js addToneMapping :82, addLight :112). WebGPUCanvas registers
// the AgX punchy variant through the first, the lit stories the
// cloud-shadowed AtmosphereLight node through the second

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
