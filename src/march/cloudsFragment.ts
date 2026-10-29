// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: clouds.frag:823–1003 (main)

import {
  add,
  dot,
  float,
  floor,
  Fn,
  If,
  int,
  min,
  mix,
  mod,
  normalize,
  pow,
  select,
  struct,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { Node, NodeBuilder, StructNode, TextureNode } from 'three/webgpu'

import { turbo } from '@takram/three-geospatial/webgpu'

import type { DebugView } from '../CloudsContext'
import { getGlobeUv, getMipLevel } from '../density/globeUv'
import { previousCloudPosition } from '../experimental/WindHistory'
import { atmosphereWorldToUnit } from '../lighting/sunSkyLight'
import { shadowLengthToAttachment } from './aerialPerspective'
import { blendHaze } from './hazeMarch'
import {
  getHazeRayNearFar,
  getIntersections,
  getRayNearFar,
  getShadowRayNearFar
} from './intersections'
import {
  enableSubgroups,
  quadLane,
  sumQuadShadowLength
} from './shadowLengthMarch'

export interface CloudsFragmentDeps {
  windDisplacement?: Node<'vec3'>
  inverseProjectionMatrix: Node<'mat4'>
  inverseViewMatrix: Node<'mat4'>
  worldToECEFMatrix: Node<'mat4'>
  ecefToWorldMatrix: Node<'mat4'>
  reprojectionMatrix: Node<'mat4'>
  viewReprojectionMatrix: Node<'mat4'>
  cameraPositionECEF: Node<'vec3'>
  cameraDirectionECEF: Node<'vec3'>
  altitudeCorrection: Node<'vec3'>
  cameraNear: Node<'float'>
  cameraFar: Node<'float'>
  sunDirection: Node<'vec3'>
  bottomRadius: Node<'float'>
  worldToUnit: Node<'float'>
  cameraHeight: Node<'float'>
  maxRayDistance: Node<'float'>
  minHeight: Node<'float'>
  maxHeight: Node<'float'>
  shadowTopHeight: Node<'float'>
  localWeatherRepeat: Node<'vec2'>
  resolution: Node<'vec2'>
  mipLevelScale: Node<'float'>
  marchClouds: (
    rayOrigin: Node<'vec3'>,
    rayDirection: Node<'vec3'>,
    rayNearFar: Node<'vec2'>,
    cosTheta: Node<'float'>,
    stbn: Node<'float'>,
    rayStartTexelsPerPixel: Node<'float'>
  ) => StructNode
  // Applied in the composite, once the shadow length is final on both shafts
  // paths. clouds.frag:942 applies it right after the shadow-length march with
  // the same inputs. `shadowLength` is the marched length in metres
  applyAerialPerspective: (
    cameraPositionECEF: Node<'vec3'>,
    frontPositionECEF: Node<'vec3'>,
    shadowLength: Node<'float'>,
    color: Node<'vec4'>
  ) => Node<'vec4'>
  getRayDistanceToScene:
    | ((
        rayDirection: Node<'vec3'>,
        cameraDirection: Node<'vec3'>
      ) => StructNode)
    | null
  stbn: Node<'float'>
  // Phase 3: shadow length
  lightShafts: boolean
  marchShadowLength:
    | ((
        rayOrigin: Node<'vec3'>,
        rayDirection: Node<'vec3'>,
        rayNearFar: Node<'vec2'>,
        jitter: Node<'float'>
      ) => Node<'float'>)
    | null
  maxShadowLengthRayDistance: Node<'float'> | null
  // lightShaftsHalfResolution: one lane's quarter of the shadow-length march,
  // summed over the quad in the composite at top level, where the quad has
  // reconverged. Set only with lightShafts on a device with `subgroups`
  marchShadowLengthQuadPartial:
    | ((
        rayOrigin: Node<'vec3'>,
        rayDirection: Node<'vec3'>,
        rayNearFar: Node<'vec2'>,
        jitter: Node<'float'>,
        lane: Node<'int'>
      ) => Node<'float'>)
    | null
  // Phase 4: haze
  haze: boolean
  approximateHaze:
    | ((
        rayOrigin: Node<'vec3'>,
        rayDirection: Node<'vec3'>,
        maxRayDistance: Node<'float'>,
        cosTheta: Node<'float'>,
        shadowLength: Node<'float'>
      ) => Node<'vec4'>)
    | null
  // Opt-in storm shafts. Their own closed march over the band below the cloud
  // base, which the primary march never samples: absent emits nothing
  marchRainShafts?: (
    cameraPosition: Node<'vec3'>,
    rayDirection: Node<'vec3'>,
    sunShadowLength: Node<'float'>,
    sceneRayDistance: Node<'float'>
  ) => Node<'vec4'>
  // Opt-in cirrus deck, composited by depth against the march's colour
  // Absent emits nothing
  compositeCirrusDeck?: (
    cameraPosition: Node<'vec3'>,
    rayDirection: Node<'vec3'>,
    sceneRayDistance: Node<'float'>,
    shadowLength: Node<'float'>,
    color: Node<'vec4'>,
    hitClouds: Node<'float'>,
    frontDepth: Node<'float'>
  ) => Node<'vec4'>
  // Phase 4: debug views
  debug: DebugView
  localWeatherOffset: Node<'vec2'>
  // Live handle, not a raw Texture, see createShadowMapDebug
  shadowBuffer: TextureNode | null
  // Runtime count, not a build-time literal: the shadow-map view gates its
  // quadrants on it and cascadeCount is mutable
  shadowCascadeCount: Node<'int'>
}

// The graph-time shape of the light shafts, decided once per deps and read
// as plain booleans inside the Fn bodies (each `if` in a body is a decision
// point under ADR-010's budget; the compound tests are not)
function shaftsPaths(deps: CloudsFragmentDeps): {
  // The march exists at all (light shafts on, an atlas to sample)
  shafts: boolean
  // Marched per fragment inside the hit/miss branches
  perFragment: boolean
  // Marched once per quad in the composite (lightShaftsHalfResolution)
  quad: boolean
} {
  const shafts = deps.lightShafts && deps.marchShadowLength != null
  const quad = shafts && deps.marchShadowLengthQuadPartial != null
  return { shafts, perFragment: shafts && !quad, quad }
}

// Cite: core/math (checker), standard checkerboard
function checkerTSL(uvVal: Node<'vec2'>, scale: Node<'vec2'>) {
  return mod(add(floor(uvVal.x.mul(scale.x)), floor(uvVal.y.mul(scale.y))), 2)
}

// Branch-local state travels with the public outputs so each TSL Fn returns one
// node. Only layer, depthVelocity and shadowLength leave buildCloudsFragment().
export const cloudsFragmentStruct = /*#__PURE__*/ struct(
  {
    layer: 'vec4',
    depthVelocity: 'vec4',
    shadowLength: 'vec2',
    hitClouds: 'float',
    frontDepth: 'float',
    // The shadow ray's far bound as the branch left it (clamped at the cloud
    // front on a hit), for the composite's quad-shared march
    shadowRayFar: 'float'
  },
  'CloudsFragmentOutput'
)

const fragmentRayStruct = /*#__PURE__*/ struct(
  {
    cameraPosition: 'vec3',
    rayDirection: 'vec3',
    cosTheta: 'float',
    viewPosition: 'vec3',
    rayNearFar: 'vec2',
    shadowRayNearFar: 'vec2',
    hazeRayNearFar: 'vec2',
    sceneViewZ: 'float',
    // Camera→scene-surface distance along the ray in metres; 0 on sky pixels
    sceneRayDistance: 'float',
    shouldMarch: 'bool'
  },
  'CloudsFragmentRay'
)

// Cite: clouds.frag:252–295 (shadow atlas tiled display)

// The atlas is a live TextureNode: `descriptor.map` is reassigned every update,
// and a texture captured at build time froze the 1x1 placeholder. A sampled
// render target is a TextureNode whose .value follows the swap

// frontDepth is stored in unit space here, metres in the reference
// (shadow.frag:125), so the storage scale is undone before the reference's
// 1e-5 (clouds.frag:279-293). Red was ~1e-8 before

// The storage convention itself is right: sampleCloudShadowOpticalDepth.ts:86
// converts back on read

// quadrants past the cascade count stay black, as SHADOW_CASCADE_COUNT
// gates them (clouds.frag:259-271). The guard is at run time because
// cascadeCount is mutable

// Explicit .level(0): these reads sit in per-pixel If branches, which is
// non-uniform control flow, where an implicit-LOD sample is undefined in WGSL
// and Dawn returns zeros. The atlas has no mips
export const createShadowMapDebug = (
  shadowBuffer: TextureNode,
  worldToUnit: Node<'float'>,
  cascadeCount: Node<'int'>
) =>
  Fn(() => {
    // the quadrant tests are a faithful transcription of
    // clouds.frag:824-831 (empty tile bottom-right, as on side A). Do not flip
    // them to make the plates agree, that is how jg7u's compensating pair began

    // The reference's vUv runs bottom-up, WebGPU's uv() top-down. Converted at
    // the call site like clipXY (jg7u F2, 30d648f). Before, every quadrant sat
    // on its mirror row (SSIM 0.108, vflip 0.990)
    const refUv = vec2(uv().x, float(1).sub(uv().y))
    // A fresh node per tile, not a shared one: three r186 declares a shared
    // node inside the first tile that reads it, and the other tiles read zeros
    const coord = () => vec4(refUv, refUv.sub(0.5)).mul(2)
    const shadow = vec4(0).toVar()
    const read = (u: Node<'float'>, v: Node<'float'>, layer: number) =>
      shadowBuffer.sample(vec2(u, v)).level(float(0)).depth(int(layer))
    If(refUv.y.greaterThan(0.5), () => {
      If(refUv.x.lessThan(0.5), () => {
        const c = coord()
        shadow.assign(read(c.x, c.w, 0))
      }).Else(() => {
        If(int(1).lessThan(cascadeCount), () => {
          const c = coord()
          shadow.assign(read(c.z, c.w, 1))
        })
      })
    }).Else(() => {
      If(refUv.x.lessThan(0.5), () => {
        If(int(2).lessThan(cascadeCount), () => {
          const c = coord()
          shadow.assign(read(c.x, c.y, 2))
        })
      }).Else(() => {
        If(int(3).lessThan(cascadeCount), () => {
          const c = coord()
          shadow.assign(read(c.z, c.y, 3))
        })
      })
    })
    const debugColor = vec3(
      shadow.x.div(worldToUnit).mul(1e-5),
      shadow.y.mul(10),
      shadow.z.add(shadow.w).mul(0.01)
    )
    return cloudsFragmentStruct(
      vec4(debugColor, 1),
      vec4(0),
      vec2(0),
      float(0),
      float(0),
      float(-1)
    )
  })

function createFragmentRayState(deps: CloudsFragmentDeps) {
  const {
    inverseProjectionMatrix,
    inverseViewMatrix,
    worldToECEFMatrix,
    cameraPositionECEF,
    altitudeCorrection,
    sunDirection,
    bottomRadius,
    minHeight,
    maxHeight,
    shadowTopHeight,
    cameraHeight,
    cameraNear,
    maxRayDistance,
    cameraDirectionECEF,
    getRayDistanceToScene
  } = deps
  const hasHaze = deps.haze && deps.approximateHaze != null

  return Fn(() => {
    // Cite: clouds.frag:833–835 builds the ray from vUv * 2 - 1, with v
    // bottom-up. WebGPU's uv() runs top-down, so clip y is 1 - 2v here, else
    // the layer renders mirrored
    const clipXY = vec2(uv().x.mul(2).sub(1), float(1).sub(uv().y.mul(2)))
    const viewPosition = inverseProjectionMatrix.mul(vec4(clipXY, 1, 1)).xyz
    const worldDirection = inverseViewMatrix.mul(vec4(viewPosition, 0)).xyz
    const ecefDirection = worldToECEFMatrix.mul(vec4(worldDirection, 0)).xyz

    // TSL emits a var where its node is FIRST USED, and the altitude branches
    // inside getRayNearFar are that first use. A plain node hoisted there is
    // assigned in one branch alone, so every read after the If reads zeros
    const cameraPosition = cameraPositionECEF.add(altitudeCorrection).toVar()
    const rayDirection = normalize(ecefDirection).toVar()
    const cosTheta = dot(sunDirection, rayDirection)

    const ix = getIntersections(
      cameraPosition,
      rayDirection,
      bottomRadius,
      minHeight,
      maxHeight,
      shadowTopHeight
    )
    // TSL's struct .get() is not generic over the member table, so the three
    // members are read once here with the types intersectionsStruct declares
    const ixGround = (ix.get('ground') as Node<'bool'>).toVar()
    const ixFirst = (ix.get('first') as Node<'vec4'>).toVar()
    const ixSecond = (ix.get('second') as Node<'vec4'>).toVar()

    const rayNearFar = getRayNearFar(
      ixGround,
      ixFirst,
      ixSecond,
      cameraHeight,
      cameraNear,
      minHeight,
      maxHeight,
      maxRayDistance
    ).toVar()

    const sceneViewZ = float(0).toVar()
    const sceneRayDistanceOut = float(0).toVar()
    // Cite: clouds.frag:772–789, 846–847
    const shadowRayNearFar = vec2(-1).toVar()
    if (deps.lightShafts && deps.marchShadowLength != null) {
      shadowRayNearFar.assign(
        getShadowRayNearFar(
          ixGround,
          ixFirst,
          ixSecond,
          cameraHeight,
          cameraNear,
          shadowTopHeight,
          // Non-null exactly when deps.lightShafts is true, which this branch
          // already tests (CloudsPassNode sets both from ctx.lightShafts). TS
          // cannot correlate the two fields
          deps.maxShadowLengthRayDistance!
        )
      )
    }

    // Cite: clouds.frag:842–844, haze ray
    const hazeRayNearFar = vec2(-1).toVar()
    if (hasHaze) {
      hazeRayNearFar.assign(
        getHazeRayNearFar(
          ixGround,
          ixFirst,
          ixSecond,
          cameraHeight,
          cameraNear,
          maxHeight
        )
      )
    }

    // Cite: clouds.frag:846–847
    if (getRayDistanceToScene != null) {
      const sceneResult = getRayDistanceToScene(
        rayDirection,
        cameraDirectionECEF
      )
      // struct .get() is not generic over the member table (see above)
      const sceneRayDistance = sceneResult.get('rayDistance') as Node<'float'>
      const sceneZ = sceneResult.get('viewZ') as Node<'float'>
      If(sceneRayDistance.greaterThan(0), () => {
        rayNearFar.y.assign(min(rayNearFar.y, sceneRayDistance))
        sceneViewZ.assign(sceneZ)
        sceneRayDistanceOut.assign(sceneRayDistance)
        if (deps.lightShafts && deps.marchShadowLength != null) {
          shadowRayNearFar.y.assign(min(shadowRayNearFar.y, sceneRayDistance))
        }
        // Cite: clouds.frag:853-855. Terrain also occludes haze, integrating
        // past its surface paints the distant horizon over mountains
        if (hasHaze) {
          hazeRayNearFar.y.assign(min(hazeRayNearFar.y, sceneRayDistance))
        }
      })
    }

    const intersectsGround = rayNearFar.x
      .lessThan(0)
      .or(rayNearFar.y.lessThan(0))
    const intersectsScene = rayNearFar.y.lessThan(rayNearFar.x)
    const shouldMarch = intersectsGround.not().and(intersectsScene.not())

    return fragmentRayStruct(
      cameraPosition,
      rayDirection,
      cosTheta,
      viewPosition,
      rayNearFar,
      shadowRayNearFar,
      hazeRayNearFar,
      sceneViewZ,
      sceneRayDistanceOut,
      shouldMarch
    )
  })()
}

function createMarchHitBranch(deps: CloudsFragmentDeps) {
  const paths = shaftsPaths(deps)
  // This option changes the graph, not a per-pixel branch. The disabled
  // path retains the unmodified position and emits no advection arithmetic
  const displacement = deps.windDisplacement
  const getPreviousPosition =
    displacement != null
      ? (position: Node<'vec3'>) =>
          previousCloudPosition(position, displacement)
      : (position: Node<'vec3'>) => position
  const {
    cameraHeight,
    maxHeight,
    ecefToWorldMatrix,
    altitudeCorrection,
    reprojectionMatrix,
    marchClouds,
    stbn,
    localWeatherRepeat,
    worldToUnit
  } = deps

  return Fn(
    ([
      cameraPosition,
      rayDirection,
      cosTheta,
      rayNearFar,
      shadowNearFarInput,
      shouldMarch
    ]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'vec2'>,
      Node<'vec2'>,
      Node<'bool'>
    ]) => {
      const color = vec4(0).toVar()
      const depthVelocity = vec4(0).toVar()
      const hitCloudsFlag = float(0).toVar()
      const frontDepthMetres = float(0).toVar()
      const shadowLengthVal = float(0).toVar()
      const shadowRayNearFar = vec2(shadowNearFarInput).toVar()

      // Cite: clouds.frag:882–883. getMipLevel's derivatives must run in uniform
      // flow: inside the branch Metal returned garbage and skewed the march
      //. This Fn body is uniform

      // Hoisted above If(shouldMarch) for that reason
      const rayOrigin = rayDirection
        .mul(rayNearFar.x)
        .add(cameraPosition)
        .toVar()
      const globeUv = getGlobeUv(rayOrigin).toVar()
      const rawMip = getMipLevel(
        globeUv.mul(localWeatherRepeat),
        deps.resolution
      ).mul(deps.mipLevelScale)
      const heightFade = min(
        float(1),
        float(0.2).mul(cameraHeight).div(maxHeight)
      )
      const mipLevel = mix(float(0), rawMip, heightFade).toVar()
      const rayStartTexelsPerPixel = pow(float(2), mipLevel).toVar()

      // The quad composite reads the jitter at top level too, and getSTBN's
      // `let` lands where it is first built. Built here, before any branch, as
      // the reference does (clouds.frag:857), else "unresolved value 'stbn'"
      if (paths.quad) {
        stbn.toVar('stbnTopLevel')
      }

      If(shouldMarch, () => {
        // Cite: clouds.frag:873–880, DEBUG_SHOW_UV
        if (deps.debug === 'uv') {
          const checkerVal = checkerTSL(
            globeUv,
            add(localWeatherRepeat, deps.localWeatherOffset)
          )
          color.assign(vec4(vec3(checkerVal), 1))
          return
        }

        const marchResult = marchClouds(
          rayOrigin,
          rayDirection,
          rayNearFar,
          cosTheta,
          stbn,
          rayStartTexelsPerPixel
        )
        const marchLayer = marchResult.get('layer') as Node<'vec4'>
        const marchDV = marchResult.get('depthVelocity') as Node<'vec4'>

        // Cite: clouds.frag:898–905, DEBUG_SHOW_SAMPLE_COUNT
        if (deps.debug === 'sampleCount' || deps.debug === 'marchIntervals') {
          const sc = marchResult.get('sampleCount') as Node<'vec3'>
          color.assign(vec4(sc.div(vec3(500, 5, 5)), 1))
          return
        }

        const hitClouds = marchDV.x.greaterThanEqual(0)

        If(hitClouds, () => {
          hitCloudsFlag.assign(1)
          const marchFrontDepth = marchDV.x.div(worldToUnit)
          const absoluteFrontDepth = rayNearFar.x.add(marchFrontDepth)
          frontDepthMetres.assign(absoluteFrontDepth)
          const frontPosition = cameraPosition.add(
            rayDirection.mul(absoluteFrontDepth)
          )

          // Cite: clouds.frag:912–928, shadow length hit branch
          if (paths.shafts) {
            shadowRayNearFar.y.assign(
              mix(
                shadowRayNearFar.y,
                min(absoluteFrontDepth, shadowRayNearFar.y),
                marchLayer.w
              )
            )
            // The quad path marches in the composite instead (top level)
            if (paths.perFragment) {
              const shadowBothValid = shadowRayNearFar.x
                .greaterThanEqual(0)
                .and(shadowRayNearFar.y.greaterThanEqual(0))
              // Non-null by shaftsPaths' perFragment (which TS cannot
              // correlate), hoisted so the If() callback sees a const
              const marchShadowLength = deps.marchShadowLength!
              If(shadowBothValid, () => {
                shadowLengthVal.assign(
                  marchShadowLength(
                    shadowRayNearFar.x.mul(rayDirection).add(cameraPosition),
                    rayDirection,
                    shadowRayNearFar,
                    stbn
                  )
                )
              })
            }
          }

          // The aerial perspective (clouds.frag:942) is applied in the
          // composite: it takes the shadow length, which the quad-shared
          // shafts path only knows there
          color.assign(marchLayer)

          // Cite: clouds.frag:945–950
          const previousPosition = getPreviousPosition(frontPosition)
          const uncorrected = previousPosition.sub(altitudeCorrection)
          const frontPositionWorld = ecefToWorldMatrix.mul(
            vec4(uncorrected, 1)
          ).xyz
          const prevClipHit = reprojectionMatrix
            .mul(vec4(frontPositionWorld, 1))
            .toVar()
          prevClipHit.assign(prevClipHit.div(prevClipHit.w))
          // NDC -> uv in the pass's own (top-down) v sense, the same convention
          // as clipXY above. The GL form put every history fetch on the mirror
          // row (ADR-013 Amendment 5)
          const prevUvHit = vec2(
            prevClipHit.x.mul(0.5).add(0.5),
            float(0.5).sub(prevClipHit.y.mul(0.5))
          )
          const velocityHit = uv().sub(prevUvHit)
          depthVelocity.assign(
            vec4(
              absoluteFrontDepth.mul(worldToUnit),
              velocityHit.x,
              velocityHit.y,
              0
            )
          )
        }).Else(() => {
          color.assign(marchLayer)
          depthVelocity.assign(marchDV)
        })
      })

      return cloudsFragmentStruct(
        color,
        depthVelocity,
        vec2(shadowLengthVal, shadowRayNearFar.x),
        hitCloudsFlag,
        frontDepthMetres,
        shadowRayNearFar.y
      )
    }
  )
}

