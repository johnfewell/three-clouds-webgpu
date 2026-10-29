// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/" }
// The URL is a base for the relative default texture paths, which three's
// loader cannot resolve against jsdom's about:blank

// <Clouds> is state and lifecycle only, so these tests read the
// context without a GPU. `useThree` is stubbed because r3f's <Canvas> needs a
// WebGPU context

// Superseded clause: the task asked for time "advanced by a mocked useFrame",
// but <Clouds> owns no clock (ADR-003: any (time, frame) pair renders the same
// pixels). The test below asserts the opposite

import { render } from '@testing-library/react'
import { createRef } from 'react'
import { Data3DTexture, Matrix4, Texture, Vector3 } from 'three'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { CloudsPassNode } from '../CloudsPassNode'
import { experimentalDefaults } from '../experimental/options'
import { qualityPresets } from '../qualityPresets'
import { createJitterTexture } from '../textures/loadBakedCloudTextures'
import { CloudLayer } from './CloudLayer'
import {
  Clouds,
  CloudsPassContext,
  type CloudsPassContextValue
} from './Clouds'

const camera = { isCamera: true, name: 'stub-camera' }

vi.mock('@react-three/fiber', () => ({
  useThree: (selector?: (state: unknown) => unknown) =>
    selector != null ? selector({ camera, gl: {} }) : { camera, gl: {} },
  useFrame: () => undefined
}))

let captured: CloudsPassContextValue | null = null

// Textures are objects so the default URLs never reach a loader: fetch needs
// an absolute URL even with a jsdom document URL. Asset loading is covered by
// p4-e2e-suite 9 in a real browser
const TEXTURE_STUBS = {
  localWeatherTexture: new Texture(),
  shapeTexture: new Data3DTexture(),
  shapeDetailTexture: new Data3DTexture(),
  turbulenceTexture: new Texture(),
  stbnTexture: new Data3DTexture()
}

/** Renders <Clouds> and hands back the context it published */
function mount(props: Record<string, unknown> = {}, children?: unknown) {
  captured = null
  const Probe = (): null => {
    return null
  }
  const utils = render(
    <Clouds sceneDepth={null} {...TEXTURE_STUBS} {...props}>
      <CloudsPassContext.Consumer>
        {value => {
          captured = value
          return <Probe />
        }}
      </CloudsPassContext.Consumer>
      {children as never}
    </Clouds>
  )
  return utils
}

afterEach(() => {
  captured = null
})

