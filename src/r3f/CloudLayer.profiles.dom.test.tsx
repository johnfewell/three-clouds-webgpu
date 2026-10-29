// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import { expect, expectTypeOf, test } from 'vitest'

import { log } from '../../test/helpers/log'
import { CloudLayer as CloudLayerImpl } from '../CloudLayer'
import { CloudLayers as CloudLayersImpl } from '../CloudLayers'
import { DensityProfile, type DensityProfileLike } from '../DensityProfile'
import { CloudLayer, type CloudLayerProps } from './CloudLayer'
import { CloudLayers } from './CloudLayers'

const coefficientProps = [
  ['densityProfile-expTerm', 'expTerm'],
  ['densityProfile-exponent', 'exponent'],
  ['densityProfile-linearTerm', 'linearTerm'],
  ['densityProfile-constantTerm', 'constantTerm']
] as const

test('nested profile coefficients and advertised dashed props retain numeric types', () => {
  expectTypeOf<CloudLayerProps['densityProfile']>().toEqualTypeOf<
    DensityProfileLike | undefined
  >()
  type DashedProp = (typeof coefficientProps)[number][0]
  expectTypeOf<CloudLayerProps[DashedProp]>().toEqualTypeOf<
    number | undefined
  >()
  expectTypeOf<{ 'densityProfile-expTerm': string }>()
    // @ts-expect-error a coefficient is numeric, not arbitrary JSX input
    .toExtend<CloudLayerProps>()
  log('profile-prop-types', { nested: 'partial', dashed: 'number' })
})

test.each(coefficientProps)('%s reaches the mounted profile', (prop, key) => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  const ref = createRef<CloudLayerImpl>()
  const props: CloudLayerProps = { [prop]: 7.5 }
  const mounted = render(
    <CloudLayers layers={layers} disableDefault>
      <CloudLayer ref={ref} {...props} />
    </CloudLayers>
  )
  const expected = CloudLayerImpl.DEFAULT.densityProfile.clone()
  expected[key] = 7.5
  expect(ref.current).toBe(layers[0])
  expect(ref.current!.densityProfile).toEqual(expected)
  log('dashed-profile-prop', {
    prop,
    computed: { ...ref.current!.densityProfile },
    expected: { ...expected }
  })
  mounted.unmount()
  expect(ref.current).toBeNull()
})

test.each([false, true])(
  'nested and dashed precedence, removal and refs preserve the baseline (empty=%s)',
  disableDefault => {
    const layers = CloudLayersImpl.DEFAULT.clone()
    const ref = createRef<CloudLayerImpl>()
    const baseline = (
      disableDefault ? CloudLayerImpl.DEFAULT : CloudLayersImpl.DEFAULT[1]!
    ).densityProfile.clone()
    const nested = { expTerm: 1, exponent: 2, linearTerm: 3, constantTerm: 4 }
    const view = (props: CloudLayerProps) => (
      <StrictMode>
        <CloudLayers layers={layers} disableDefault={disableDefault}>
          <CloudLayer ref={ref} index={1} {...props} />
        </CloudLayers>
      </StrictMode>
    )
    const mounted = render(
      view({
        densityProfile: nested,
        'densityProfile-expTerm': 9,
        'densityProfile-linearTerm': 0
      })
    )
    const layer = ref.current!
    const profile = layer.densityProfile
    expect(layer).toBe(layers[1])
    expect(profile).toEqual(new DensityProfile(9, 2, 0, 4))
    expect(nested).toEqual({
      expTerm: 1,
      exponent: 2,
      linearTerm: 3,
      constantTerm: 4
    })
    mounted.rerender(
      view({ densityProfile: { exponent: 5 }, 'densityProfile-expTerm': 7 })
    )
    expect(ref.current).toBe(layer)
    expect(layer.densityProfile).toBe(profile)
    expect(profile).toEqual(
      new DensityProfile(7, 5, baseline.linearTerm, baseline.constantTerm)
    )
    mounted.rerender(view({ densityProfile: { expTerm: 2 } }))
    const nestedOnly = baseline.clone()
    nestedOnly.expTerm = 2
    expect(profile).toEqual(nestedOnly)
    mounted.rerender(view({}))
    expect(ref.current).toBe(layer)
    expect(layer.densityProfile).toBe(profile)
    expect(profile).toEqual(baseline)
    mounted.unmount()
    expect(ref.current).toBeNull()
    expect(layers[1]!.densityProfile).toEqual(baseline)
    log('profile-prop-lifecycle', {
      disableDefault,
      computed: { ...profile },
      expected: { ...baseline },
      stableSlotAndProfile: true,
      refCleared: true
    })
  }
)
