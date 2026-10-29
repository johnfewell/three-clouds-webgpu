// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:622–650 (marchShadowLength)

import {
  abs,
  Break,
  dot,
  float,
  Fn,
  If,
  int,
  Loop,
  max,
  screenCoordinate,
  screenSize,
  select,
  step,
  vec4,
  wgslFn
} from 'three/tsl'
import type { Node, NodeBuilder } from 'three/webgpu'

export interface ShadowLengthMarchDeps {
  // Structural, not ReturnType<typeof createSampleShadowOpticalDepth>: the
  // inferred FnNode pins internal VarNode nesting that no alternative
  // implementation or test double can satisfy
  sampleShadowOpticalDepth: (
    position: Node<'vec3'>,
    sunRayDistance: Node<'float'>,
    filterRadius: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'float'>
  perspectiveStepScale: Node<'float'>
  minShadowLengthStepSize: Node<'float'>
  maxShadowLengthIterationCount: number
}

// Cite: clouds.frag:622–648
export function createMarchShadowLength(deps: ShadowLengthMarchDeps) {
  return /*#__PURE__*/ Fn(
    ([rayOrigin, rayDirection, rayNearFar, jitter]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'vec2'>,
      Node<'float'>
    ]) => {
      const shadowLength = float(0).toVar()
      const maxRayDistance = rayNearFar.y.sub(rayNearFar.x)
      // TODO(port): This march is closed, and sample resolution can be much lower. Refining the termination by binary search will make it much more efficient. (clouds.frag:622–650)
      // lightShaftsHalfResolution splits this exact sequence across a 2x2 quad
      // (createMarchShadowLengthQuadPartial), a quarter of the cost per fragment
      const stepSize = float(deps.minShadowLengthStepSize).toVar()
      const rayDistance = stepSize.mul(jitter).toVar()
      // The source declares attenuation = 1.0 and attenuationFactor =
      // 1.0 - 5e-4 but never updates them, so attenuation stays 1 (ported
      // faithfully)

      Loop(
        {
          start: int(0),
          end: int(deps.maxShadowLengthIterationCount),
          type: 'int',
          condition: '<'
        },
        () => {
          // Termination (clouds.frag:640-642) must be If + Break: TSL discards a
          // condition returned from a Loop body, and the march ran ~718 km
          If(rayDistance.greaterThan(maxRayDistance), () => {
            Break()
          })

          const position = rayDirection.mul(rayDistance).add(rayOrigin)
          const od = deps.sampleShadowOpticalDepth(
            position,
            float(0),
            float(0),
            jitter
          )
          shadowLength.addAssign(float(1).sub(od.negate().exp()).mul(stepSize))
          stepSize.mulAssign(deps.perspectiveStepScale)
          rayDistance.addAssign(stepSize)
        }
      )

      return shadowLength
    }
  )
}

// One lane's quarter of the same march (lightShaftsHalfResolution), acting on
// the reference's "sample resolution can be much lower". Lane k of a 2x2 quad
// takes samples k, k+4, k+8, ... and the quad sum is a 2x2 box filter

// Same positions and steps as the full march, so one ray's partials sum to it
// exactly. Lane k starts at r_k = s0 * (jitter + g + ... + g^k), step s0 * g^k,
// then r += s * (g + g^2 + g^3 + g^4), s *= g^4

// No quad operation here: the per-lane break diverges, so the collective sum
// runs where the quad has reconverged
export function createMarchShadowLengthQuadPartial(
  deps: ShadowLengthMarchDeps
) {
  return /*#__PURE__*/ Fn(
    ([rayOrigin, rayDirection, rayNearFar, jitter, lane]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'vec2'>,
      Node<'float'>,
      Node<'int'>
    ]) => {
      const shadowLength = float(0).toVar()
      const maxRayDistance = rayNearFar.y.sub(rayNearFar.x)
      const g = float(deps.perspectiveStepScale).toVar()
      const stepSize = float(deps.minShadowLengthStepSize).toVar()
      // Unrolled prefix: after j < lane iterations, scale = g^lane and
      // offset = g + ... + g^lane. A division by (g - 1) would be the closed
      // form, and g may be exactly 1
      const offset = float(0).toVar()
      const scale = float(1).toVar()
      for (let j = 0; j < 3; j++) {
        If(int(j).lessThan(lane), () => {
          scale.mulAssign(g)
          offset.addAssign(scale)
        })
      }
      const rayDistance = stepSize.mul(jitter.add(offset)).toVar()
      stepSize.mulAssign(scale)
      const g2 = g.mul(g).toVar()
      const g4 = g2.mul(g2).toVar()
      const advance = g.mul(float(1).add(g).add(g2).add(g2.mul(g))).toVar()

      // Lane k owns samples k, k+4, ... below the full march's iteration cap:
      // ceil((N - k) / 4) of them
      const laneIterations = int(deps.maxShadowLengthIterationCount + 3)
        .sub(lane)
        .div(4)
        .toVar()

      Loop(
        { start: int(0), end: laneIterations, type: 'int', condition: '<' },
        () => {
          If(rayDistance.greaterThan(maxRayDistance), () => {
            Break()
          })

          const position = rayDirection.mul(rayDistance).add(rayOrigin)
          const od = deps.sampleShadowOpticalDepth(
            position,
            float(0),
            float(0),
            jitter
          )
          shadowLength.addAssign(float(1).sub(od.negate().exp()).mul(stepSize))
          rayDistance.addAssign(stepSize.mul(advance))
          stepSize.mulAssign(g4)
        }
      )

      return shadowLength
    }
  )
}

