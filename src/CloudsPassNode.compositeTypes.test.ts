// The signature every consumer copies: a takram aerial node goes into
// composite() with NO cast. Compiled by `pnpm typecheck`, so narrowing the
// parameter back reds this file rather than three consumer examples
// Type-level only: no renderer, no GPU, no node graph is built
import type { Node } from 'three/webgpu'
import { it } from 'vitest'

import type { CloudsPassNode } from './CloudsPassNode'
import type { aerialPerspectiveWithCloudShadow } from './shadow/aerialShadowAdapter'

type Aerial = ReturnType<typeof aerialPerspectiveWithCloudShadow>
type CompositeArg = Parameters<CloudsPassNode['composite']>[0]
/** `true` only when From fits in To, so `const x: Fits<A, B> = true` reds if not */
type Fits<From, To> = [From] extends [To] ? true : false

it('composite() takes the aerial node the docs tell consumers to pass', () => {
  // THE assertion. Aerial was not assignable to the old `Node<'vec4'>`, which is
  // what forced `as unknown as` at every call site in the examples and the
  // WEBGPU.md Usage snippet a consumer copies
  const aerialFits: Fits<Aerial, CompositeArg> = true
  const vec4Fits: Fits<Node<'vec4'>, CompositeArg> = true

  expect(aerialFits && vec4Fits).toBe(true)
})

// the assertion above, kept out of the test body so the file has no runtime work
const _aerialFits: Fits<Aerial, CompositeArg> = true
const _vec4Fits: Fits<Node<'vec4'>, CompositeArg> = true
export { _aerialFits, _vec4Fits }
