// Fixture: patterns that should fail or trigger warnings
import { float, Fn, FnLayout, FnVar, If, Node, select } from 'three/tsl'

const expressionBodied = Fn(([x]) =>
  select(x.greaterThan(float(0)), float(1), float(2))
)

const functionKeyword = Fn(function () {
  return a.mul(float(2))
})

class Foo {
  setup() {
    select(a, b, c)
    If(x.greaterThan(float(0)), () => {})
  }
}

const storedLayout = FnLayout({ name: 'stored', type: 'float' })

const expressionVar = FnVar(x => x.mul(float(2)))

// thirteen: 12 If calls -> complexity 13 (over the gate of 12)
const thirteen = Fn(() => {
  If(a, () => {})
  If(b, () => {})
  If(c, () => {})
  If(d, () => {})
  If(e, () => {})
  If(f, () => {})
  If(g, () => {})
  If(h, () => {})
  If(j, () => {})
  If(k, () => {})
  If(l, () => {})
  If(m, () => {})
})
