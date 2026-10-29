// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react'
import {
  createRef,
  Fragment,
  memo,
  StrictMode,
  useState,
  type ReactNode
} from 'react'
import { expect, test, vi } from 'vitest'

import { log } from '../../test/helpers/log'
import type { CloudLayer as CloudLayerImpl } from '../CloudLayer'
import { CloudLayers as CloudLayersImpl } from '../CloudLayers'
import { CloudLayer, type CloudLayerProps } from './CloudLayer'
import { CloudLayers, CloudLayersContext } from './CloudLayers'

const MemoCloudLayer = memo(CloudLayer)

function Nested({ children }: { children: ReactNode }) {
  return <Fragment>{children}</Fragment>
}

test.each([false, true])(
  'explicit slots precede earlier nested automatic children (strict=%s)',
  strict => {
    const layers = CloudLayersImpl.DEFAULT.clone()
    const automatic = createRef<CloudLayerImpl>()
    const second = createRef<CloudLayerImpl>()
    const fixed = createRef<CloudLayerImpl>()
    const content = (
      <CloudLayers layers={layers} disableDefault>
        <Nested>
          <CloudLayer ref={automatic} height={101} />
        </Nested>
        <>
          <CloudLayer ref={second} height={303} />
          <Nested>
            <CloudLayer ref={fixed} index={0} height={202} />
          </Nested>
        </>
        <Nested>
          <CloudLayer index={2} height={404} />
        </Nested>
      </CloudLayers>
    )
    const mounted = render(
      strict ? <StrictMode>{content}</StrictMode> : content
    )
    expect(automatic.current).toBe(layers[1])
    expect(second.current).toBe(layers[3])
    expect(fixed.current).toBe(layers[0])
    expect(layers.map(layer => layer.height)).toEqual([202, 101, 404, 303])
    mounted.unmount()
    expect(automatic.current).toBeNull()
    expect(second.current).toBeNull()
    expect(fixed.current).toBeNull()
    expect(layers.map(layer => layer.height)).toEqual([0, 0, 0, 0])
    log('explicit-before-automatic', {
      strict,
      slots: [1, 3, 0, 2],
      released: true
    })
  }
)

test.each([false, true])(
  'conditional explicit requests move a memoized automatic sibling and its ref (strict=%s)',
  strict => {
    const layers = CloudLayersImpl.DEFAULT.clone()
    const automatic = vi.fn()
    const fixed = createRef<CloudLayerImpl>()
    function Conditional() {
      const [index, setIndex] = useState<CloudLayerProps['index']>()
      return (
        <Nested>
          <button
            onClick={() =>
              setIndex(index === undefined ? 0 : index === 0 ? 1 : undefined)
            }
          >
            change
          </button>
          {index !== undefined && (
            <CloudLayer ref={fixed} index={index} height={222} />
          )}
        </Nested>
      )
    }
    const content = (
      <CloudLayers layers={layers} disableDefault>
        <MemoCloudLayer
          ref={automatic}
          height={111}
          densityProfile={{ expTerm: 7 }}
        />
        <Conditional />
      </CloudLayers>
    )
    const mounted = render(
      strict ? <StrictMode>{content}</StrictMode> : content
    )
    expect(automatic).toHaveBeenLastCalledWith(layers[0])
    fireEvent.click(mounted.getByRole('button'))
    expect(fixed.current).toBe(layers[0])
    expect(automatic).toHaveBeenLastCalledWith(layers[1])
    expect(layers.map(layer => layer.height)).toEqual([222, 111, 0, 0])
    expect(layers[1]!.densityProfile.expTerm).toBe(7)
    fireEvent.click(mounted.getByRole('button'))
    expect(fixed.current).toBe(layers[1])
    expect(automatic).toHaveBeenLastCalledWith(layers[0])
    expect(layers.map(layer => layer.height)).toEqual([111, 222, 0, 0])
    expect(layers[0]!.densityProfile.expTerm).toBe(7)
    fireEvent.click(mounted.getByRole('button'))
    expect(fixed.current).toBeNull()
    expect(layers.map(layer => layer.height)).toEqual([111, 0, 0, 0])
    fireEvent.click(mounted.getByRole('button'))
    expect(fixed.current).toBe(layers[0])
    expect(automatic).toHaveBeenLastCalledWith(layers[1])
    mounted.unmount()
    expect(automatic).toHaveBeenLastCalledWith(null)
    expect(layers.map(layer => layer.height)).toEqual([0, 0, 0, 0])
    log('conditional-explicit-priority', {
      strict,
      automaticMoves: [0, 1, 0, 1],
      propsAndRefs: true
    })
  }
)

