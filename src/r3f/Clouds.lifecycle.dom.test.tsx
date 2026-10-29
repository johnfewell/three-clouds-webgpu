// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import { Data3DTexture, DepthTexture, PerspectiveCamera, Texture } from 'three'
import { texture } from 'three/tsl'
import { afterEach, expect, test, vi } from 'vitest'

import { log } from '../../test/helpers/log'
import type { CloudLayer as CloudLayerImpl } from '../CloudLayer'
import { CloudsPassNode } from '../CloudsPassNode'
import { CloudLayer, type CloudLayerProps } from './CloudLayer'
import { Clouds } from './Clouds'

let camera = new PerspectiveCamera()

vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: { camera: PerspectiveCamera }) => unknown) =>
    selector({ camera })
}))

const textures = {
  localWeatherTexture: new Texture(),
  shapeTexture: new Data3DTexture(),
  shapeDetailTexture: new Data3DTexture(),
  turbulenceTexture: new Texture(),
  stbnTexture: new Data3DTexture()
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('rerenders update depth, camera and borrowed textures without replacing the pass', () => {
  const ref = createRef<CloudsPassNode>()
  const first = texture(new DepthTexture(1, 1))
  const second = texture(new DepthTexture(1, 1))
  const mounted = render(<Clouds ref={ref} sceneDepth={first} {...textures} />)
  const pass = ref.current!
  const reset = vi.spyOn(pass.cloudsContext, 'resetHistory')
  camera = new PerspectiveCamera()
  const weather = new Texture()
  mounted.rerender(
    <Clouds
      ref={ref}
      sceneDepth={second}
      {...textures}
      localWeatherTexture={weather}
      time={12}
      frame={34}
    />
  )
  expect(ref.current).toBe(pass)
  expect(pass.sceneDepth).toBe(second)
  expect(pass.camera).toBe(camera)
  expect(pass.cloudsContext.localWeatherTexture).toBe(weather)
  expect(pass.cloudsContext.time).toBe(12)
  expect(pass.cloudsContext.frame).toBe(34)
  expect(reset).toHaveBeenCalled()
  const dispose = vi.spyOn(weather, 'dispose')
  mounted.unmount()
  expect(ref.current).toBeNull()
  expect(dispose).not.toHaveBeenCalled()
  log('react-input-update', { stablePass: true, depth: 'second', frame: 34 })
})

test('Strict Mode never publishes the disposed trial pass and clears refs on unmount', () => {
  const dispose = vi.spyOn(CloudsPassNode.prototype, 'dispose')
  const ref = createRef<CloudsPassNode>()
  const layerRef = createRef<CloudLayerImpl>()
  const mounted = render(
    <StrictMode>
      <Clouds ref={ref} sceneDepth={null} {...textures} disableDefaultLayers>
        <CloudLayer ref={layerRef} height={123} />
      </Clouds>
    </StrictMode>
  )
  const pass = ref.current!
  expect(dispose.mock.instances).not.toContain(pass)
  expect(layerRef.current).toBe(pass.cloudsContext.cloudLayers[0])
  expect(pass.cloudsContext.cloudLayers.map(layer => layer.height)).toEqual([
    123, 0, 0, 0
  ])
  mounted.unmount()
  expect(
    dispose.mock.instances.filter(instance => instance === pass)
  ).toHaveLength(1)
  expect(ref.current).toBeNull()
  expect(layerRef.current).toBeNull()
  log('strict-mode-lifecycle', {
    livePassDisposedOnce: true,
    refsCleared: true
  })
})

test('callback refs clear on replacement and unmount', () => {
  const first = vi.fn()
  const second = vi.fn()
  const layer = vi.fn()
  const mounted = render(
    <Clouds ref={first} sceneDepth={null} {...textures}>
      <CloudLayer ref={layer} />
    </Clouds>
  )
  const pass = first.mock.calls[0]![0]
  mounted.rerender(
    <Clouds ref={second} sceneDepth={null} {...textures}>
      <CloudLayer ref={layer} />
    </Clouds>
  )
  expect(first).toHaveBeenLastCalledWith(null)
  expect(second).toHaveBeenLastCalledWith(pass)
  mounted.unmount()
  expect(second).toHaveBeenLastCalledWith(null)
  expect(layer).toHaveBeenLastCalledWith(null)
  log('callback-ref-cleanup', { replaced: true, unmounted: true })
})

test('keyed reordering preserves slots and removing a layer makes its slot reusable', () => {
  const ref = createRef<CloudsPassNode>()
  const first = createRef<CloudLayerImpl>()
  const second = createRef<CloudLayerImpl>()
  const view = (keys: string[]) => (
    <Clouds ref={ref} sceneDepth={null} {...textures} disableDefaultLayers>
      {keys.map(key => (
        <CloudLayer
          key={key}
          ref={key === 'first' ? first : second}
          height={key === 'first' ? 100 : 200}
        />
      ))}
    </Clouds>
  )
  const mounted = render(view(['first', 'second']))
  const layers = ref.current!.cloudsContext.cloudLayers
  mounted.rerender(view(['second', 'first']))
  expect(first.current).toBe(layers[0])
  expect(second.current).toBe(layers[1])
  mounted.rerender(view(['second']))
  expect(first.current).toBeNull()
  expect(layers[0]!.height).toBe(0)
  expect(second.current).toBe(layers[1])
  mounted.rerender(view(['second', 'first']))
  expect(first.current).toBe(layers[0])
  expect(layers[0]!.height).toBe(100)
  log('keyed-layer-slots', { reordered: true, freed: 0, reused: 0 })
})

test('changing explicit indices and default policy restores old slots', () => {
  const ref = createRef<CloudsPassNode>()
  const layerRef = createRef<CloudLayerImpl>()
  const view = (index: CloudLayerProps['index'], disableDefault: boolean) => (
    <Clouds
      ref={ref}
      sceneDepth={null}
      {...textures}
      disableDefaultLayers={disableDefault}
    >
      <CloudLayer ref={layerRef} index={index} height={123} />
    </Clouds>
  )
  const mounted = render(view(0, true))
  const layers = ref.current!.cloudsContext.cloudLayers
  mounted.rerender(view(3, true))
  expect(layerRef.current).toBe(layers[3])
  expect(layers[0]!.height).toBe(0)
  expect(layers[3]!.height).toBe(123)
  mounted.rerender(view(3, false))
  expect(layerRef.current).toBe(layers[3])
  expect(layers[3]!.height).toBe(123)
  expect(layers[0]!.height).toBeGreaterThan(0)
  log('explicit-layer-change', { from: 0, to: 3, restoredDefault: true })
})

test.each([-1, 4, 0.5, NaN])(
  'invalid runtime layer index %s throws an actionable error',
  index => {
    expect(() =>
      render(
        <Clouds sceneDepth={null} {...textures}>
          <CloudLayer index={index as CloudLayerProps['index']} />
        </Clouds>
      )
    ).toThrow(/CloudLayer index must be 0, 1, 2 or 3/)
    log('invalid-layer-index', { input: String(index), rejected: true })
  }
)

test('duplicate explicit slots and a fifth layer fail instead of silently disappearing', () => {
  expect(() =>
    render(
      <Clouds sceneDepth={null} {...textures}>
        <CloudLayer index={2} />
        <CloudLayer index={2} />
      </Clouds>
    )
  ).toThrow(/index 2 is already occupied/)
  expect(() =>
    render(
      <Clouds sceneDepth={null} {...textures}>
        {Array.from({ length: 5 }, (_, index) => (
          <CloudLayer key={index} />
        ))}
      </Clouds>
    )
  ).toThrow(/at most four CloudLayer children/)
  log('layer-capacity', { duplicateRejected: true, fifthRejected: true })
})
