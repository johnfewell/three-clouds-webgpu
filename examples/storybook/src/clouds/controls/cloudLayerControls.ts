// The "cloud layers" folder of the WebGL panel, from three-geospatial
// storybook/src/clouds/helpers/useCloudsControls.ts @ b012ad06 (MIT, Copyright
// (c) 2024 Shota Matsuda), expressed as Storybook args: four layers × the
// CloudLayerLike fields + the density profile, written straight onto
// context.cloudLayers[i] the way the WebGL panel writes effect.cloudLayers[i]

import type { ArgTypes } from '@storybook/react-vite'
import {
  CloudLayer,
  type CloudsContext,
  type TextureChannel
} from 'three-clouds-webgpu'

import { useTransientControl } from '../../vendor/hooks/useTransientControl'

const LAYER_COUNT = 4

interface LayerField {
  key: string
  name: string
  control:
    | { type: 'range'; min: number; max: number; step?: number }
    | { type: 'boolean' }
    | { type: 'select'; options: readonly string[] }
  get: (layer: CloudLayer) => number | boolean | string
  set: (layer: CloudLayer, value: never) => void
}

const range = (min: number, max: number, step?: number) =>
  ({ type: 'range', min, max, step }) as const

function field<K extends keyof CloudLayer>(
  key: K,
  control: LayerField['control']
): LayerField {
  return {
    key,
    name: key,
    control,
    get: layer => layer[key] as number | boolean | string,
    set: (layer, value) => {
      ;(layer as unknown as Record<string, unknown>)[key] = value
    }
  }
}

function profileField(
  key: 'expTerm' | 'exponent' | 'linearTerm' | 'constantTerm',
  control: LayerField['control']
): LayerField {
  return {
    key: `densityProfile-${key}`,
    name: `density profile ${key}`,
    control,
    get: layer => layer.densityProfile[key],
    set: (layer, value: number) => {
      layer.densityProfile[key] = value
    }
  }
}

const layerFields: readonly LayerField[] = [
  field('channel', { type: 'select', options: ['r', 'g', 'b', 'a'] }),
  field('altitude', range(0, 10000)),
  field('height', range(0, 4000)),
  field('densityScale', range(0, 1, 0.001)),
  field('shapeAmount', range(0, 1, 0.01)),
  field('shapeDetailAmount', range(0, 1, 0.01)),
  field('weatherExponent', range(0, 3, 0.01)),
  field('shapeAlteringBias', range(0, 1, 0.01)),
  field('coverageFilterWidth', range(0, 1, 0.01)),
  field('shadow', { type: 'boolean' }),
  profileField('expTerm', range(0, 1, 0.01)),
  profileField('exponent', range(-10, 10, 0.001)),
  profileField('linearTerm', range(-2, 2, 0.01)),
  profileField('constantTerm', range(-2, 2, 0.01))
]

const argKey = (index: number, key: string): string =>
  `layer${index + 1}-${key}`

export type CloudLayerArgs = Record<string, unknown>

// Initial values from the context's own layers (CloudLayers.DEFAULT, or the
// story's <CloudLayer> children once they have mounted)
export const cloudLayerArgs = (reference: CloudsContext): CloudLayerArgs =>
  Object.fromEntries(
    Array.from({ length: LAYER_COUNT }, (_, index) =>
      layerFields.map(f => [
        argKey(index, f.key),
        f.get(reference.cloudLayers[index] ?? CloudLayer.DEFAULT)
      ])
    ).flat()
  )

export const cloudLayerArgTypes = (): ArgTypes<CloudLayerArgs> =>
  Object.fromEntries(
    Array.from({ length: LAYER_COUNT }, (_, index) =>
      layerFields.map(f => [
        argKey(index, f.key),
        {
          name: f.name,
          ...(f.control.type === 'select'
            ? { control: { type: 'select' }, options: f.control.options }
            : { control: f.control }),
          table: { category: `cloud layer ${index + 1}` }
        }
      ])
    ).flat()
  )

export function useCloudLayerControls(context: CloudsContext): void {
  useTransientControl(
    (args: CloudLayerArgs) =>
      Object.fromEntries(
        Array.from({ length: LAYER_COUNT }, (_, index) =>
          layerFields.map(f => [
            argKey(index, f.key),
            args[argKey(index, f.key)]
          ])
        ).flat()
      ),
    (values, prevValues) => {
      for (let index = 0; index < LAYER_COUNT; ++index) {
        const layer = context.cloudLayers[index]
        if (layer == null) continue
        for (const f of layerFields) {
          const key = argKey(index, f.key)
          const value = values[key]
          if (value === undefined) continue
          if (prevValues != null && prevValues[key] === value) continue
          f.set(layer, value as never)
        }
      }
    }
  )
}

export type { TextureChannel }
