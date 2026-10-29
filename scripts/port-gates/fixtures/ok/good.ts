// Fixture: accepted forms for decision-points.mjs (ADR-010)
// Every Fn variant the counter must recognise.
import { float, Fn, FnLayout, FnVar, If, Loop, Node, select } from 'three/tsl'

const measuredFive = Fn(() => {
  If(a.greaterThan(b), () => {
    const v = float(1)
  }).Else(() => {
    const v = float(0)
  })
  const r = select(a, b, c)
  Loop(10, ({ i }) => {
    const inner = Fn(() => {
      return a.mul(float(2))
    })
  })
  const s = 'select(foo, bar)'
  // If( this is a comment and should not count
})

const trivial = Fn(() => {
  return a.mul(float(2))
})

const typedReturn = FnVar(
  (p: Node<'vec3'>, q: Node<'float'>): Node<'float'> => {
    If(p.x.greaterThan(q), () => {})
  }
)

const curried = FnVar(p => (builder): Node<'float'> => {
  const r = select(p, float(0), float(1))
})

const laidOut = FnLayout({
  name: 'test',
  type: 'float',
  inputs: [{ name: 'x', type: 'float' }]
})(([x], builder) => {
  Loop(4, ({ i }) => {})
})

const generic = Fn<[Node<'float'>]>(([x]) => {
  return x.mul(float(2))
})

const oneLiner = FnLayout({
  name: 'pick',
  type: 'float',
  inputs: [{ name: 'x', type: 'float' }]
})(([x]) => select(x.greaterThan(float(0)), float(1), float(0)))