// the quad half of lightShaftsHalfResolution

// The `subgroups` directive, which three enables only for compute stages,
// though fragment quad operations need it too. The builder's methods are WGSL-specific,
// hence structural checks rather than a type

// three 0.185 drops fragment directives (WGSLNodeBuilder._getWGSLFragmentCode),
// so they go back on this builder instance's template, ahead of every
// declaration, before the `// global` diagnostics
interface WGSLDirectiveBuilder {
  enableDirective?: (name: string) => void
  _getWGSLFragmentCode?: FragmentCodeTemplate
}
type FragmentCodeTemplate = ((shaderData: {
  directives?: string
}) => string) & {
  emitsDirectives?: boolean
}

export function enableSubgroups(builder: NodeBuilder): void {
  const b = builder as unknown as WGSLDirectiveBuilder
  b.enableDirective?.('subgroups')
  const template = b._getWGSLFragmentCode
  if (typeof template !== 'function' || template.emitsDirectives === true)
    return
  const withDirectives: FragmentCodeTemplate = function (
    this: unknown,
    shaderData
  ) {
    const code = template.call(this, shaderData)
    const directives = shaderData.directives ?? ''
    if (directives.length === 0 || code.includes(directives)) return code
    const marker = '// global\n'
    const at = code.includes(marker)
      ? code.indexOf(marker)
      : code.indexOf('\n') + 1
    return `${code.slice(0, at)}// directives\n${directives}\n${code.slice(at)}`
  }
  withDirectives.emitsDirectives = true
  b._getWGSLFragmentCode = withDirectives
}

// The quad's four values of `x` as a vec4, by quad invocation ID (0 upper-left,
// 1 upper-right, 2 lower-left, 3 lower-right, WGSL §15.4). Native because
// three 0.185's quadBroadcast() proxy truncates the id off the call
const quadBroadcast4 = /*#__PURE__*/ wgslFn(`
  fn quadBroadcast4( x: f32 ) -> vec4<f32> {
    return vec4<f32>(
      quadBroadcast( x, 0 ),
      quadBroadcast( x, 1 ),
      quadBroadcast( x, 2 ),
      quadBroadcast( x, 3 )
    );
  }
`)

// Quad invocation ID of this fragment: quads are the 2x2 grids of fragments
// aligned to even pixel coordinates, in the target's own (top-down) rows
export function quadLane(): Node<'int'> {
  const px = int(screenCoordinate.x)
  const py = int(screenCoordinate.y)
  return px.bitAnd(1).add(py.bitAnd(1).mul(2))
}

// 1 for each lane whose pixel lies inside the target. Odd-sized targets pad
// quads with helper invocations, whose quad participation is implementation
// defined (WGSL §15.4), so what they broadcast is never read
const quadOnTargetMask = /*#__PURE__*/ Fn(() => {
  const px = int(screenCoordinate.x)
  const py = int(screenCoordinate.y)
  const right = px.sub(px.bitAnd(1)).add(1).lessThan(int(screenSize.x))
  const bottom = py.sub(py.bitAnd(1)).add(1).lessThan(int(screenSize.y))
  const one = float(1)
  const zero = float(0)
  return vec4(
    one,
    select(right, one, zero),
    select(bottom, one, zero),
    select(right.and(bottom), one, zero)
  )
})

// The quad's shadow length: the partials of lanes with a segment like this
// lane's (near and far within a tenth of its length), rescaled by how many
// took part. A lane without a segment stays 0

// At the horizon or a cloud silhouette each side averages its own, and a lone
// lane keeps 4x its quarter. Without this, ground lanes drew a dark dashed
// line under the horizon (Basic, 2880x1800)

