// The baked assets, decoded for the CPU density evaluator
//
// The same four files the GPU samples: the weather map, the shape volume and
// the shape detail volume. The turbulence map is not loaded, because the
// controlled scene turns turbulence off
//
// Cite: src/textures/loadBakedCloudTextures.ts (the formats)

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPngFile, Texture2D, Volume3D } from './textures.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** The repository's assets directory */
export function assetsRoot() {
  return resolve(here, '..', '..', 'assets')
}

/** Load the weather map, the shape volume and the shape detail volume */
export function loadAssets(root = assetsRoot()) {
  const weather = loadPngFile(join(root, 'local_weather.png'))
  const shapeData = readFileSync(join(root, 'shape.bin'))
  const detailData = readFileSync(join(root, 'shape_detail.bin'))
  const shapeSize = Math.round(Math.cbrt(shapeData.length))
  const detailSize = Math.round(Math.cbrt(detailData.length))
  if (shapeSize * shapeSize * shapeSize !== shapeData.length) {
    throw new Error(`shape.bin is not a cube: ${shapeData.length} bytes`)
  }
  if (detailSize * detailSize * detailSize !== detailData.length) {
    throw new Error(
      `shape_detail.bin is not a cube: ${detailData.length} bytes`
    )
  }
  return {
    weather: new Texture2D(weather.width, weather.height, weather.data),
    shape: new Volume3D(shapeSize, new Uint8Array(shapeData)),
    shapeDetail: new Volume3D(detailSize, new Uint8Array(detailData))
  }
}
