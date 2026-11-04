// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Source: clouds.frag:718–810

import { REVISION } from 'three'
import { Fn, If, struct, Var, vec2, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import * as atmosphere from '@takram/three-atmosphere/webgpu'
import * as geospatial from '@takram/three-geospatial/webgpu'

// getIntersections reads lanes .z and .w of the shell intersections, which
// only a build with forkBuild.raySpheresIntersectionsLanes = 4 masks. Older
// builds leave those lanes without the -1 miss and the march goes wrong silently
export function assertFourLaneIntersections(marker: unknown): void {
  const lanes = (marker as { raySpheresIntersectionsLanes?: unknown } | null)
    ?.raySpheresIntersectionsLanes
  if (lanes !== 4) {
    throw new Error(
      '@takram/three-geospatial does not mask every lane of ' +
        'raySpheresIntersections, so the cloud march would read wrong shell ' +
        'intersections. Install the @takram/three-geospatial fork build ' +
        '0.9.1+fork.8 (see the README)'
    )
  }
}

interface ForkMarker {
  release?: unknown
  r186Kernels?: unknown
}

const INSTALL_R186 =
  'Install both fork builds from one release, 0.19.1+fork.8 / 0.9.1+fork.8 ' +
  '(see the README)'

function describeMarker(name: string, marker: ForkMarker | null | undefined) {
  return marker == null
    ? `${name} has no forkBuild marker`
    : `${name} is fork release ${String(marker.release)} without r186Kernels`
}

// Only three r186 declares a node shared across branches inside one branch,
// which breaks the atmosphere's scattering LUT on builds that do not declare
// r186Kernels. Each package declares its own, from fork release 7
export function assertR186Kernels(
  atmosphereMarker: unknown,
  geospatialMarker: unknown,
  revision: string
): void {
  if (!revision.startsWith('186')) return
  const markers = [
    ['@takram/three-atmosphere', atmosphereMarker],
    ['@takram/three-geospatial', geospatialMarker]
  ] as const
  const missing = markers.filter(
    ([, marker]) => (marker as ForkMarker | null)?.r186Kernels !== true
  )
  if (missing.length > 0) {
    throw new Error(
      'On three r186 the atmosphere computes its scattering LUT wrong, so ' +
        'the sky and aerial perspective render too dark: ' +
        missing
          .map(([name, marker]) => describeMarker(name, marker as ForkMarker))
          .join(', ') +
        `. ${INSTALL_R186}`
    )
  }
  const atmosphereRelease = (atmosphereMarker as ForkMarker).release
  const geospatialRelease = (geospatialMarker as ForkMarker).release
  if (atmosphereRelease !== geospatialRelease) {
    throw new Error(
      `@takram/three-atmosphere is fork release ${String(atmosphereRelease)} ` +
        `and @takram/three-geospatial is fork release ${String(geospatialRelease)}. ` +
        INSTALL_R186
    )
  }
}

const forkBuild = (geospatial as Record<string, unknown>)['forkBuild']
assertFourLaneIntersections(forkBuild)
assertR186Kernels(
  (atmosphere as Record<string, unknown>)['forkBuild'],
  forkBuild,
  REVISION
)

// clouds.frag:718–722
export const rayIntersectsGround = /*#__PURE__*/ Fn(
  ([cameraPosition, rayDirection, bottomRadius]: [
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'float'>
  ]) => {
    const r = cameraPosition.length()
    const mu = cameraPosition.dot(rayDirection).div(r)
    return mu
      .lessThan(0)
      .and(
        r
          .mul(r)
          .mul(mu.mul(mu).sub(1))
          .add(bottomRadius.mul(bottomRadius))
          .greaterThanEqual(0)
      )
  }
)

// A TSL Fn returns exactly one node, so the three outputs travel as a struct
// and are read with .get('ground' | 'first' | 'second')
export const intersectionsStruct = /*#__PURE__*/ struct(
  { ground: 'bool', first: 'vec4', second: 'vec4' },
  'CloudIntersections'
)

// clouds.frag:730–741
// Reference: https://github.com/GameTechDev/OutdoorLightScattering/blob/master/fx/Common.fxh#L148
export const getIntersections = /*#__PURE__*/ Fn(
  ([
    cameraPosition,
    rayDirection,
    bottomRadius,
    minHeight,
    maxHeight,
    shadowTopHeight
  ]: [
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const ground = rayIntersectsGround(
      cameraPosition,
      rayDirection,
      bottomRadius
    )
    const radii = bottomRadius.add(
      vec4(0, minHeight, maxHeight, shadowTopHeight)
    )
    // Masks every lane of vec4 radii from fork release 4 (core webgpu/math.ts)
    const result = geospatial.raySpheresIntersections(
      cameraPosition,
      rayDirection,
      vec3(0),
      radii
    )
    const first = result.get('near')
    const second = result.get('far')
    return intersectionsStruct(ground, first, second)
  }
)

interface MaybeVar {
  isVarNode?: boolean
  intent?: boolean
  node?: MaybeVar
}

// A Fn wraps each argument in an intent var, inlined unless assigned. When the
// caller passed a var it stays, so the WGSL gains no copy. A plain node
// becomes a var here, above the branches that read it
function declared<T extends 'bool' | 'vec4'>(param: Node<T>): Node<T> {
  const p = param as MaybeVar
  const arg = p.isVarNode === true && p.intent === true ? p.node : p
  return arg?.isVarNode === true && arg.intent !== true ? param : Var(param)
}

interface IntersectionMembers {
  ground: Node<'bool'>
  first: Node<'vec4'>
  second: Node<'vec4'>
}

// clouds.frag:743–769. Each altitude branch calls `intersections`, which must
// return fresh nodes or vars: three r186 declares a plain node the branches
// share inside the first branch only
export const rayNearFarFrom = (intersections: () => IntersectionMembers) =>
  Fn(
    ([cameraHeight, cameraNear, minHeight, maxHeight, maxRayDistance]: [
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const nearFar = vec2(-1).toVar()

      If(cameraHeight.lessThan(minHeight), () => {
        const { ground, second } = intersections()
        If(ground, () => {
          nearFar.assign(vec2(-1))
        }).Else(() => {
          nearFar.assign(vec2(second.y, second.z.min(maxRayDistance)))
        })
      })
        .ElseIf(cameraHeight.lessThan(maxHeight), () => {
          const { ground, first, second } = intersections()
          If(ground, () => {
            nearFar.assign(vec2(cameraNear, first.y))
          }).Else(() => {
            nearFar.assign(vec2(cameraNear, second.z))
          })
        })
        .Else(() => {
          const { ground, first, second } = intersections()
          nearFar.assign(vec2(first.z, second.z))
          If(ground, () => {
            nearFar.y.assign(first.y)
          })
        })

      return nearFar
    }
  )

export const getRayNearFar = /*#__PURE__*/ Fn(
  ([
    ground,
    first,
    second,
    cameraHeight,
    cameraNear,
    minHeight,
    maxHeight,
    maxRayDistance
  ]: [
    Node<'bool'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const members = {
      ground: declared(ground),
      first: declared(first),
      second: declared(second)
    }
    return rayNearFarFrom(() => members)(
      cameraHeight,
      cameraNear,
      minHeight,
      maxHeight,
      maxRayDistance
    )
  }
)

// clouds.frag:772–789
export const getShadowRayNearFar = /*#__PURE__*/ Fn(
  ([
    groundIn,
    firstIn,
    secondIn,
    cameraHeight,
    cameraNear,
    shadowTopHeight,
    maxShadowLengthRayDistance
  ]: [
    Node<'bool'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const ground = declared(groundIn)
    const first = declared(firstIn)
    const second = declared(secondIn)
    const nearFar = vec2(-1).toVar()

    If(cameraHeight.lessThan(shadowTopHeight), () => {
      If(ground, () => {
        nearFar.assign(vec2(cameraNear, first.x))
      }).Else(() => {
        nearFar.assign(vec2(cameraNear, second.w))
      })
    }).Else(() => {
      nearFar.assign(vec2(first.w, second.w))
      If(ground, () => {
        nearFar.y.assign(first.x)
      })
    })

    nearFar.y.assign(nearFar.y.min(maxShadowLengthRayDistance))
    return nearFar
  }
)

// clouds.frag:793–810
export const getHazeRayNearFar = /*#__PURE__*/ Fn(
  ([groundIn, firstIn, secondIn, cameraHeight, cameraNear, maxHeight]: [
    Node<'bool'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const ground = declared(groundIn)
    const first = declared(firstIn)
    const second = declared(secondIn)
    const nearFar = vec2(-1).toVar()

    If(cameraHeight.lessThan(maxHeight), () => {
      If(ground, () => {
        nearFar.assign(vec2(cameraNear, first.x))
      }).Else(() => {
        nearFar.assign(vec2(cameraNear, second.z))
      })
    }).Else(() => {
      nearFar.assign(vec2(cameraNear, second.z))
      If(ground, () => {
        nearFar.y.assign(first.x)
      })
    })

    return nearFar
  }
)
