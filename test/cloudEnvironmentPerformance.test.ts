// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// Cloud Environment Cube PMREM Sampling & Refresh Costs
import { Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { CloudsPassNode } from '../src/CloudsPassNode'
import {
  CloudEnvironmentNode,
  cloudEnvironmentRefreshDue,
  DEFAULT_CLOUD_ENVIRONMENT,
  environmentTexelFootprint
} from '../src/experimental/cloudEnvironment'

describe('Cloud Environment Cube PMREM & Refresh Costs', () => {
  it('guarantees that optional cloud environment path is inactive and absent when disabled', () => {
    const pass = new CloudsPassNode({ sceneDepth: null })
    expect(pass.cloudsContext.experimental.cloudEnvironment).toBe(false)

    const env = pass.environment
    expect(env.cubeTexture).toBeNull()
    expect(env.setup()).toBeNull()
    expect(env.hasBaked).toBe(false)
    expect(env.bakeCount).toBe(0)

    const mockRenderer = { render: vi.fn() }
    const reason = env.bakeIfDue({
      renderer: mockRenderer as never,
      cameraPositionECEF: new Vector3(0, 0, 6378137),
      sunDirectionECEF: new Vector3(0, 0, 1)
    })
    expect(reason).toBeNull()
    expect(mockRenderer.render).not.toHaveBeenCalled()
  })

  it('demonstrates refresh decision rules and scheduling (initial, schedule, camera, sun, forced)', () => {
    const settings = DEFAULT_CLOUD_ENVIRONMENT
    expect(settings.size).toBe(64)
    expect(settings.updateInterval).toBe(4)

    // 1. Initial bake
    expect(
      cloudEnvironmentRefreshDue({
        framesSinceBake: 0,
        updateInterval: 4,
        graphChanged: false,
        cameraMoved: 0,
        distanceThreshold: 1000,
        sunMoved: 0,
        angularThreshold: 0.0017,
        baked: false,
        forced: false
      })
    ).toBe('initial')

    // 2. Unchanged warm frame (frame 1-3 after bake)
    expect(
      cloudEnvironmentRefreshDue({
        framesSinceBake: 2,
        updateInterval: 4,
        graphChanged: false,
        cameraMoved: 50,
        distanceThreshold: 1000,
        sunMoved: 0.0001,
        angularThreshold: 0.0017,
        baked: true,
        forced: false
      })
    ).toBeNull()

    // 3. Scheduled bake (frame 4 reached)
    expect(
      cloudEnvironmentRefreshDue({
        framesSinceBake: 4,
        updateInterval: 4,
        graphChanged: false,
        cameraMoved: 0,
        distanceThreshold: 1000,
        sunMoved: 0,
        angularThreshold: 0.0017,
        baked: true,
        forced: false
      })
    ).toBe('schedule')

    // 4. Camera movement trigger (>1000m)
    expect(
      cloudEnvironmentRefreshDue({
        framesSinceBake: 1,
        updateInterval: 4,
        graphChanged: false,
        cameraMoved: 1200,
        distanceThreshold: 1000,
        sunMoved: 0,
        angularThreshold: 0.0017,
        baked: true,
        forced: false
      })
    ).toBe('camera')

    // 5. Sun movement trigger (> angularThreshold)
    expect(
      cloudEnvironmentRefreshDue({
        framesSinceBake: 1,
        updateInterval: 4,
        graphChanged: false,
        cameraMoved: 0,
        distanceThreshold: 1000,
        sunMoved: 0.05,
        angularThreshold: 0.0017,
        baked: true,
        forced: false
      })
    ).toBe('sun')

    // 6. Graph invalidation trigger
    expect(
      cloudEnvironmentRefreshDue({
        framesSinceBake: 1,
        updateInterval: 4,
        graphChanged: true,
        cameraMoved: 0,
        distanceThreshold: 1000,
        sunMoved: 0,
        angularThreshold: 0.0017,
        baked: true,
        forced: false
      })
    ).toBe('graph')

    // 7. Explicit forced refresh
    expect(
      cloudEnvironmentRefreshDue({
        framesSinceBake: 1,
        updateInterval: 4,
        graphChanged: false,
        cameraMoved: 0,
        distanceThreshold: 1000,
        sunMoved: 0,
        angularThreshold: 0.0017,
        baked: true,
        forced: true
      })
    ).toBe('forced')
  })

  it('computes correct geometric texel footprint for default 64x64 cube resolution', () => {
    // At maxRayDistance = 100,000m (100km atmosphere horizon):
    // footprint = (PI / 2 / 64) * 100000 = ~2454.37 meters per texel
    const footprint = environmentTexelFootprint(64, 100000)
    expect(footprint).toBeCloseTo(2454.37, 1)
  })

  it('maintains clean lifecycle disposal for cube target, mesh, and materials', () => {
    const node = new CloudEnvironmentNode()
    const materialDisposeSpy = vi.spyOn(node['material'], 'dispose')
    const geometryDisposeSpy = vi.spyOn(node['mesh'].geometry, 'dispose')

    node.dispose()

    expect(materialDisposeSpy).toHaveBeenCalledOnce()
    expect(geometryDisposeSpy).toHaveBeenCalledOnce()
  })
})