test('explicit siblings can exchange indexes in one commit without transient collisions', () => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  const first = createRef<CloudLayerImpl>()
  const second = createRef<CloudLayerImpl>()
  const view = (swap: boolean) => (
    <CloudLayers layers={layers} disableDefault>
      <CloudLayer ref={first} index={swap ? 1 : 0} height={111} />
      <Nested>
        <CloudLayer ref={second} index={swap ? 0 : 1} height={222} />
      </Nested>
    </CloudLayers>
  )
  const mounted = render(view(false))
  mounted.rerender(view(true))
  expect(first.current).toBe(layers[1])
  expect(second.current).toBe(layers[0])
  expect(layers.map(layer => layer.height)).toEqual([222, 111, 0, 0])
  mounted.unmount()
  log('explicit-index-swap', { indexes: [1, 0], collisions: 0 })
})

test('automatic siblings keep their slots on reorder and reuse a released explicit slot', () => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  const first = createRef<CloudLayerImpl>()
  const second = createRef<CloudLayerImpl>()
  const third = createRef<CloudLayerImpl>()
  const view = (reorder: boolean, explicit: boolean, extra: boolean) => (
    <CloudLayers layers={layers} disableDefault>
      {(reorder ? ['second', 'first'] : ['first', 'second']).map(key => (
        <CloudLayer
          key={key}
          ref={key === 'first' ? first : second}
          height={key === 'first' ? 111 : 222}
        />
      ))}
      {explicit && <CloudLayer index={0} height={333} />}
      {extra && <CloudLayer ref={third} height={444} />}
    </CloudLayers>
  )
  const mounted = render(view(false, true, false))
  mounted.rerender(view(true, false, true))
  expect(first.current).toBe(layers[1])
  expect(second.current).toBe(layers[2])
  expect(third.current).toBe(layers[0])
  expect(layers.map(layer => layer.height)).toEqual([444, 111, 222, 0])
  mounted.unmount()
  log('automatic-stability', { stable: [1, 2], reused: 0 })
})

test('duplicate explicit slots and a fifth mixed child remain actionable errors', () => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  expect(() =>
    render(
      <CloudLayers layers={layers}>
        <CloudLayer />
        <Nested>
          <CloudLayer index={2} />
        </Nested>
        <Nested>
          <CloudLayer index={2} />
        </Nested>
      </CloudLayers>
    )
  ).toThrow(/index 2 is already occupied/)
  expect(() =>
    render(
      <CloudLayers layers={layers}>
        <CloudLayer />
        <CloudLayer />
        <CloudLayer />
        <CloudLayer />
        <Nested>
          <CloudLayer index={0} />
        </Nested>
      </CloudLayers>
    )
  ).toThrow(/at most four CloudLayer children/)
  log('layer-allocation-refusals', { duplicate: true, capacity: true })
})

