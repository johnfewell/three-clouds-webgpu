// Type-level tests for the <Clouds> compound props. vitest re-exports
// expectTypeOf, so these need no new dependency, and they run in the same
// `pnpm test` as the runtime suites
//
// The gate is tsc, not vitest. An unused `// @ts-expect-error` is itself an
// error (TS2578), which is what stops a prop that widened to `any` passing

import { expectTypeOf, test } from 'vitest'

import type { ExperimentalCloudOptions } from '../experimental/options'
import type { QualityPreset } from '../qualityPresets'
import type { CloudLayerProps } from './CloudLayer'
import type { CloudsProps } from './Clouds'

type ExperimentalProp = NonNullable<CloudsProps['experimental']>

test('layer indices are limited to the four supported slots', () => {
  expectTypeOf<CloudLayerProps['index']>().toEqualTypeOf<
    0 | 1 | 2 | 3 | undefined
  >()
})

test('experimental is a partial of the context options', () => {
  expectTypeOf<CloudsProps['experimental']>().toEqualTypeOf<
    Partial<ExperimentalCloudOptions> | undefined
  >()
})

test('an empty experimental object is legal', () => {
  expectTypeOf<{}>().toExtend<ExperimentalProp>()
})

test('every option name is accepted', () => {
  expectTypeOf<ExperimentalCloudOptions>().toExtend<ExperimentalProp>()
})

test('a single option is accepted, the rest are optional', () => {
  expectTypeOf<{ computeResolve: boolean }>().toExtend<ExperimentalProp>()
})

test('an unknown option name is rejected', () => {
  expectTypeOf<{ notAnOption: boolean }>()
    // @ts-expect-error notAnOption is not an ExperimentalCloudOptions key
    .toExtend<ExperimentalProp>()
})

test('a non-boolean option value is rejected', () => {
  expectTypeOf<{ computeResolve: string }>()
    // @ts-expect-error the options are all boolean
    .toExtend<ExperimentalProp>()
})

test('qualityPreset is the preset union', () => {
  expectTypeOf<CloudsProps['qualityPreset']>().toEqualTypeOf<
    QualityPreset | undefined
  >()
})

test('every preset name is accepted', () => {
  expectTypeOf<QualityPreset>().toEqualTypeOf<
    'low' | 'medium' | 'high' | 'ultra' | 'lowEnd'
  >()
})

test('an unknown preset name is rejected', () => {
  expectTypeOf<'extreme'>()
    // @ts-expect-error 'extreme' is not a QualityPreset
    .toExtend<NonNullable<CloudsProps['qualityPreset']>>()
})

// The new props must not become required: a bare <Clouds> has to keep
// typechecking. Required-ness is read off the keys rather than by trying to
// extend CloudsProps, because sceneDepth is required and would drown the check
test('both new props are optional', () => {
  expectTypeOf<
    Pick<CloudsProps, 'experimental' | 'qualityPreset'>
  >().toEqualTypeOf<{
    experimental?: Partial<ExperimentalCloudOptions>
    qualityPreset?: QualityPreset
  }>()
})

// The scalar knobs stay reachable, so a preset and an explicit override can
// coexist on one <Clouds>
test('an explicit scalar knob stays a prop alongside both new props', () => {
  expectTypeOf<{
    resolutionScale: number
    experimental: { computeResolve: boolean }
    qualityPreset: 'low'
  }>().toExtend<
    Pick<CloudsProps, 'resolutionScale' | 'experimental' | 'qualityPreset'>
  >()
})
