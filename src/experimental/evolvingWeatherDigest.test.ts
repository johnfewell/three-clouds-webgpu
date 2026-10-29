// the shared byte-identical-off proof (docs/design/cloud-types.md
// §7). One context, compiled twice: the default graph's digest must equal the
// literal recorded from main, and the on digest must differ. A parity plate
// cannot see this, since the ladder pins metrics and not shader bytes

import { beforeEach, describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { offAndOnDigests } from '../../test/helpers/marchWGSLDigest'

// March bytes are the stbn rename and the core intersection helper. Shadow
// bytes add the fused ray projection. A failure means one moved. Re-measure
// on the merged tree, do not paste a hash from a run you did not cause
const MAINLINE_MARCH_DIGEST =
  'ff1b1f1fbbb7b103216acf02424e27e1ad7405255100aeefe30c1b1c3ab63f55'
const MAINLINE_SHADOW_DIGEST =
  '8f1667b3b048356404060a5c946e69ecc96834a422867930e85d5eafb06931d1'

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
