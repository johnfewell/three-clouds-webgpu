// @vitest-environment jsdom
// Every Storybook panel switch on a port-only path must reach the clouds
// context. The comparison control used to run applyPortDefaults after the
// panel wrote its switches, which put back every default-on switch set off
import { act, cleanup, render } from '@testing-library/react'
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// jotai is a storybook dependency only. Through its node_modules, so this is
// the same module, and the same default store, the panel's hook reads
import {
  atom,
  getDefaultStore,
  type PrimitiveAtom
} from '../examples/storybook/node_modules/jotai'
import {
  cloudsArgs,
  useCloudsControls,
  type CloudsArgs
} from '../examples/storybook/src/clouds/controls/cloudsControls'
import { StoryContext } from '../examples/storybook/src/vendor/helpers/StoryContext'
import { CloudsContext } from '../src/CloudsContext'
import {
  experimentalDefaults,
  type ExperimentalCloudOptions
} from '../src/experimental/options'
import { REFERENCE_MODE } from '../src/referenceMode'
import { log } from './helpers/log'

// The panel imports the library by package name, which resolves to build/,
// so map it to source and this file never reads a build another test writes
vi.mock('three-clouds-webgpu', () => import('../src/index'))

type Key = keyof ExperimentalCloudOptions
const KEYS = Object.keys(experimentalDefaults) as Key[]
const store = getDefaultStore()

function mount(overrides: Partial<CloudsArgs> = {}) {
  const context = new CloudsContext()
  const argsAtom = atom<CloudsArgs>({
    ...cloudsArgs(new CloudsContext()),
    ...overrides
  })
  const Panel: FC = () => {
    useCloudsControls(context)
    return null
  }
  const tree = () =>
    createElement(
      StoryContext.Provider,
      { value: { argsAtom: argsAtom as PrimitiveAtom<object> } },
      createElement(Panel)
    )
  const utils = render(tree())
  return {
    context,
    // A Controls-panel edit: the args atom changes and nothing re-renders
    set: (patch: Partial<CloudsArgs>) => {
      act(() => {
        store.set(argsAtom, { ...store.get(argsAtom), ...patch })
      })
    },
    // Anything that re-renders the story replays every control in order
    rerender: () => {
      utils.rerender(tree())
    }
  }
}

afterEach(cleanup)

describe('storybook experimental args reach cloudsContext.experimental', () => {
  it.each(KEYS)('%s, set against its default', key => {
    const arg = `experimental-${key}` as const
    const value = !experimentalDefaults[key]

    const initial = mount({ [arg]: value })
    const fromUrl = initial.context.experimental[key]
    initial.rerender()
    const afterRender = initial.context.experimental[key]

    const panel = mount()
    panel.set({ [arg]: value })
    const fromPanel = panel.context.experimental[key]
    panel.rerender()
    const panelThenRender = panel.context.experimental[key]

    // Baseline is the reference by design, so the switch is held off there
    initial.set({ experimentMode: 'baseline' })
    const baseline = initial.context.experimental[key]
    initial.set({ experimentMode: 'experiments' })
    const back = initial.context.experimental[key]

    log('reach', {
      arg,
      set: value,
      fromUrl,
      afterRender,
      fromPanel,
      panelThenRender,
      baseline,
      back
    })
    expect(fromUrl).toBe(value)
    expect(afterRender).toBe(value)
    expect(fromPanel).toBe(value)
    expect(panelThenRender).toBe(value)
    expect(baseline).toBe(REFERENCE_MODE.experimental[key])
    expect(back).toBe(value)
  })
})

// The two panel knobs that are also reference-mode paths: the comparison
// control writes them too, so they carry the same ordering risk
describe('storybook port-only knobs reach the context in Experiments', () => {
  const knobs = [
    {
      arg: 'lightShaftsHalfResolution',
      read: (ctx: CloudsContext) => ctx.lightShaftsHalfResolution,
      reference: REFERENCE_MODE.lightShaftsHalfResolution
    },
    {
      arg: 'shadow-updateInterval',
      read: (ctx: CloudsContext) => ctx.shadow.updateInterval,
      reference: REFERENCE_MODE.shadowUpdateInterval
    }
  ] as const

  it.each(knobs)('$arg', ({ arg, read, reference }) => {
    const fresh = new CloudsContext()
    const value = typeof read(fresh) === 'boolean' ? !read(fresh) : 3

    const initial = mount({ [arg]: value })
    const fromUrl = read(initial.context)
    initial.rerender()
    const afterRender = read(initial.context)
    initial.set({ experimentMode: 'baseline' })
    const baseline = read(initial.context)
    initial.set({ experimentMode: 'experiments' })
    const back = read(initial.context)

    log('knob', { arg, set: value, fromUrl, afterRender, baseline, back })
    expect(fromUrl).toBe(value)
    expect(afterRender).toBe(value)
    expect(baseline).toBe(reference)
    expect(back).toBe(value)
  })
})