function createMissBranch(deps: CloudsFragmentDeps) {
  const { cameraFar, viewReprojectionMatrix, stbn, worldToUnit } = deps
  const paths = shaftsPaths(deps)

  return Fn(
    ([
      cameraPosition,
      rayDirection,
      viewPosition,
      sceneViewZ,
      baseLayer,
      shadowNearFarInput,
      hitClouds
    ]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'vec4'>,
      Node<'vec2'>,
      Node<'float'>
    ]) => {
      const color = vec4(baseLayer).toVar()
      const depthVelocity = vec4(0).toVar()
      const shadowLengthVal = float(0).toVar()
      const shadowRayNearFar = vec2(shadowNearFarInput).toVar()

      // Cite: clouds.frag:954–963
      If(hitClouds.equal(0), () => {
        // Shadow length miss branch: march over the full shadow ray. The
        // quad path marches in the composite instead (top level)
        if (paths.perFragment) {
          const shadowBothValid = shadowRayNearFar.x
            .greaterThanEqual(0)
            .and(shadowRayNearFar.y.greaterThanEqual(0))
          // Non-null by shaftsPaths' perFragment (which TS cannot
          // correlate), hoisted so the If() callback sees a const
          const marchShadowLength = deps.marchShadowLength!
          If(shadowBothValid, () => {
            shadowLengthVal.assign(
              marchShadowLength(
                shadowRayNearFar.x.mul(rayDirection).add(cameraPosition),
                rayDirection,
                shadowRayNearFar,
                stbn
              )
            )
          })
        }

        const frontDepth = select(
          sceneViewZ.lessThan(0),
          sceneViewZ.negate(),
          cameraFar
        ).toVar()
        const frontView = viewPosition.mul(frontDepth)
        const prevClipMiss = viewReprojectionMatrix
          .mul(vec4(frontView, 1))
          .toVar()
        prevClipMiss.assign(prevClipMiss.div(prevClipMiss.w))
        const prevUvMiss = vec2(
          prevClipMiss.x.mul(0.5).add(0.5),
          float(0.5).sub(prevClipMiss.y.mul(0.5))
        )
        const velocityMiss = uv().sub(prevUvMiss)
        depthVelocity.assign(
          vec4(frontDepth.mul(worldToUnit), velocityMiss.x, velocityMiss.y, 0)
        )
      })

      return cloudsFragmentStruct(
        color,
        depthVelocity,
        vec2(shadowLengthVal, shadowRayNearFar.x),
        float(0),
        float(0),
        shadowRayNearFar.y
      )
    }
  )
}

