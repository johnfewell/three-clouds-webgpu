import { Matrix4 } from 'three'
import {
  float,
  Fn,
  int,
  mat4,
  struct,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import { describe, expect, test } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { buildCloudsFragment, type CloudsFragmentDeps } from './cloudsFragment'
import { sceneDepthStruct } from './sceneDepth'

const emptyMarch = struct({ layer: 'vec4', depthVelocity: 'vec4' })

// Compile the actual orchestration with inert cloud/lighting callbacks. A CPU
// haze twin alone cannot catch a missing scene-depth clamp at its call site
function compileHaze(haze: boolean, sceneDepth: boolean) {
  const identity = mat4(new Matrix4())
  const deps: CloudsFragmentDeps = {
    inverseProjectionMatrix: identity,
    inverseViewMatrix: identity,
    worldToECEFMatrix: identity,
    ecefToWorldMatrix: identity,
    reprojectionMatrix: identity,
    viewReprojectionMatrix: identity,
    cameraPositionECEF: vec3(0, 0, 6371500),
    cameraDirectionECEF: vec3(0, 0, -1),
    altitudeCorrection: vec3(0),
    cameraNear: float(1),
    cameraFar: float(1e7),
    sunDirection: vec3(1, 0, 0),
    bottomRadius: float(6371000),
    worldToUnit: float(1 / 6371000),
    cameraHeight: float(500),
    maxRayDistance: float(200000),
    minHeight: float(1000),
    maxHeight: float(5000),
    shadowTopHeight: float(5000),
    localWeatherRepeat: vec2(1),
    localWeatherOffset: vec2(0),
    resolution: vec2(800, 600),
    mipLevelScale: float(1),
    marchClouds: Fn(() => emptyMarch(vec4(0), vec4(-1, 0, 0, 0))),
    applyAerialPerspective: (_camera, _front, _shadowLength, color) => color,
    getRayDistanceToScene: sceneDepth
      ? Fn(() =>
          sceneDepthStruct(
            uniform(8000).setName('terrainDistance'),
            float(-8000)
          )
        )
      : null,
    stbn: float(0),
    lightShafts: false,
    marchShadowLength: null,
    marchShadowLengthQuadPartial: null,
    maxShadowLengthRayDistance: null,
    haze,
    approximateHaze: (_origin, _direction, distance) => vec4(vec3(distance), 1),
    debug: 'none',
    shadowBuffer: null,
    shadowCascadeCount: int(0)
  }
  return compileWGSL(buildCloudsFragment(deps).layer).fragment
}

describe('haze terrain occlusion', () => {
  test('scene geometry clamps both cloud and haze intervals, not only clouds', () => {
    const wgsl = compileHaze(true, true)
    // Both interval endpoints must use the same scene ray distance. The
    // reference clamps these together in clouds.frag:848-856
    const clamps = [
      ...wgsl.matchAll(/(\w+)\.y = min\( \1\.y, [^;]+\.rayDistance \);/g)
    ]
    log('terrain ray endpoint clamps', { expected: 2, actual: clamps.length })
    expect(clamps).toHaveLength(2)
  })

  test('disabled haze keeps only the existing cloud depth clamp', () => {
    const wgsl = compileHaze(false, true)
    const clamps = [
      ...wgsl.matchAll(/(\w+)\.y = min\( \1\.y, [^;]+\.rayDistance \);/g)
    ]
    log('haze disabled endpoint clamps', { expected: 1, actual: clamps.length })
    expect(clamps).toHaveLength(1)
  })

  test('a depthless sky retains shell-bounded haze', () => {
    const wgsl = compileHaze(true, false)
    expect(wgsl).not.toContain('terrainDistance')
    log('depthless sky', { terrainClamp: wgsl.includes('terrainDistance') })
  })
})
