// @ts-nocheck
// Vendored from three-geospatial storybook-webgpu/src/plugins/fade/wrapFadeNodeMaterial.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Verbatim, bar the @ts-nocheck above: tsc checks every file the
// program reaches and these are imported by the stories, so a tsconfig
// exclude cannot reach them. Not ours to typecheck, like reference/**.

// Ported to TSL from: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.4.14/src/three/plugins/fade/wrapFadeMaterial.js
// NASA-AMMOS/3DTilesRendererJS is Apache-2.0, Copyright (c) 2020 NASA/JPL-Caltech.
// That is a SECOND licence under this file, not the MIT one above: Apache-2.0 §4
// requires the licence text, a statement of the changes made, and retention of
// upstream notices. The two statements are (a) this is a manual port of the GLSL
// material to TSL node functions, with no behaviour intended to differ, and (b)
// upstream ships no NOTICE file at v0.4.14. Licence text: THIRD_PARTY_NOTICES.md.

import { Discard, Fn, If, output, screenCoordinate, uniform } from 'three/tsl'
import type { NodeFrame, NodeMaterial } from 'three/webgpu'

import { FnLayout } from '@takram/three-geospatial/webgpu'

import type { FadeParams } from './FadeMaterialManager'

const FADE_PARAMS = Symbol('FADE_PARAMS')

interface FadeParamsHost {
  [FADE_PARAMS]?: FadeParams
  defines?: Record<string, unknown>
}

function getFadeParams({ material }: NodeFrame): FadeParams | undefined {
  return (material as FadeParamsHost)[FADE_PARAMS]
}

const bayerDither2x2 = FnLayout({
  name: 'bayerDither2x2',
  type: 'float',
  inputs: [{ name: 'v', type: 'vec2' }]
})(([v]) => {
  return v.y.mul(3).add(v.x.mul(2)).mod(4)
})

const bayerDither4x4 = FnLayout({
  name: 'bayerDither4x4',
  type: 'float',
  inputs: [{ name: 'v', type: 'vec2' }]
})(([v]) => {
  const P1 = v.mod(2)
  const P2 = v.mod(4).mul(0.5).floor()
  return bayerDither2x2(P1).mul(4).add(bayerDither2x2(P2))
})

const fadeIn = uniform(0).onObjectUpdate((frame, self) => {
  const params = getFadeParams(frame)
  self.value = params?.fadeIn.value ?? 0
})

const fadeOut = uniform(0).onObjectUpdate((frame, self) => {
  const params = getFadeParams(frame)
  self.value = params?.fadeOut.value ?? 0
})

const outputNode = Fn(() => {
  const bayerValue = bayerDither4x4(screenCoordinate.xy.mod(4).floor())
  const bayerBins = 16
  const dither = bayerValue.add(0.5).div(bayerBins)

  If(dither.greaterThanEqual(fadeIn), () => {
    Discard()
  })
  If(dither.lessThan(fadeOut), () => {
    Discard()
  })
  return output
})()

export function wrapFadeNodeMaterial(
  material: NodeMaterial & FadeParamsHost
): FadeParams {
  if (material[FADE_PARAMS] != null) {
    return material[FADE_PARAMS]
  }

  const params: FadeParams = {
    fadeIn: { value: 0 },
    fadeOut: { value: 0 },
    fadeTexture: { value: null }
  }
  material[FADE_PARAMS] = params

  let featureFade = 0

  // Use the same interface used for non-node materials:
  material.defines = {
    ...material.defines,

    get FEATURE_FADE() {
      return featureFade
    },

    set FEATURE_FADE(value: number) {
      if (value !== featureFade) {
        featureFade = value
        material.outputNode = value === 1 ? outputNode : null
      }
    }
  }

  return params
}