// lightShaftsHalfResolution: the shadow-length march once, at top level. Each
// lane marches a quarter of its own ray (an invalid segment marches nothing)
// and the quad sum is the 2x2 mean. Returns the shadow length in metres

// Takes the shadow ray's near and the far the branch left (clamped at the
// cloud front on a hit)
function createQuadSharedShafts(deps: CloudsFragmentDeps) {
  const marchPartial = deps.marchShadowLengthQuadPartial
  if (!shaftsPaths(deps).quad || marchPartial == null) return null
  return Fn(
    ([cameraPosition, rayDirection, shadowRayNear, shadowRayFarInput, stbn]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const shadowRayFar = float(shadowRayFarInput).toVar()
      const valid = shadowRayNear
        .greaterThanEqual(0)
        .and(shadowRayFar.greaterThanEqual(0))
        .toVar()
      const segment = select(
        valid,
        vec2(shadowRayNear, shadowRayFar),
        vec2(0, -1)
      )
      const partial = marchPartial(
        shadowRayNear.mul(rayDirection).add(cameraPosition),
        rayDirection,
        segment,
        stbn,
        quadLane()
      ).toVar()
      return sumQuadShadowLength(partial, valid, segment)
    }
  )
}

// A plain function rather than a branch in the composite body, which sits at
// the decision-point limit. Absent, it emits nothing, not a self-assignment
function compositeCirrusDeckInto(
  deps: CloudsFragmentDeps,
  color: Node<'vec4'>,
  ray: {
    cameraPosition: Node<'vec3'>
    rayDirection: Node<'vec3'>
    sceneRayDistance: Node<'float'>
    shadowLength: Node<'float'>
    hitClouds: Node<'float'>
    frontDepth: Node<'float'>
  }
): void {
  if (deps.compositeCirrusDeck == null) return
  color.assign(
    deps.compositeCirrusDeck(
      ray.cameraPosition,
      ray.rayDirection,
      ray.sceneRayDistance,
      ray.shadowLength,
      color,
      ray.hitClouds,
      ray.frontDepth
    )
  )
}