// Collective: call only in uniform flow, at the fragment's top level. Tint
// enforces it (subgroup_uniformity)
export const sumQuadShadowLength = /*#__PURE__*/ Fn(
  ([partial, valid, rayNearFar]: [
    Node<'float'>,
    Node<'bool'>,
    Node<'vec2'>
  ]) => {
    const mask = quadOnTargetMask().toVar()
    const lit = select(valid, float(1), float(0)).toVar()
    const near = rayNearFar.x.toVar()
    const far = rayNearFar.y.toVar()
    // Unconditional, then selected: TSL lowers a select() on an expression to
    // an if/else, and the collective calls must not end up under a
    // per-fragment branch (a subgroup uniformity error)
    const partials = quadBroadcast4(partial) as Node<'vec4'>
    const lits = quadBroadcast4(lit) as Node<'vec4'>
    const nears = quadBroadcast4(near) as Node<'vec4'>
    const fars = quadBroadcast4(far) as Node<'vec4'>
    const tolerance = far.sub(near).mul(0.1)
    // step(edge, x) is 1 where x >= edge: 1 for a lane within tolerance, and
    // always 1 for this lane itself (both differences are 0)
    const like = step(abs(nears.sub(near)), vec4(tolerance)).mul(
      step(abs(fars.sub(far)), vec4(tolerance))
    )
    const weights = mask.mul(lits).mul(like).toVar()
    const sum = dot(partials, weights).toVar()
    const count = dot(weights, vec4(1)).toVar()
    const shadowLength = sum
      .mul(4)
      .div(max(count, float(1)))
      .toVar()
    return select(valid, shadowLength, float(0))
  }
)

// Cite: clouds.frag:912–918
export function clampShadowAtCloudFront(
  shadowNearFarY: number,
  frontDepth: number,
  alpha: number
): number {
  const clampedFar = Math.min(frontDepth, shadowNearFarY)
  return shadowNearFarY + (clampedFar - shadowNearFarY) * alpha
}

// CPU twin for testing

export function marchShadowLengthCPU(
  sampleOD: (position: [number, number, number]) => number,
  rayOrigin: [number, number, number],
  rayDirection: [number, number, number],
  rayNear: number,
  rayFar: number,
  jitter: number,
  minStepSize: number,
  maxIterationCount: number,
  perspectiveStepScale: number
): number {
  let shadowLength = 0
  const maxRayDistance = rayFar - rayNear
  let stepSize = minStepSize
  let rayDistance = stepSize * jitter

  for (let i = 0; i < maxIterationCount; i++) {
    if (rayDistance > maxRayDistance) break
    const position: [number, number, number] = [
      rayDirection[0] * rayDistance + rayOrigin[0],
      rayDirection[1] * rayDistance + rayOrigin[1],
      rayDirection[2] * rayDistance + rayOrigin[2]
    ]
    const od = sampleOD(position)
    shadowLength += (1 - Math.exp(-od)) * stepSize
    stepSize *= perspectiveStepScale
    rayDistance += stepSize
  }

  return shadowLength
}

// CPU twin of createMarchShadowLengthQuadPartial: lane's every-fourth subset
// of marchShadowLengthCPU's sample sequence
export function marchShadowLengthQuadPartialCPU(
  sampleOD: (position: [number, number, number]) => number,
  rayOrigin: [number, number, number],
  rayDirection: [number, number, number],
  rayNear: number,
  rayFar: number,
  jitter: number,
  minStepSize: number,
  maxIterationCount: number,
  perspectiveStepScale: number,
  lane: number
): number {
  let shadowLength = 0
  const maxRayDistance = rayFar - rayNear
  const g = perspectiveStepScale
  let stepSize = minStepSize
  let offset = 0
  let scale = 1
  for (let j = 0; j < 3; j++) {
    if (j < lane) {
      scale *= g
      offset += scale
    }
  }
  let rayDistance = stepSize * (jitter + offset)
  stepSize *= scale
  const g2 = g * g
  const g4 = g2 * g2
  const advance = g * (1 + g + g2 + g2 * g)

  const laneIterations = Math.floor((maxIterationCount + 3 - lane) / 4)
  for (let i = 0; i < laneIterations; i++) {
    if (rayDistance > maxRayDistance) break
    const position: [number, number, number] = [
      rayDirection[0] * rayDistance + rayOrigin[0],
      rayDirection[1] * rayDistance + rayOrigin[1],
      rayDirection[2] * rayDistance + rayOrigin[2]
    ]
    const od = sampleOD(position)
    shadowLength += (1 - Math.exp(-od)) * stepSize
    rayDistance += stepSize * advance
    stepSize *= g4
  }

  return shadowLength
}

export function getShadowRayNearFarCPU(
  cameraHeight: number,
  shadowTopHeight: number,
  cameraNear: number,
  ground: boolean,
  firstX: number,
  firstW: number,
  secondW: number,
  maxShadowLengthRayDistance: number
): [number, number] {
  let near: number
  let far: number

  if (cameraHeight < shadowTopHeight) {
    if (ground) {
      near = cameraNear
      far = firstX
    } else {
      near = cameraNear
      far = secondW
    }
  } else {
    near = firstW
    far = secondW
    if (ground) {
      far = firstX
    }
  }

  far = Math.min(far, maxShadowLengthRayDistance)
  return [near, far]
}
