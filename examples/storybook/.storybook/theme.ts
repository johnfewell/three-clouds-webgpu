// Adapted from three-geospatial storybook-webgpu/.storybook/theme.ts (MIT,
// Copyright (c) 2024 Shota Matsuda)

import { create, themes } from 'storybook/theming'

export const main = create({
  base: 'dark',
  brandTitle: 'three-clouds-webgpu',
  brandUrl: 'https://github.com/johnfewell/three-clouds-webgpu',
  fontCode: `Consolas, ${themes.normal.fontCode}`
})

export const docs = create({
  base: 'light',
  fontBase: `Inter, ${themes.normal.fontBase}`,
  fontCode: `Consolas, ${themes.normal.fontCode}`
})
