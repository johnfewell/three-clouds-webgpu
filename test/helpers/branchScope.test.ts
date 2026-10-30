import { expect, test } from 'vitest'

import { readsOutsideAssigningBlock, varsAssigned } from './branchScope'

test('recognises assigned vars and r187 let declarations', () => {
  const wgsl = `
var a: f32;
a = log2( 2.0 );
let b = log2( 3.0 );
var c: f32 = log2( 4.0 );
consume(a, b, c);
`
  expect(varsAssigned(wgsl, /^log2/)).toEqual(['a', 'b', 'c'])
  for (const name of ['a', 'b', 'c']) {
    expect(readsOutsideAssigningBlock(wgsl, name)).toEqual([])
  }
})

test('rejects reads in sibling branches and uninitialised self reads', () => {
  const wgsl = `
if (condition) {
  let mip = log2( 2.0 );
  consume(mip);
} else {
  consume(mip);
}
let bad = bad + 1.0;
`
  expect(readsOutsideAssigningBlock(wgsl, 'mip')).toEqual(['consume(mip);'])
  expect(readsOutsideAssigningBlock(wgsl, 'bad')).toEqual([
    'let bad = bad + 1.0;'
  ])
})
