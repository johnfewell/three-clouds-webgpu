// three r186 alone (f6080cc6, reverted by a32e4d65 for r187) declares a plain
// node read in an If, its Else and after them in the Else only, so the If path
// reads it zero-initialised. The port's branch-scope guards rest on this repro

import { REVISION } from 'three'
import { float, Fn, If, sqrt, uniform, vec4 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { readsOutsideAssigningBlock, varsAssigned } from './helpers/branchScope'
import { compileWGSL } from './helpers/compileWGSL'
import { log } from './helpers/log'

function sharedAcrossIfElse(): string {
  const node = Fn(() => {
    const a = uniform(2)
    const shared = sqrt(a.mul(a).add(1))
    const out = float(0).toVar()
    If(a.greaterThan(1), () => {
      out.assign(shared.add(1))
    }).Else(() => {
      out.assign(shared.mul(2))
    })
    return vec4(out.add(shared))
  })()
  return compileWGSL(node).fragment
}

// Only r186 orphans the read, so this is also the positive control showing
// branchScope.ts finds the defect where it exists
const orphansExpected = REVISION === '186'

describe('a node shared across If, Else and after', () => {
  it(`is read outside its declaring block only on r186 (r${REVISION})`, () => {
    const wgsl = sharedAcrossIfElse()
    const names = varsAssigned(wgsl, /sqrt\(/)
    const outside = names.flatMap(n => readsOutsideAssigningBlock(wgsl, n))
    log('context-node-setup', {
      revision: REVISION,
      sqrtVars: names.length,
      readsOutsideAssigningBlock: outside.length,
      orphansExpected
    })
    expect(names.length, 'the shared node is held in a var').toBeGreaterThan(0)
    expect(outside.length > 0).toBe(orphansExpected)
  })
})
