import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { log } from '../../test/helpers/log'
import {
  CloudEnvironmentNode,
  cloudEnvironmentRefreshDue,
  DEFAULT_CLOUD_ENVIRONMENT,
  environmentTexelFootprint,
  type CloudEnvironmentBakeInput,
  type CloudEnvironmentDueInput
} from './cloudEnvironment'

/**
 * A renderer stand-in, cast once. CubeCamera.update takes three's whole renderer
 * interface, which a recorder cannot be. The fake cube camera below never calls
 * it: what these tests count is how many times update() is reached, not how many
 * faces the real one would draw.
 */
function fakeRenderer(): CloudEnvironmentBakeInput['renderer'] {
  return {} as unknown as CloudEnvironmentBakeInput['renderer']
}

function due(over: Partial<CloudEnvironmentDueInput> = {}) {
  return cloudEnvironmentRefreshDue({
    framesSinceBake: 0,
    updateInterval: 4,
    graphChanged: false,
    cameraMoved: 0,
    distanceThreshold: 1000,
    sunMoved: 0,
    angularThreshold: 0.0017,
    baked: true,
    forced: false,
    ...over
  })
}

describe('the environment refresh schedule', () => {
  it('bakes the first frame even though nothing has changed', () => {
    const reasons = [
      due({ baked: false, framesSinceBake: 0 }),
      due({ baked: false, framesSinceBake: 99 })
    ]
    log('environment-first-bake', { reasons })
    expect(reasons).toEqual(['initial', 'initial'])
  })

  it('holds a steady camera and sun for updateInterval frames', () => {
    const held = [0, 1, 2, 3].map(framesSinceBake => due({ framesSinceBake }))
    const fired = due({ framesSinceBake: 4 })
    log('environment-schedule', { held, fired })
    expect(held).toEqual([null, null, null, null])
    expect(fired).toBe('schedule')
  })

  it('reports the trigger that fired, so a caller can log which one it was', () => {
    const reasons = {
      forced: due({ forced: true, graphChanged: true, framesSinceBake: 99 }),
      graph: due({ graphChanged: true, cameraMoved: 1e9 }),
      camera: due({ cameraMoved: 1001 }),
      sun: due({ sunMoved: 0.01 }),
      schedule: due({ framesSinceBake: 4 })
    }
    log('environment-reasons', reasons)
    expect(reasons).toEqual({
      forced: 'forced',
      graph: 'graph',
      camera: 'camera',
      sun: 'sun',
      schedule: 'schedule'
    })
  })

  it('leaves a move INSIDE either threshold to the schedule', () => {
    const reasons = [
      due({ cameraMoved: 1000, framesSinceBake: 1 }),
      due({ sunMoved: 0.0017, framesSinceBake: 1 })
    ]
    log('environment-thresholds', {
      atThreshold: reasons,
      maxRayDistance: DEFAULT_CLOUD_ENVIRONMENT.maxIterationCount
    })
    expect(reasons).toEqual([null, null])
  })

  // A schedule that fires one frame early or late is invisible in a picture and
  // is the whole difference between a refresh every fourth frame and every third
  it('REJECTS a schedule that fires on the wrong frame', () => {
    const offByOne = due({ framesSinceBake: 3 })
    log('environment-off-by-one', { offByOne })
    expect(offByOne).toBe(null)
    expect(due({ updateInterval: 1, framesSinceBake: 1 })).toBe('schedule')
  })

  // Without the graph trigger a preset change would leave the map describing the
  // volume the frame has stopped showing, for updateInterval frames or longer
  it('REJECTS a refresh that ignores a graph rebuild', () => {
    const reasons = [
      due({ graphChanged: true, framesSinceBake: 1 }),
      due({ graphChanged: false, framesSinceBake: 1 })
    ]
    log('environment-graph-trigger', reasons)
    expect(reasons).toEqual(['graph', null])
  })
})

