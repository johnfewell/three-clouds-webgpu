// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Vector3, Vector4 } from 'three'

import { log, setCurrentSpec } from '../test/helpers/log'
import { CloudsContext } from './CloudsContext'
import { createLayerUniforms, updateLayerUniforms } from './layerUniforms'

describe('layerUniforms', () => {
  beforeEach(() => {
    setCurrentSpec('layerUniforms')
  })

  function logUniformTable(label: string, ctx: CloudsContext) {
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)
    const table = [
      {
        name: 'minLayerHeights',
        value: u.minLayerHeights.value.toArray().join(',')
      },
      {
        name: 'maxLayerHeights',
        value: u.maxLayerHeights.value.toArray().join(',')
      },
      {
        name: 'minIntervalHeights',
        value: u.minIntervalHeights.value.toArray().join(',')
      },
      {
        name: 'maxIntervalHeights',
        value: u.maxIntervalHeights.value.toArray().join(',')
      },
      {
        name: 'densityScales',
        value: u.densityScales.value.toArray().join(',')
      },
      { name: 'shapeAmounts', value: u.shapeAmounts.value.toArray().join(',') },
      {
        name: 'shapeDetailAmounts',
        value: u.shapeDetailAmounts.value.toArray().join(',')
      },
      {
        name: 'weatherExponents',
        value: u.weatherExponents.value.toArray().join(',')
      },
      {
        name: 'shapeAlteringBiases',
        value: u.shapeAlteringBiases.value.toArray().join(',')
      },
      {
        name: 'coverageFilterWidths',
        value: u.coverageFilterWidths.value.toArray().join(',')
      },
      { name: 'minHeight', value: u.minHeight.value },
      { name: 'maxHeight', value: u.maxHeight.value },
      { name: 'shadowTopHeight', value: u.shadowTopHeight.value },
      { name: 'shadowBottomHeight', value: u.shadowBottomHeight.value },
      {
        name: 'shadowLayerMask',
        value: u.shadowLayerMask.value.toArray().join(',')
      },
      {
        name: 'densityProfileExpTerms',
        value: u.densityProfileExpTerms.value.toArray().join(',')
      },
      {
        name: 'densityProfileExponents',
        value: u.densityProfileExponents.value.toArray().join(',')
      },
      {
        name: 'densityProfileLinearTerms',
        value: u.densityProfileLinearTerms.value.toArray().join(',')
      },
      {
        name: 'densityProfileConstantTerms',
        value: u.densityProfileConstantTerms.value.toArray().join(',')
      }
    ]
    log(`layerUniforms:${label}`, table)
    return u
  }

  test('createLayerUniforms returns zero-initialised nodes', () => {
    const u = createLayerUniforms()
    expect(u.minLayerHeights.value).toBeInstanceOf(Vector4)
    expect(u.maxLayerHeights.value).toBeInstanceOf(Vector4)
    expect(u.minIntervalHeights.value).toBeInstanceOf(Vector3)
    expect(u.maxIntervalHeights.value).toBeInstanceOf(Vector3)
    expect(u.minHeight.value).toBe(0)
    expect(u.maxHeight.value).toBe(0)
    expect(u.shadowTopHeight.value).toBe(0)
    expect(u.shadowBottomHeight.value).toBe(0)
  })

  test('DEFAULT layers produce expected height bounds', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    logUniformTable('DEFAULT', ctx)

    expect(u.minHeight.value).toBe(750)
    expect(u.maxHeight.value).toBe(8000)
    expect(u.shadowTopHeight.value).toBe(2200)
    expect(u.shadowBottomHeight.value).toBe(750)
  })

  test('DEFAULT layers produce expected shadow mask', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    expect(u.shadowLayerMask.value.x).toBe(1)
    expect(u.shadowLayerMask.value.y).toBe(1)
    expect(u.shadowLayerMask.value.z).toBe(0)
    expect(u.shadowLayerMask.value.w).toBe(0)
  })

  test('DEFAULT layers pack altitude and top vectors', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    expect(u.minLayerHeights.value).toEqual(new Vector4(750, 1000, 7500, 0))
    expect(u.maxLayerHeights.value).toEqual(new Vector4(1400, 2200, 8000, 0))
  })

  test('DEFAULT layers produce interval gap at [2200, 7500]', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    const minI = u.minIntervalHeights.value
    const maxI = u.maxIntervalHeights.value
    expect(minI.x).toBe(0)
    expect(maxI.x).toBe(750)
    expect(minI.y).toBe(2200)
    expect(maxI.y).toBe(7500)
    expect(minI.z).toBe(0)
    expect(maxI.z).toBe(0)
  })

  test('DEFAULT density profiles match DensityProfile defaults', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    expect(u.densityProfileExpTerms.value).toEqual(new Vector4(0, 0, 0, 0))
    expect(u.densityProfileExponents.value).toEqual(new Vector4(0, 0, 0, 0))
    expect(u.densityProfileLinearTerms.value).toEqual(
      new Vector4(0.75, 0.75, 0.75, 0.75)
    )
    expect(u.densityProfileConstantTerms.value).toEqual(
      new Vector4(0.25, 0.25, 0.25, 0.25)
    )
  })

  test('DEFAULT packed scalars match layer properties', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    expect(u.densityScales.value).toEqual(new Vector4(0.2, 0.2, 0.003, 0.2))
    expect(u.shapeAmounts.value).toEqual(new Vector4(1, 1, 0.4, 1))
    expect(u.shapeDetailAmounts.value).toEqual(new Vector4(1, 1, 0, 1))
    expect(u.weatherExponents.value).toEqual(new Vector4(1, 1, 1, 1))
    expect(u.shapeAlteringBiases.value).toEqual(
      new Vector4(0.35, 0.35, 0.35, 0.35)
    )
    expect(u.coverageFilterWidths.value).toEqual(
      new Vector4(0.6, 0.6, 0.5, 0.6)
    )
  })

  test('custom 4-layer set logs correct values', () => {
    const ctx = new CloudsContext()
    ctx.cloudLayers.set([
      {
        channel: 'r',
        altitude: 500,
        height: 1000,
        shadow: true,
        densityScale: 0.5
      },
      {
        channel: 'g',
        altitude: 2000,
        height: 2000,
        shadow: true,
        densityScale: 0.3
      },
      {
        channel: 'b',
        altitude: 5000,
        height: 1500,
        shadow: true,
        densityScale: 0.1
      },
      {
        channel: 'a',
        altitude: 8000,
        height: 500,
        shadow: false,
        densityScale: 0.05
      }
    ])
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    logUniformTable('custom-4-layer', ctx)

    expect(u.minHeight.value).toBe(500)
    expect(u.maxHeight.value).toBe(8500)
    expect(u.shadowBottomHeight.value).toBe(500)
    expect(u.shadowTopHeight.value).toBe(6500)
    expect(u.shadowLayerMask.value).toEqual(new Vector4(1, 1, 1, 0))
    expect(u.minLayerHeights.value).toEqual(new Vector4(500, 2000, 5000, 8000))
    expect(u.maxLayerHeights.value).toEqual(new Vector4(1500, 4000, 6500, 8500))
  })

  test('all layers height=0 → minHeight=0, no maxHeight', () => {
    const ctx = new CloudsContext()
    ctx.cloudLayers.reset()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    expect(u.minHeight.value).toBe(0)
    expect(u.shadowBottomHeight.value).toBe(0)
  })

  test('no shadow layers → shadowBottomHeight=0', () => {
    const ctx = new CloudsContext()
    ctx.cloudLayers.reset()
    ctx.cloudLayers.set([
      { channel: 'r', altitude: 1000, height: 500, shadow: false },
      { channel: 'g', altitude: 2000, height: 500, shadow: false }
    ])
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)

    expect(u.minHeight.value).toBe(1000)
    expect(u.maxHeight.value).toBe(2500)
    expect(u.shadowBottomHeight.value).toBe(0)
    expect(u.shadowTopHeight.value).toBe(0)
  })

  test('changing a layer channel triggers graph rebuild', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()

    updateLayerUniforms(u, ctx)
    const v0 = ctx.graphVersion

    updateLayerUniforms(u, ctx)
    expect(ctx.graphVersion).toBe(v0)

    ctx.cloudLayers[0]!.channel = 'b'
    updateLayerUniforms(u, ctx)
    expect(ctx.graphVersion).toBe(v0 + 1)

    updateLayerUniforms(u, ctx)
    expect(ctx.graphVersion).toBe(v0 + 1)
  })

  test('updateLayerUniforms is idempotent with unchanged layers', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()

    updateLayerUniforms(u, ctx)
    const snapshot = {
      minHeight: u.minHeight.value,
      maxHeight: u.maxHeight.value,
      shadowTop: u.shadowTopHeight.value,
      shadowBottom: u.shadowBottomHeight.value,
      mask: u.shadowLayerMask.value.clone()
    }

    updateLayerUniforms(u, ctx)
    expect(u.minHeight.value).toBe(snapshot.minHeight)
    expect(u.maxHeight.value).toBe(snapshot.maxHeight)
    expect(u.shadowTopHeight.value).toBe(snapshot.shadowTop)
    expect(u.shadowBottomHeight.value).toBe(snapshot.shadowBottom)
    expect(u.shadowLayerMask.value).toEqual(snapshot.mask)
  })
})
