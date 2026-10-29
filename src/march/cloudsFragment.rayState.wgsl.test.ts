// The ray state a below-deck camera needs, as emitted WGSL
//
// A camera below every layer rendered no clouds and raised no error. The CPU
// twin cannot see it: the arithmetic was never wrong. TSL emits a var where a
// node is FIRST USED, the first use is inside getRayNearFar's altitude branches,
// so plain nodes are declared there and read back zero-initialised after the If

import { writeFileSync } from 'node:fs'
import { Matrix4, Vector3 } from 'three'
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
import { describe, expect, it } from 'vitest'

import {
  compileWGSL,
  findStructByMembers,
  normalizeWGSL
} from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { buildCloudsFragment, type CloudsFragmentDeps } from './cloudsFragment'

const emptyMarch = struct({ layer: 'vec4', depthVelocity: 'vec4' })

// A named uniform, so the emitted text carries the name and the declarations
// can be counted without matching literals
function belowLayerDeps(): CloudsFragmentDeps {
  const identity = mat4(new Matrix4())
  return {
    inverseProjectionMatrix: identity,
    inverseViewMatrix: identity,
    worldToECEFMatrix: identity,
    ecefToWorldMatrix: identity,
    reprojectionMatrix: identity,
    viewReprojectionMatrix: identity,
    cameraPositionECEF: uniform(new Vector3(0, 0, 6371400)).setName(
      'osdnCameraPosition'
    ),
    cameraDirectionECEF: vec3(0, 0, -1),
    altitudeCorrection: vec3(0),
    cameraNear: float(1),
    cameraFar: float(1e7),
    sunDirection: vec3(1, 0, 0),
    bottomRadius: float(6371000),
    worldToUnit: float(1 / 6371000),
    cameraHeight: float(400),
    maxRayDistance: float(200000),
    minHeight: float(1500),
    maxHeight: float(3000),
    shadowTopHeight: float(3000),
    localWeatherRepeat: vec2(1),
    localWeatherOffset: vec2(0),
    resolution: vec2(800, 600),
    mipLevelScale: float(1),
    marchClouds: Fn(() => emptyMarch(vec4(0), vec4(-1, 0, 0, 0))),
    applyAerialPerspective: (_c, _f, _s, color) => color,
    getRayDistanceToScene: null,
    stbn: float(0),
    lightShafts: false,
    marchShadowLength: null,
    marchShadowLengthQuadPartial: null,
    maxShadowLengthRayDistance: null,
    haze: false,
    approximateHaze: null,
    debug: 'none',
    shadowBuffer: null,
    shadowCascadeCount: int(0)
  }
}

function compileBelowLayer(): string {
  return compileWGSL(buildCloudsFragment(belowLayerDeps()).layer).fragment
}

// CLOUDS_OSDN_DUMP=<path> writes the fragment normalized, statement per line,
// so a before/after WGSL diff shows only the hoisted lines moving
function dumpIfAsked(fragment: string): void {
  const target = process.env.CLOUDS_OSDN_DUMP
  if (target == null) return
  writeFileSync(target, `${normalizeWGSL(fragment).replace(/;/g, ';\n')}\n`)
}

describe('cloudsFragment ray state below the deck', () => {
  setCurrentSpec('cloudsFragment-ray-state')

  it('builds the ray state once, before the altitude branch', () => {
    const fragment = compileBelowLayer()
    dumpIfAsked(fragment)

    const intersections = [...fragment.matchAll(/CloudIntersections\(/g)]
    const shellStruct = findStructByMembers(fragment, {
      near: 'vec4<f32>',
      far: 'vec4<f32>'
    })
    const shells = [...fragment.matchAll(new RegExp(`${shellStruct}\\(`, 'g'))]
    // The corrected camera position: cameraPositionECEF + altitudeCorrection
    // A per-branch declaration repeats it once per altitude branch
    const rayOrigin = [...fragment.matchAll(/osdnCameraPosition \+/g)]
    const branchIndex = fragment.indexOf('if (')

    log('ray-state-wgsl', [
      {
        field: 'getIntersections constructions',
        expected: 1,
        actual: intersections.length
      },
      {
        field: 'raySpheresIntersections calls',
        expected: 1,
        actual: shells.length
      },
      {
        field: 'cameraPosition additions',
        expected: 1,
        actual: rayOrigin.length
      },
      {
        field: 'declared before the altitude branch',
        expected: true,
        actual:
          intersections[0] !== undefined &&
          intersections[0].index < branchIndex &&
          rayOrigin[0] !== undefined &&
          rayOrigin[0].index < branchIndex
      }
    ])

    // One computation, one declaration, above the branch (clouds.frag:730-769
    // builds the ray state once). Three constructions means per-branch state,
    // and the reads after the If then see branch-local vars
    expect(intersections).toHaveLength(1)
    expect(shells).toHaveLength(1)
    expect(rayOrigin).toHaveLength(1)
    expect(branchIndex).toBeGreaterThan(-1)
    expect(
      intersections[0]!.index,
      'the ray state must be declared before the altitude branch'
    ).toBeLessThan(branchIndex)
    expect(
      rayOrigin[0]!.index,
      'the corrected camera position must be declared before the branch'
    ).toBeLessThan(branchIndex)
  })

  it('hands the branch-independent ray state to the consumers after the If', () => {
    const fragment = compileBelowLayer()
    const branchIndex = fragment.indexOf('if (')
    const fragmentRay = [...fragment.matchAll(/CloudsFragmentRay\(/g)]

    log('ray-state-consumers', [
      {
        field: 'CloudsFragmentRay constructions',
        expected: 1,
        actual: fragmentRay.length
      },
      {
        field: 'consumed after the branch',
        expected: true,
        actual:
          fragmentRay[0] !== undefined && fragmentRay[0].index > branchIndex
      }
    ])

    // The march, the miss and the composite all read the struct built here, so
    // per-branch declarations feed them zero-initialised vars instead
    expect(fragmentRay).toHaveLength(1)
    expect(fragmentRay[0]!.index).toBeGreaterThan(branchIndex)
  })
})