describe('<Clouds>', () => {
  test('publishes the pass and its context', () => {
    mount()
    expect(captured).not.toBeNull()
    expect(captured!.pass).toBeDefined()
    expect(captured!.context).toBe(captured!.pass.cloudsContext)
  })

  test('time and frame are written to the context as given', () => {
    mount({ time: 1, frame: 2 })
    expect(captured!.context.time).toBe(1)
    expect(captured!.context.frame).toBe(2)
  })

  // The default used to be DEFAULT_STBN_URL, a runtime fetch of NVIDIA's
  // dataset. It is now the library's blue-noise volume, built synchronously
  test('omitting stbnTexture uses the blue-noise volume and fetches nothing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    mount({ stbnTexture: undefined })
    const data = captured!.context.stbnTexture.image.data as Uint8Array
    const expected = createJitterTexture().image.data as Uint8Array
    expect(data.length).toBe(128 * 128 * 64)
    expect(Buffer.from(data).equals(Buffer.from(expected))).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  // The substitution noted at the top: no clock, so both stay at their
  // defaults. Wiring useFrame in turns this red, by design (ADR-003)
  test('omitting time and frame advances NOTHING (no clock, ADR-003)', () => {
    mount()
    expect(captured!.context.time).toBe(0)
    expect(captured!.context.frame).toBe(0)
  })

  // The WebGL-named knobs, forwarded verbatim. Logged as a table so the audit
  // can read which names were actually exercised rather than trusting the list
  const FORWARDED: Array<[string, number | boolean]> = [
    ['coverage', 0.42],
    ['scatteringCoefficient', 1.5],
    ['absorptionCoefficient', 0.25],
    ['turbulenceDisplacement', 123],
    ['skyLightScale', 2],
    ['groundBounceScale', 3],
    ['powderScale', 0.7],
    ['powderExponent', 42],
    ['scatterAnisotropyMix', 0.25],
    ['resolutionScale', 0.5],
    ['sunAngularRadius', 0.01],
    ['bottomRadius', 6360001],
    ['correctAltitude', false],
    ['cameraHeight', 1234],
    ['warnings', false]
  ]

  test.each(FORWARDED)('forwards %s', (key, value) => {
    mount({ [key]: value })
    expect(
      (captured!.context as unknown as Record<string, unknown>)[key],
      `${key} did not reach CloudsContext`
    ).toBe(value)
  })

  test('logs the forwarded-knob table', () => {
    const rows = FORWARDED.map(([key, value]) => {
      mount({ [key]: value })
      return {
        key,
        sent: String(value),
        onContext: String(
          (captured!.context as unknown as Record<string, unknown>)[key]
        )
      }
    })
    console.log('[r3f] forwarded knobs:', JSON.stringify(rows))
    expect(rows.every(r => r.sent === r.onContext)).toBe(true)
  })

  test('debug is forwarded and normalised', () => {
    mount({ debug: 'shadowMap' })
    expect(captured!.context.debug).toBe('shadowMap')
  })

  test('forwards ref as object and exposes resetHistory', () => {
    const ref = createRef<CloudsPassNode>()
    mount({ ref })
    expect(ref.current).toBe(captured!.pass)
    const spy = vi.spyOn(captured!.context, 'resetHistory')
    ref.current!.resetHistory()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test('forwards ref as callback', () => {
    const refCallback = vi.fn()
    mount({ ref: refCallback })
    expect(refCallback).toHaveBeenCalledWith(captured!.pass)
  })

  test('forwards sunDirection and worldToECEFMatrix', () => {
    const sun = new Vector3(1, 2, 3).normalize()
    const matrix = new Matrix4().makeRotationX(1)
    mount({ sunDirection: sun, worldToECEFMatrix: matrix })
    expect(captured!.context.sunDirection.x).toBeCloseTo(sun.x)
    expect(captured!.context.sunDirection.y).toBeCloseTo(sun.y)
    expect(captured!.context.sunDirection.z).toBeCloseTo(sun.z)
    expect(captured!.context.worldToECEFMatrix.elements).toEqual(
      matrix.elements
    )
  })

  test('disableDefaultLayers sets zero-thickness default layers', () => {
    mount({ disableDefaultLayers: true })
    const layers = captured!.context.cloudLayers
    expect(layers.length).toBe(4)
    expect(layers.every(l => l.height === 0)).toBe(true)
  })
})

// The experimental options and the quality presets are compound props: the
// surface is one object rather than a boolean per option, so these check the
// whole path rather than one key at a time
const EXPERIMENTAL_KEYS = Object.keys(
  experimentalDefaults
) as (keyof typeof experimentalDefaults)[]

describe('<Clouds> experimental prop', () => {
  test.each(EXPERIMENTAL_KEYS)('%s reaches the context', key => {
    mount({ experimental: { [key]: true } })
    expect(captured!.context.experimental[key]).toBe(true)
  })

  // A partial must not reset the options it does not name: the context merges,
  // and a prop that clobbered the others would silently switch a feature off
  test('a partial leaves the unmentioned options alone', () => {
    mount({ experimental: { computeResolve: true } })
    for (const key of EXPERIMENTAL_KEYS) {
      // Whatever the prop did not name keeps the library default, including
      // distantShapeDetailFade, which ships on
      const expected =
        key === 'computeResolve' ? true : experimentalDefaults[key]
      expect(captured!.context.experimental[key], `${key} was clobbered`).toBe(
        expected
      )
    }
  })

  // graphVersion alone only sets needsUpdate, and three can serve the old
  // program when the cache key does not move. A compiled-variant change has to
  // bump the version AND land in experimentalFlags
  test('turning an option on bumps graphVersion and moves the cache key', () => {
    const { rerender } = mount()
    const context = captured!.context
    const before = context.graphVersion
    const keyBefore = context.graphFlags().experimentalFlags
    rerender(
      <Clouds
        sceneDepth={null}
        {...TEXTURE_STUBS}
        experimental={{ computeResolve: true }}
      />
    )
    expect(captured!.context).toBe(context)
    expect(context.graphVersion, 'graphVersion did not move').toBeGreaterThan(
      before
    )
    expect(context.graphFlags().experimentalFlags).not.toBe(keyBefore)
  })

  // The other direction: an equal object must not churn the graph, or every
  // re-render with an inline literal would rebuild the pass
  test('an unchanged object does not bump graphVersion', () => {
    const { rerender } = mount({ experimental: { windReprojection: true } })
    const context = captured!.context
    const before = context.graphVersion
    rerender(
      <Clouds
        sceneDepth={null}
        {...TEXTURE_STUBS}
        experimental={{ windReprojection: true }}
      />
    )
    expect(context.graphVersion, 'a no-op prop churned the graph').toBe(before)
  })

  // The context throws on an unknown key or a non-boolean, so a typo surfaces
  // at render rather than becoming a silently inert option
  test('an unknown key throws', () => {
    expect(() => mount({ experimental: { notAnOption: true } })).toThrow(
      /Invalid experimental cloud option/
    )
  })

  test('a non-boolean value throws', () => {
    expect(() => mount({ experimental: { computeResolve: 'yes' } })).toThrow(
      /Invalid experimental cloud option/
    )
  })

  test('omitting the prop leaves the context defaults', () => {
    mount()
    expect(captured!.context.experimental).toEqual(experimentalDefaults)
  })

  test('logs the experimental-option table', () => {
    const rows = EXPERIMENTAL_KEYS.map(key => {
      mount({ experimental: { [key]: true } })
      return {
        key,
        onContext: String(captured!.context.experimental[key])
      }
    })
    console.log('[r3f] experimental options:', JSON.stringify(rows))
    expect(rows.every(r => r.onContext === 'true')).toBe(true)
  })
})

describe('<Clouds> qualityPreset prop', () => {
  test.each(Object.keys(qualityPresets) as Array<keyof typeof qualityPresets>)(
    'preset %s reaches the context',
    preset => {
      mount({ qualityPreset: preset })
      expect(captured!.context.qualityPreset).toBe(preset)
    }
  )

  test('the preset fields reach the context', () => {
    mount({ qualityPreset: 'low' })
    const context = captured!.context
    const low = qualityPresets.low
    expect(context.lightShafts).toBe(low.lightShafts)
    expect(context.shapeDetail).toBe(low.shapeDetail)
    expect(context.turbulence).toBe(low.turbulence)
    expect(context.haze).toBe(low.haze)
    expect(context.resolutionScale).toBe(low.resolutionScale)
    expect(context.multiScatteringOctaves).toBe(
      low.clouds.multiScatteringOctaves
    )
    expect(context.clouds.maxIterationCount).toBe(low.clouds.maxIterationCount)
  })

  // 'low' turns lightShafts off and 'high' is the default, so the two
  // disagree on a graph-shape field and the change must reach the version
  test('changing the preset bumps graphVersion', () => {
    const { rerender } = mount()
    const context = captured!.context
    const before = context.graphVersion
    rerender(
      <Clouds sceneDepth={null} {...TEXTURE_STUBS} qualityPreset='low' />
    )
    expect(captured!.context).toBe(context)
    expect(context.graphVersion, 'graphVersion did not move').toBeGreaterThan(
      before
    )
    expect(context.lightShafts).toBe(false)
  })

  test('an unchanged preset does not bump graphVersion', () => {
    const { rerender } = mount({ qualityPreset: 'low' })
    const context = captured!.context
    const before = context.graphVersion
    rerender(
      <Clouds sceneDepth={null} {...TEXTURE_STUBS} qualityPreset='low' />
    )
    expect(context.graphVersion, 'a no-op prop churned the graph').toBe(before)
  })

  // Both write resolutionScale. The explicit prop is the more specific
  // statement, so it has to be applied after the preset
  test('an explicit knob overrides the preset', () => {
    mount({ qualityPreset: 'low', resolutionScale: 0.25 })
    expect(captured!.context.resolutionScale).toBe(0.25)
    // and the preset's other fields survive
    expect(captured!.context.lightShafts).toBe(false)
  })

  test('omitting the prop leaves the default preset', () => {
    mount()
    expect(captured!.context.qualityPreset).toBe('high')
    expect(captured!.context.lightShafts).toBe(qualityPresets.high.lightShafts)
  })
})

describe('<CloudLayer>', () => {
  test('edits the slot it claims on the shared CloudLayers', () => {
    mount({}, <CloudLayer altitude={1234} height={567} />)
    const layers = captured!.context.cloudLayers
    const edited = [...layers].filter(l => l.altitude === 1234)
    expect(edited.length, 'no layer received the declared altitude').toBe(1)
    expect(edited[0]!.height).toBe(567)
  })

  test('two layers take different slots', () => {
    mount(
      {},
      <>
        <CloudLayer altitude={1000} />
        <CloudLayer altitude={2000} />
      </>
    )
    const layers = [...captured!.context.cloudLayers]
    expect(layers.filter(l => l.altitude === 1000).length).toBe(1)
    expect(layers.filter(l => l.altitude === 2000).length).toBe(1)
  })
})
