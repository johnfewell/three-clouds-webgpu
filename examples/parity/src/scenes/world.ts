// World scene: Google Photorealistic 3D Tiles via 3d-tiles-renderer
// Case 52: look-only, no numeric parity (tile streaming is non-deterministic)
// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)

import { TilesRenderer } from '3d-tiles-renderer'
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/plugins'
import {
  Matrix4,
  MeshBasicMaterial,
  type Camera,
  type Color,
  type Scene,
  type WebGLRenderer
} from 'three'

export interface WorldSceneAvailability {
  available: boolean
  skipReason?: string
}

export interface WorldSceneResult {
  tilesRenderer: TilesRenderer
  worldToECEFMatrix: Matrix4
  update: () => void
  dispose: () => void
}

export function checkWorldAvailability(
  apiKey: string | undefined | null
): WorldSceneAvailability {
  if (apiKey == null || apiKey === '') {
    return { available: false, skipReason: 'missing credential' }
  }
  return { available: true }
}

export function getGoogleTilesApiKey(): string | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_PARITY_GOOGLE_TILES_KEY
  } catch {
    return undefined
  }
}

function forceUnlitMaterials(tilesRenderer: TilesRenderer): void {
  tilesRenderer.forEachLoadedModel(scene => {
    scene.traverse(obj => {
      const mesh = obj as { material?: MeshBasicMaterial; isMesh?: boolean }
      if (mesh.isMesh && mesh.material != null) {
        const oldMat = mesh.material as { color?: { clone: () => Color } }
        const color = oldMat.color?.clone()
        const unlit = new MeshBasicMaterial()
        if (color != null) {
          unlit.color = color
        }
        mesh.material = unlit
      }
    })
  })
}

export function createWorldScene(
  scene: Scene,
  camera: Camera,
  renderer: WebGLRenderer,
  apiKey: string
): WorldSceneResult {
  const tilesRenderer = new TilesRenderer()
  tilesRenderer.registerPlugin(
    new GoogleCloudAuthPlugin({
      apiToken: apiKey,
      useRecommendedSettings: true
    })
  )

  tilesRenderer.setCamera(camera)
  tilesRenderer.setResolutionFromRenderer(camera, renderer)
  scene.add(tilesRenderer.group)

  const worldToECEFMatrix = new Matrix4()

  function update(): void {
    tilesRenderer.update()
    forceUnlitMaterials(tilesRenderer)
    worldToECEFMatrix.copy(tilesRenderer.group.matrixWorld)
  }

  function dispose(): void {
    scene.remove(tilesRenderer.group)
    tilesRenderer.dispose()
  }

  return { tilesRenderer, worldToECEFMatrix, update, dispose }
}
