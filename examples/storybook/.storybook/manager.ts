// Adapted from three-geospatial storybook-webgpu/.storybook/manager.ts (MIT,
// Copyright (c) 2024 Shota Matsuda). Adds the controls filter at the end

/* cspell:words customisations */

import { addons, type State } from 'storybook/manager-api'

import { installControlsFilter } from './controlsFilter'
import { main } from './theme'

addons.setConfig({
  theme: main,
  initialActive: 'canvas',
  panelPosition: 'right',
  layoutCustomisations: {
    showPanel(state: State, defaultValue: boolean) {
      return defaultValue
    }
  }
})

addons.register('focusIFrame', () => {
  addons.getChannel().on('currentStoryWasSet', () => {
    const iframe = document.querySelector('#storybook-preview-iframe')
    if (iframe != null) {
      ;(iframe as HTMLIFrameElement).focus()
    }
  })
})

// Not upstream: a filter box over the controls, and collapsed categories that
// stay collapsed from story to story
addons.register('controlsFilter', installControlsFilter)
