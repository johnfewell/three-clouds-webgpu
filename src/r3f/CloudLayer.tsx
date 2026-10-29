// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: r3f/CloudLayer.tsx:1-96

import {
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  type FC,
  type Ref
} from 'react'

import type { ExpandNestedProps } from '@takram/three-geospatial/r3f'

import {
  CloudLayer as CloudLayerImpl,
  type CloudLayerLike
} from '../CloudLayer'
import { CloudLayers } from '../CloudLayers'
import { CloudLayersContext, useCloudLayerAllocation } from './CloudLayers'

/**
 * One declarative layer, rebuilt from its slot default and props on each render
 * Removed props return to that slot's default rather than keeping old values
 * Altitude and height are metres, as on the underlying CloudLayer
 * Nested densityProfile applies first, explicit dashed coefficients win
 */
export interface CloudLayerProps
  extends CloudLayerLike, ExpandNestedProps<CloudLayerLike, 'densityProfile'> {
  /** The current slot object, updated when explicit requests move an automatic layer */
  ref?: Ref<CloudLayerImpl>
  /**
   * A unique slot from 0 through 3. Invalid or occupied slots throw.
   * Explicit requests take priority, including later mounts and index changes
   * Omit for a free slot, retained unless an explicit request moves it
   * A fifth layer throws
   */
  index?: 0 | 1 | 2 | 3
}

/**
 * Declare one of four cloud slots inside Clouds or CloudLayers
 * Changing index releases the old slot, unmount restores its default and frees it
 * With disableDefaultLayers, released slots return to zero height instead
 */
export const CloudLayer: FC<CloudLayerProps> = ({
  ref: forwardedRef,
  index: indexProp,
  ...props
}) => {
  const context = useContext(CloudLayersContext)
  if (context == null) {
    throw new Error('CloudLayer can only be used within the Clouds component!')
  }

  const { layers, disableDefault } = context
  const allocation = useCloudLayerAllocation(context, indexProp)

  useLayoutEffect(() => {
    const index = allocation.index
    if (index == null) return
    const layer = layers[index]!
    layer.copy(
      disableDefault ? CloudLayerImpl.DEFAULT : CloudLayers.DEFAULT[index]!
    )
    layer.set(props)
    layer.set({
      densityProfile: {
        expTerm: props['densityProfile-expTerm'],
        exponent: props['densityProfile-exponent'],
        linearTerm: props['densityProfile-linearTerm'],
        constantTerm: props['densityProfile-constantTerm']
      }
    })
  })

  useImperativeHandle<CloudLayerImpl | null, CloudLayerImpl | null>(
    forwardedRef,
    () => (allocation.index == null ? null : layers[allocation.index]!),
    [layers, allocation.index, indexProp, disableDefault]
  )

  return null
}
