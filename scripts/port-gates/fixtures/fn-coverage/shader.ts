// Fixture for fn-coverage.mjs. NOT a ported file: it carries no
// attribution header, and citations.mjs does not read scripts/port-gates/fixtures
//
// One Fn per twin convention, plus two canaries. The paired spec is
// ../fnCoverage.test.ts, which pins the verdict each convention must produce

import { clamp, float, Fn, max, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

// convention 1 + 2: an exact twin pair, `<name>CPU`
export const alpha = /*#__PURE__*/ Fn(([x]: [Node<'float'>, Node<'float'>]) =>
  clamp(x, float(0), float(1))
)
export function alphaCPU(x: number): number {
  return Math.min(1, Math.max(0, x))
}
// a twin behind a trailing `Function` decoration: cpuBeta twins betaFunction
export const betaFunction = /*#__PURE__*/ Fn(([x]: [Node<'float'>]) =>
  float(1).sub(x)
)
export function cpuBeta(x: number): number {
  return 1 - x
}
// a twin behind a leading `apply` decoration, matched case-insensitively
export const applyGamma = /*#__PURE__*/ Fn(
  ([x, y]: [Node<'float'>, Node<'float'>, Node<'float'>]) => x.mul(y)
)
export function cpuGamma(x: number, y: number): number {
  return x * y
}
// a TSL-suffixed Fn whose twin is the sibling plain-JS export of the same name
export const deltaTSL = /*#__PURE__*/ Fn(
  ([x]: [Node<'float'>, Node<'float'>]) => max(x, float(0))
)
export function delta(x: number): number {
  return Math.max(x, 0)
}
// THE CANARY. No twin, and the paired spec never compiles it. An earlier version
// of the bucket function used the module-scope snapshot count and reported it as
// snap-only, because a sibling test in the same file compiled something else
export const orphanFn = /*#__PURE__*/ Fn(([x]: [Node<'vec3'>, Node<'vec3'>]) =>
  vec3(x)
)
// a module-private twin, reachable only through the exported caller below. It
// must read as NOT exported, and its snapshot evidence must come through the
// closure
const epsilonInner = /*#__PURE__*/ Fn(([x]: [Node<'float'>, Node<'float'>]) =>
  x.mul(float(2))
)
export const epsilonOuter = /*#__PURE__*/ Fn(
  ([x]: [Node<'float'>, Node<'float'>]) => epsilonInner(x, float(1))
)
