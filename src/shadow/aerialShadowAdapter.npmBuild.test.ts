import type { Node } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { log } from '../../test/helpers/log'
import { aerialPerspectiveWithCloudShadow } from './aerialShadowAdapter'

// The npm 0.19.1 AerialPerspectiveNode, which has neither hook input. A node
// built from it must refuse a shadow rather than drop it silently
vi.mock('@takram/three-atmosphere/webgpu', () => ({
  AerialPerspectiveNode: class {
    lighting = false
    constructor(
      readonly colorNode: unknown,
      readonly depthNode: unknown
    ) {}
  }
}))

const NONE = null as unknown as Node<'vec4'>
const NO_DEPTH = null as unknown as Node<'float'>

describe('the adapter on an atmosphere build without the hook inputs', () => {
  it('throws when a cloud shadow is requested', () => {
    const shadow = { type: 'float' } as unknown as Node<'float'>
    expect(() =>
      aerialPerspectiveWithCloudShadow(NONE, NO_DEPTH, null, shadow)
    ).toThrow(/fork build 0\.19\.1\+fork\.8/)
  })

  it('throws when only a lighting mask is requested', () => {
    const mask = { type: 'float' } as unknown as Node<'float'>
    expect(() =>
      aerialPerspectiveWithCloudShadow(
        NONE,
        NO_DEPTH,
        null,
        null,
        undefined,
        mask
      )
    ).toThrow(/no shadowNode \/ lightingMaskNode input/)
  })

  it('builds the plain node when neither input is requested', () => {
    const node = aerialPerspectiveWithCloudShadow(NONE, NO_DEPTH, null, null)
    const own = {
      shadowNode: 'shadowNode' in node,
      mask: 'lightingMaskNode' in node
    }
    log('npm-build-plain', own)
    expect(own).toEqual({ shadowNode: false, mask: false })
  })
})