test('advanced providers preserve reserved slots and return only managed allocations', () => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  layers[0]!.height = 999
  layers[1]!.height = 888
  const context = { layers, indexPool: [2, 3], disableDefault: true }
  const automatic = createRef<CloudLayerImpl>()
  const fixed = createRef<CloudLayerImpl>()
  const mounted = render(
    <StrictMode>
      <CloudLayersContext.Provider value={context}>
        <MemoCloudLayer ref={automatic} height={111} />
        <Nested>
          <CloudLayer ref={fixed} index={2} height={222} />
        </Nested>
      </CloudLayersContext.Provider>
    </StrictMode>
  )
  expect(automatic.current).toBe(layers[3])
  expect(fixed.current).toBe(layers[2])
  expect(context.indexPool).toEqual([])
  expect(layers.map(layer => layer.height)).toEqual([999, 888, 222, 111])
  mounted.unmount()
  expect(context.indexPool).toEqual([2, 3])
  expect(layers.map(layer => layer.height)).toEqual([999, 888, 0, 0])
  log('advanced-layer-pool', { reserved: [0, 1], returned: context.indexPool })
})

test('advanced providers reject unavailable explicit slots and empty pools', () => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  expect(() =>
    render(
      <CloudLayersContext.Provider
        value={{ layers, indexPool: [2, 3], disableDefault: true }}
      >
        <CloudLayer index={0} />
      </CloudLayersContext.Provider>
    )
  ).toThrow(/index 0 is already occupied/)
  expect(() =>
    render(
      <CloudLayersContext.Provider
        value={{ layers, indexPool: [], disableDefault: true }}
      >
        <CloudLayer />
      </CloudLayersContext.Provider>
    )
  ).toThrow(/no free slot/)
  log('advanced-layer-pool-refusals', { reserved: true, empty: true })
})

test('moving automatic layers adopt the new slot default and release to its default', () => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  const automatic = createRef<CloudLayerImpl>()
  function Conditional() {
    const [visible, setVisible] = useState(false)
    return (
      <>
        <button onClick={() => setVisible(!visible)}>change</button>
        {visible && <CloudLayer index={0} height={222} />}
      </>
    )
  }
  const mounted = render(
    <CloudLayers layers={layers}>
      <MemoCloudLayer ref={automatic} height={111} />
      <Conditional />
    </CloudLayers>
  )
  expect(automatic.current).toBe(layers[0])
  expect(automatic.current?.channel).toBe('r')
  fireEvent.click(mounted.getByRole('button'))
  expect(automatic.current).toBe(layers[1])
  expect(automatic.current?.channel).toBe('g')
  expect(automatic.current?.altitude).toBe(CloudLayersImpl.DEFAULT[1]!.altitude)
  expect(automatic.current?.height).toBe(111)
  fireEvent.click(mounted.getByRole('button'))
  expect(layers[0]).toEqual(CloudLayersImpl.DEFAULT[0])
  expect(automatic.current).toBe(layers[1])
  expect(automatic.current?.height).toBe(111)
  mounted.unmount()
  expect(layers).toEqual(CloudLayersImpl.DEFAULT)
  log('moved-layer-defaults', { channels: ['r', 'g'], restored: true })
})

test('unchanged allocations keep ref handles through parent rerenders', () => {
  const layers = CloudLayersImpl.DEFAULT.clone()
  const automatic = vi.fn()
  const fixed = vi.fn()
  const view = () => (
    <CloudLayers layers={layers} disableDefault>
      <CloudLayer ref={automatic} height={111} />
      <CloudLayer ref={fixed} index={0} height={222} />
    </CloudLayers>
  )
  const mounted = render(view())
  automatic.mockClear()
  fixed.mockClear()
  mounted.rerender(view())
  mounted.rerender(view())
  expect(automatic).not.toHaveBeenCalled()
  expect(fixed).not.toHaveBeenCalled()
  expect(layers.map(layer => layer.height)).toEqual([222, 111, 0, 0])
  mounted.unmount()
  expect(automatic).toHaveBeenCalledExactlyOnceWith(null)
  expect(fixed).toHaveBeenCalledExactlyOnceWith(null)
  log('stable-allocation-handles', { rerenders: 2, refChanges: 0 })
})
