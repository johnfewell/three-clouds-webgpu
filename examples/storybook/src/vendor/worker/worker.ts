// Vendored from three-geospatial storybook-webgpu/src/worker/worker.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Edited: computeWaterAreaTileImage dropped (the water-area overlay plugin is
// not vendored).

import workerpool from 'workerpool'

import { computeCreasedNormalAttribute } from './tasks/computeCreasedNormalAttribute'

export const methods = {
  computeCreasedNormalAttribute
}

workerpool.worker(methods)
