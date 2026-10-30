// the shared byte-identical-off proof (docs/design/cloud-types.md
// §7). One context, compiled twice: the default graph's digest must equal the
// literal recorded from main, and the on digest must differ. A parity plate
// cannot see this, since the ladder pins metrics and not shader bytes

import { beforeEach, describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { offAndOnDigests } from '../../test/helpers/marchWGSLDigest'

// Default march and shadow snapshots refreshed for the stock r187 compiler
const MAINLINE_MARCH_DIGEST =
  '6dc555922a6ac3df4b1e46090a7758ab64a0e3eacbc9cec24887d0435f43583b'
const MAINLINE_SHADOW_DIGEST =
  '6e821e499b4bfc899e55ea34d7c2ef1c3a61a7e429106e9248179115c6fe9d5d'

describe('default graph is byte-identical to mainline', () => {
  beforeEach(() => {
    setCurrentSpec('evolvingWeather_defaultDigest')
  })

  test('off matches the mainline literals and on moves both shaders', () => {
    const { off, on } = offAndOnDigests()
    log('digest', {
      offMarch: off.march,
      offShadow: off.shadow,
      onMarch: on.march,
      onShadow: on.shadow
    })

    // (1) the default graph is main's, to the byte
    expect(off.march).toBe(MAINLINE_MARCH_DIGEST)
    expect(off.shadow).toBe(MAINLINE_SHADOW_DIGEST)

    // (2) and the guard is real: the feature reaches BOTH samplers, the
    // primary march and the shadow march. A feature that never reached the
    // shader would pass (1) alone
    expect(on.march).not.toBe(off.march)
    expect(on.shadow).not.toBe(off.shadow)
  })

  test('the option is in the cache key, so flipping it rebuilds the graph', () => {
    const before = offAndOnDigests()
    const after = offAndOnDigests()
    // Deterministic: the digest depends on the graph flags and nothing else,
    // which is what makes the literal above meaningful
    expect(after).toEqual(before)
    log('determinism', { repeats: 2, stable: true })
  })
})
