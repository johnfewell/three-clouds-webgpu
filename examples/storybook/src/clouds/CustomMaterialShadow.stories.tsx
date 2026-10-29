import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as CustomMaterialShadowStory } from './Clouds-CustomMaterialShadow'

import CustomMaterialShadowCode from './Clouds-CustomMaterialShadow?raw'

export default {
  title: 'clouds-webgpu/CustomMaterialShadow',
  parameters: {
    docs: {
      codePanel: true,
      source: {
        language: 'tsx'
      }
    }
  }
} satisfies Meta

// the public cloud shadow on a material of the consumer's own. The
// left patch multiplies by pass.cloudShadowAt(positionWorld), the right one does
// not, so the still shows the shadow arriving without the aerial pass
export const ShadowedVsUnshadowed = createStory(CustomMaterialShadowStory, {
  parameters: { docs: { source: { code: CustomMaterialShadowCode } } }
})