describe('the environment node', () => {
  it('bakes on the first call and then only when due', () => {
    const node = new CloudEnvironmentNode()
    const calls: number[] = []
    const renderer = fakeRenderer()
    const camera = new Vector3(1, 2, 3)
    const sun = new Vector3(0, 0, 1)
    // A graph the bake can run from: the node under test owns none, so the
    // cube target is minted directly, which is what buildGraph does
    const graph = node as unknown as {
      cubeTarget: unknown
      cubeCamera: unknown
      staleGraph: boolean
    }
    graph.cubeTarget = { texture: {}, dispose: () => {} }
    graph.cubeCamera = { update: () => calls.push(calls.length) }
    graph.staleGraph = true

    const reasons = [
      node.bakeIfDue({
        renderer,
        cameraPositionECEF: camera,
        sunDirectionECEF: sun
      }),
      node.bakeIfDue({
        renderer,
        cameraPositionECEF: camera,
        sunDirectionECEF: sun
      }),
      node.bakeIfDue({
        renderer,
        cameraPositionECEF: camera,
        sunDirectionECEF: sun
      }),
      node.bakeIfDue({
        renderer,
        cameraPositionECEF: camera,
        sunDirectionECEF: sun
      }),
      node.bakeIfDue({
        renderer,
        cameraPositionECEF: camera,
        sunDirectionECEF: sun
      })
    ]
    log('environment-node-bakes', {
      reasons,
      renderCalls: calls.length,
      bakeCount: node.bakeCount,
      hasBaked: node.hasBaked,
      lastReason: node.lastBakeReason
    })
    expect(reasons).toEqual(['initial', null, null, null, 'schedule'])
    expect(node.bakeCount).toBe(2)
    expect(calls.length).toBe(2)
  })

  it('honours a forced refresh over the schedule', () => {
    const node = new CloudEnvironmentNode()
    const calls: number[] = []
    const renderer = fakeRenderer()
    const camera = new Vector3()
    const sun = new Vector3(0, 0, 1)
    const graph = node as unknown as {
      cubeTarget: unknown
      cubeCamera: unknown
      staleGraph: boolean
    }
    graph.cubeTarget = { texture: {}, dispose: () => {} }
    graph.cubeCamera = { update: () => calls.push(calls.length) }
    graph.staleGraph = true
    const bake = () =>
      node.bakeIfDue({
        renderer,
        cameraPositionECEF: camera,
        sunDirectionECEF: sun
      })
    expect(bake()).toBe('initial')
    expect(bake()).toBe(null)
    node.refresh()
    expect(bake()).toBe('forced')
    // One forced bake is one bake, not a latch that keeps firing
    expect(bake()).toBe(null)
  })

  // The off graph must not allocate: a reflection target that exists with the
  // option off costs a cube map and a second march for nothing
  it('REJECTS a bake with no cube target', () => {
    const node = new CloudEnvironmentNode()
    const reasons = [
      node.bakeIfDue({
        renderer: fakeRenderer(),
        cameraPositionECEF: new Vector3(),
        sunDirectionECEF: new Vector3(0, 0, 1)
      }),
      node.bakeIfDue({
        renderer: fakeRenderer(),
        cameraPositionECEF: new Vector3(),
        sunDirectionECEF: new Vector3(0, 0, 1)
      })
    ]
    log('environment-off-graph', { reasons, bakeCount: node.bakeCount })
    expect(reasons).toEqual([null, null])
    expect(node.bakeCount).toBe(0)
    expect(node.setup()).toBeNull()
  })

  it('reads back null once the graph is cleared', () => {
    const node = new CloudEnvironmentNode()
    const graph = node as unknown as { cubeTarget: unknown }
    graph.cubeTarget = { texture: {}, dispose: () => {} }
    node.clear()
    expect(node.setup()).toBeNull()
    expect(node.hasBaked).toBe(false)
  })
})

describe('the aliasing an environment map costs', () => {
  // A cube face is one flat quad, so the screen pass's derivative mip has no
  // equivalent here. This is the footprint that remains, at the far end of the
  // ray where it is worst
  it('grows with the ray and shrinks with the face', () => {
    const at = (size: number, distance: number) =>
      environmentTexelFootprint(size, distance)
    const rows = {
      size64_at60km: at(64, 60000),
      size128_at60km: at(128, 60000),
      size64_at6km: at(64, 6000),
      size64_at600km: at(64, 600000)
    }
    log('environment-footprint-m', rows)
    expect(rows.size64_at6km).toBeCloseTo((Math.PI / 2 / 64) * 6000, 6)
    expect(rows.size128_at60km).toBeCloseTo(rows.size64_at60km / 2, 6)
    expect(rows.size64_at600km).toBeCloseTo(rows.size64_at60km * 10, 6)
  })

  it('REJECTS a footprint that ignores either input', () => {
    log('environment-footprint-corners', {
      zero: environmentTexelFootprint(64, 0),
      negativeSize: environmentTexelFootprint(-64, 60000)
    })
    expect(environmentTexelFootprint(64, 0)).toBe(0)
    expect(environmentTexelFootprint(-64, 60000)).toBeLessThan(0)
  })
})
