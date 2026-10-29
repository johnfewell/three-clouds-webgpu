import { expect, test } from 'vitest'

import { log } from '../test/helpers/log'
import { CloudLayer } from './CloudLayer'
import { DensityProfile, type DensityProfileLike } from './DensityProfile'

const coefficients = [
  'expTerm',
  'exponent',
  'linearTerm',
  'constantTerm'
] as const

test.each(coefficients)(
  'constructing with only %s preserves the other profile defaults',
  coefficient => {
    const options = { [coefficient]: 1.25 }
    const layer = new CloudLayer({ densityProfile: options })
    const expected = CloudLayer.DEFAULT.densityProfile.clone()
    expected[coefficient] = 1.25
    expect(layer.densityProfile).toEqual(expected)
    expect(layer.densityProfile).not.toBe(options)
    expect(Object.values(layer.densityProfile).every(Number.isFinite)).toBe(
      true
    )
    log('partial-profile-construction', {
      coefficient,
      computed: { ...layer.densityProfile },
      expected: { ...expected }
    })
  }
)

test('set patches the existing profile without sharing or replacing objects', () => {
  const supplied = new DensityProfile(1, 2, 3, 4)
  const layer = new CloudLayer({ densityProfile: supplied })
  const profile = layer.densityProfile
  const patch = { exponent: 0 }
  expect(layer.set({ densityProfile: patch })).toBe(layer)
  expect(layer.densityProfile).toBe(profile)
  expect(profile).toEqual(new DensityProfile(1, 0, 3, 4))
  expect(supplied).toEqual(new DensityProfile(1, 2, 3, 4))
  patch.exponent = 50
  supplied.expTerm = 60
  expect(profile).toEqual(new DensityProfile(1, 0, 3, 4))
  log('partial-profile-patch', {
    computed: { ...profile },
    expected: { expTerm: 1, exponent: 0, linearTerm: 3, constantTerm: 4 },
    identityPreserved: layer.densityProfile === profile
  })
})

test('empty, undefined and runtime null coefficients preserve current values', () => {
  const layer = new CloudLayer({
    densityProfile: new DensityProfile(1, 2, 3, 4)
  })
  const patch: DensityProfileLike = { expTerm: undefined }
  Reflect.set(patch, 'linearTerm', null)
  Reflect.set(patch, 'ignored', 123)
  layer.set({ densityProfile: {} })
  layer.set({ densityProfile: patch })
  expect(layer.densityProfile).toEqual(new DensityProfile(1, 2, 3, 4))
  expect(layer.densityProfile).not.toHaveProperty('ignored')
  log('nullish-profile-patch', {
    computed: { ...layer.densityProfile },
    expected: { expTerm: 1, exponent: 2, linearTerm: 3, constantTerm: 4 }
  })
})

test('complete profiles, layer copies and clones remain independent', () => {
  const supplied = new DensityProfile(1, 2, 3, 4)
  const source = new CloudLayer({ densityProfile: supplied })
  const clone = source.clone()
  const copied = new CloudLayer().copy(source)
  expect(clone.densityProfile).toEqual(supplied)
  expect(copied.densityProfile).toEqual(supplied)
  expect(clone.densityProfile).not.toBe(source.densityProfile)
  expect(copied.densityProfile).not.toBe(source.densityProfile)
  clone.densityProfile.exponent = 9
  copied.densityProfile.linearTerm = 8
  expect(source.densityProfile).toEqual(supplied)
  expect(new DensityProfile(9, 9, 9, 9).copy(supplied)).toEqual(supplied)
  log('complete-profile-copies', {
    source: { ...source.densityProfile },
    expected: { ...supplied },
    independent: true
  })
})