function createFragmentComposite(deps: CloudsFragmentDeps) {
  const { cameraNear, maxRayDistance, stbn, applyAerialPerspective } = deps
  const quadShafts = createQuadSharedShafts(deps)

  return Fn(
    (
      [
        cameraPosition,
        rayDirection,
        cosTheta,
        hazeNearFarInput,
        marchLayer,
        marchDepthVelocity,
        marchShadowLength,
        hitClouds,
        marchFrontDepth,
        missLayer,
        missDepthVelocity,
        missShadowLength,
        marchShadowRayFar,
        missShadowRayFar,
        sceneRayDistance
      ]: [
        Node<'vec3'>,
        Node<'vec3'>,
        Node<'float'>,
        Node<'vec2'>,
        Node<'vec4'>,
        Node<'vec4'>,
        Node<'vec2'>,
        Node<'float'>,
        Node<'float'>,
        Node<'vec4'>,
        Node<'vec4'>,
        Node<'vec2'>,
        Node<'float'>,
        Node<'float'>,
        Node<'float'>
      ],
      builder: NodeBuilder
    ) => {
      const color = vec4(missLayer).toVar()
      const depthVelocity = vec4(missDepthVelocity).toVar()
      const shadowLength = vec2(missShadowLength).toVar()
      // The miss branch already encoded the reference's scene/far front depth
      // in unit space for reprojection. Recover metres before the front-depth
      // debug view; zero made every no-cloud pixel turbo(0)
      const frontDepthMetres = missDepthVelocity.x.div(deps.worldToUnit).toVar()
      const hazeRayNearFar = vec2(hazeNearFarInput).toVar()

      If(hitClouds.greaterThan(0), () => {
        color.assign(marchLayer)
        depthVelocity.assign(marchDepthVelocity)
        shadowLength.assign(marchShadowLength)
        frontDepthMetres.assign(marchFrontDepth)

        // Cite: clouds.frag:931–938, haze clamp at cloud front
        if (deps.haze && deps.approximateHaze != null) {
          hazeRayNearFar.y.assign(
            mix(
              hazeRayNearFar.y,
              min(marchFrontDepth, hazeRayNearFar.y),
              marchLayer.w
            )
          )
        }
      })

      // The quad-shared shafts march (see createQuadSharedShafts), ahead of the
      // haze that consumes .x, in the reference's order (clouds.frag:986–996)
      if (quadShafts != null) {
        enableSubgroups(builder)
        shadowLength.x.assign(
          quadShafts(
            cameraPosition,
            rayDirection,
            shadowLength.y,
            select(
              hitClouds.greaterThan(0),
              marchShadowRayFar,
              missShadowRayFar
            ),
            stbn
          )
        )
      }

      // Cite: clouds.frag:940–942, aerial perspective on the cloud front after
      // the shafts march. Here rather than in the hit branch so both shafts
      // paths feed it alike
      If(hitClouds.greaterThan(0), () => {
        const frontPosition = cameraPosition.add(
          rayDirection.mul(frontDepthMetres)
        )
        color.assign(
          applyAerialPerspective(
            cameraPosition,
            frontPosition,
            shadowLength.x,
            color
          )
        )
      })

      // Cite: clouds.frag:977–984, DEBUG_SHOW_FRONT_DEPTH
      if (deps.debug === 'frontDepth') {
        const debugColor = vec4(turbo(frontDepthMetres.div(maxRayDistance)), 1)
        return cloudsFragmentStruct(
          debugColor,
          vec4(0),
          vec2(0),
          hitClouds,
          frontDepthMetres,
          float(-1)
        )
      }

      // The deck lies beyond the cloud front from below, so it goes in after
      // the clouds' aerial perspective and before the shafts in front of both
      compositeCirrusDeckInto(deps, color, {
        cameraPosition,
        rayDirection,
        sceneRayDistance,
        shadowLength: shadowLength.x,
        hitClouds,
        frontDepth: frontDepthMetres
      })

      // The shafts sit in front of everything above, so they composite here:
      // after the aerial perspective, which is measured to the cloud front and
      // would over-haze them, and before the haze, which is along the whole ray
      if (deps.marchRainShafts != null) {
        const shaft = deps
          .marchRainShafts(
            cameraPosition,
            rayDirection,
            shadowLength.x,
            sceneRayDistance
          )
          .toVar()
        // Alpha is the transmittance the composite hands the scene, so the
        // shafts must attenuate it too or the sky behind a curtain would not
        // dim at all
        color.assign(
          vec4(color.xyz.mul(shaft.w).add(shaft.xyz), color.a.mul(shaft.w))
        )
      }

      // Cite: clouds.frag:986–996, haze blend
      if (deps.haze && deps.approximateHaze != null) {
        const hazeOrigin = cameraNear.mul(rayDirection).add(cameraPosition)
        const hazeMaxDist = hazeRayNearFar.y.sub(hazeRayNearFar.x)
        const haze = deps.approximateHaze(
          hazeOrigin,
          rayDirection,
          hazeMaxDist,
          cosTheta,
          shadowLength.x
        )
        color.assign(blendHaze(color, haze))
      }

      // Cite: clouds.frag:1001. The aerial node reads the shafts output in the
      // atmosphere's length unit, not the march's 1 / bottomRadius scale

      // Its .y becomes the shadow's start from the camera, as the reference
      // places it. Up to here .y carries the march's near bound
      const shadowLengthOutput = deps.lightShafts
        ? shadowLengthToAttachment(shadowLength.x, sceneRayDistance).mul(
            atmosphereWorldToUnit()
          )
        : vec2(0)

      return cloudsFragmentStruct(
        color,
        depthVelocity,
        shadowLengthOutput,
        hitClouds,
        frontDepthMetres,
        float(-1)
      )
    }
  )
}

