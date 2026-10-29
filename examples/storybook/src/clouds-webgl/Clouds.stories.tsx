// The WebGL REFERENCE stories (@takram/three-clouds 0.7.6, the chain the parity
// ladder calls side A), one sidebar click from their WebGPU counterparts under
// clouds/. Same titles, same parameters, same camera poses.

import type { Meta } from '@storybook/react-vite'

import _Basic from './Clouds-Basic'
import _CustomLayers from './Clouds-CustomLayers'
import _WorldOriginRebasing from './Clouds-WorldOriginRebasing'

export default {
  title: 'clouds-webgl/Clouds',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

export const Basic = _Basic
export const CustomLayers = _CustomLayers
export const WorldOriginRebasing = _WorldOriginRebasing