export interface CloudsFragmentOutputs {
  layer: Node<'vec4'>
  depthVelocity: Node<'vec4'>
  shadowLength?: Node<'vec2'>
}

export function buildCloudsFragment(
  deps: CloudsFragmentDeps
): CloudsFragmentOutputs {
  let result: StructNode

  // Cite: clouds.frag:824–831, DEBUG_SHOW_SHADOW_MAP
  if (deps.debug === 'shadowMap' && deps.shadowBuffer != null) {
    result = createShadowMapDebug(
      deps.shadowBuffer,
      deps.worldToUnit,
      deps.shadowCascadeCount
    )()
  } else {
    const ray = createFragmentRayState(deps)
    const marchBranch = createMarchHitBranch(deps)
    // struct .get() is not generic over the member table (see above)
    const rayCameraPosition = ray.get('cameraPosition') as Node<'vec3'>
    const rayDirection = ray.get('rayDirection') as Node<'vec3'>
    const rayCosTheta = ray.get('cosTheta') as Node<'float'>
    const rayNearFar = ray.get('rayNearFar') as Node<'vec2'>
    const rayShadowNearFar = ray.get('shadowRayNearFar') as Node<'vec2'>
    const rayShouldMarch = ray.get('shouldMarch') as Node<'bool'>

    const march = marchBranch(
      rayCameraPosition,
      rayDirection,
      rayCosTheta,
      rayNearFar,
      rayShadowNearFar,
      rayShouldMarch
    )
    const rayViewPosition = ray.get('viewPosition') as Node<'vec3'>
    const raySceneViewZ = ray.get('sceneViewZ') as Node<'float'>
    const rayHazeNearFar = ray.get('hazeRayNearFar') as Node<'vec2'>
    const marchLayer = march.get('layer') as Node<'vec4'>
    const marchDepthVelocity = march.get('depthVelocity') as Node<'vec4'>
    const marchShadowLengthOut = march.get('shadowLength') as Node<'vec2'>
    const marchHitClouds = march.get('hitClouds') as Node<'float'>
    const marchFrontDepth = march.get('frontDepth') as Node<'float'>

    const missBranch = createMissBranch(deps)
    const miss = missBranch(
      rayCameraPosition,
      rayDirection,
      rayViewPosition,
      raySceneViewZ,
      marchLayer,
      rayShadowNearFar,
      marchHitClouds
    )
    const composite = createFragmentComposite(deps)
    result = composite(
      rayCameraPosition,
      rayDirection,
      rayCosTheta,
      rayHazeNearFar,
      marchLayer,
      marchDepthVelocity,
      marchShadowLengthOut,
      marchHitClouds,
      marchFrontDepth,
      miss.get('layer') as Node<'vec4'>,
      miss.get('depthVelocity') as Node<'vec4'>,
      miss.get('shadowLength') as Node<'vec2'>,
      march.get('shadowRayFar') as Node<'float'>,
      miss.get('shadowRayFar') as Node<'float'>,
      ray.get('sceneRayDistance') as Node<'float'>
    )
  }

  const outputs: CloudsFragmentOutputs = {
    layer: result.get('layer') as Node<'vec4'>,
    depthVelocity: result.get('depthVelocity') as Node<'vec4'>
  }
  if (deps.lightShafts) {
    outputs.shadowLength = result.get('shadowLength') as Node<'vec2'>
  }
  return outputs
}
