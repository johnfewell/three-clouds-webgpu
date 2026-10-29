// Adapted from three-geospatial storybook-webgpu/.storybook/preview.tsx (MIT,
// Copyright (c) 2024 Shota Matsuda). Differences: the antd ConfigProvider
// decorator is dropped (antd is not a dependency here) and lodash's debounce is
// replaced by a ten-line local one

import type { Preview } from '@storybook/react-vite'
import { getDefaultStore } from 'jotai'
import { LevaPanel, LevaStoreProvider, useCreateStore } from 'leva'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useKey } from 'react-use'
import { STORY_ARGS_UPDATED } from 'storybook/internal/core-events'
import { Preview as PreviewClass } from 'storybook/preview-api'

import {
  GROUND_LOCATIONS,
  groundAtom,
  isGroundValue,
  isWaterBody,
  WATER_BODIES,
  waterAtom
} from '../src/clouds/helpers/ground'
import { GpuMeterOverlay } from '../src/devtools/gpuMeter/GpuMeterOverlay'
import { gpuMeter } from '../src/devtools/gpuMeter/meter'
import { isShowcase, showcaseArgTypes } from './showcase'
import { docs } from './theme'

import './style.css'

// Reload when loading invalid caches
// See: https://vite.dev/guide/build#load-error-handling
window.addEventListener('vite:preloadError', event => {
  event.preventDefault()
  window.location.reload()
})

const DEBOUNCED = Symbol('DEBOUNCED')

declare module 'storybook/preview-api' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Preview<TRenderer> {
    [DEBOUNCED]?: boolean
  }
}

function debounce<T extends unknown[]>(
  callback: (...args: T) => void,
  wait: number
): (...args: T) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return (...args: T) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      callback(...args)
    }, wait)
  }
}

const debouncedChannelEmit = debounce(
  (
    channel: { emit: (event: string, ...args: unknown[]) => void },
    event: string,
    ...args: unknown[]
  ) => {
    channel.emit(event, ...args)
  },
  200
)

// WORKAROUND: Prevent Storybook from replacing URL too frequently, which has
// a performance ramification and triggers security errors on Safari
// (Upstream's monkey-patch, verbatim; the three disables below are what this
// repository's stricter lint says about it, not defects in the patch.)
// eslint-disable-next-line @typescript-eslint/unbound-method
const onUpdateArgs = PreviewClass.prototype.onUpdateArgs
PreviewClass.prototype.onUpdateArgs = async function (...args) {
  if (this[DEBOUNCED] !== true) {
    const channel = this.channel
    this.channel = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emit: (eventName: string, ...args: any) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
        if (eventName === STORY_ARGS_UPDATED) {
          debouncedChannelEmit(channel, eventName, ...args)
        } else {
          channel.emit(eventName, ...args)
        }
      }
    } as unknown as typeof this.channel
    this[DEBOUNCED] = true
  }
  await onUpdateArgs.apply(this, args)
}

// The public demo carries no dev tooling
const showcase = isShowcase(import.meta.env.STORYBOOK_SURFACE)
// Set by main.ts: false where three-ocean-waves is not built next to this
// checkout (CI), so the toolbar never offers a ground that would throw
const oceanAvailable = import.meta.env.STORYBOOK_OCEAN === 'true'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: {
      disableSaveFromUI: true
    },
    docs: {
      theme: docs
    },
    options: {
      // WORKAROUND: Cannot annotate type in storySort():
      // {
      //   type: string  // e.g. 'docs' | 'story'
      //   id: string    // e.g. 'package-category--story-name'
      //   name: string  // e.g. 'Story Name'
      //   title: string // e.g. 'package/Category'
      //   tags: string[]
      // }
      // @ts-expect-error Cannot annotate types here
      storySort: (a, b) => {
        if (a.type !== b.type) {
          // Bring docs first
          return a.type === 'docs' ? -1 : 1
        }
        const pathA = a.title.split('/')
        const pathB = b.title.split('/')
        const depthA = pathA.length + +(pathA[pathA.length - 1] !== a.name)
        const depthB = pathB.length + +(pathB[pathB.length - 1] !== b.name)
        if (depthA !== depthB) {
          // Bring shallow stories first
          return depthA - depthB
        }
        const orderA = +(
          // @ts-expect-error Cannot annotate types here
          a.tags.find(tag => tag.startsWith('order:'))?.split(':')[1] ?? 0
        )
        const orderB = +(
          // @ts-expect-error Cannot annotate types here
          b.tags.find(tag => tag.startsWith('order:'))?.split(':')[1] ?? 0
        )
        if (orderA !== orderB) {
          return orderA - orderB
        }
        return a.title.localeCompare(b.title, undefined, { numeric: true })
      }
    }
  },
  initialGlobals: {
    backgrounds: {
      value: 'dark'
    },
    gpuMeter: 'off',
    ground: 'bare',
    water: 'look'
  },
  // Dev tooling: per-pass GPU timings over every WebGPU clouds story. Off
  // leaves the device untouched. `?globals=gpuMeter:on` turns it on by URL
  globalTypes: {
    ...(showcase
      ? {}
      : {
          gpuMeter: {
            description: 'GPU meter: per-pass GPU ms, raw and clock-corrected',
            toolbar: {
              title: 'GPU meter',
              icon: 'timer',
              items: [
                { value: 'off', title: 'GPU meter off' },
                { value: 'on', title: 'GPU meter on' }
              ],
              dynamicTitle: true
            }
          }
        }),
    // Real terrain under the WebGPU clouds stories. `?globals=ground:fuji`
    // sets it by URL
    ground: {
      description: 'Ground: bare ellipsoid, ocean, or 3D tiles at a location',
      toolbar: {
        title: 'Ground',
        icon: 'globe',
        items: [
          { value: 'bare', title: 'Bare ellipsoid (story pose)' },
          ...(oceanAvailable
            ? [
                {
                  value: 'ocean',
                  title: 'Ocean: three-ocean-waves (story pose)'
                }
              ]
            : []),
          ...Object.entries(GROUND_LOCATIONS).map(([value, { title }]) => ({
            value,
            title: `3D tiles: ${title}`
          }))
        ],
        dynamicTitle: true
      }
    },
    // The ocean ground's water body, live. Ignored by every other ground
    ...(oceanAvailable
      ? {
          water: {
            description: 'Water body of the ocean ground',
            toolbar: {
              title: 'Water',
              icon: 'paintbrush',
              items: Object.entries(WATER_BODIES).map(([value, { title }]) => ({
                value,
                title
              })),
              dynamicTitle: true
            }
          }
        }
      : {})
  },
  argTypesEnhancers: showcase
    ? [context => showcaseArgTypes(context.argTypes)]
    : [],
  decorators: [
    (Story, context) => {
      const value: unknown = context.globals.ground
      const ground = isGroundValue(value) ? value : 'bare'
      const waterValue: unknown = context.globals.water
      const water = isWaterBody(waterValue) ? waterValue : 'look'
      useLayoutEffect(() => {
        getDefaultStore().set(groundAtom, ground)
        getDefaultStore().set(waterAtom, water)
      }, [ground, water])
      return <Story />
    },
    (Story, context) => {
      const on =
        !showcase &&
        context.globals.gpuMeter === 'on' &&
        !context.title.startsWith('clouds-webgl/')
      useEffect(() => {
        gpuMeter.setEnabled(on)
      }, [on])
      // Dev-only handle so a script can read the meter: snapshot()
      if (import.meta.env.DEV) {
        ;(window as unknown as { __gpuMeter?: unknown }).__gpuMeter = gpuMeter
      }
      return (
        <>
          <Story />
          {on && <GpuMeterOverlay />}
        </>
      )
    },
    // The WebGL reference stories keep their controls in a leva panel, one
    // store per story (upstream's decorator). `h` hides it, and `?hidePanel=1`
    // hides it for scripted captures. The WebGPU stories use Storybook args
    (Story, context) => {
      const store = useCreateStore()
      // Dev-only handle so a script can drive the reference stories' knobs
      // (scripts/perf.mjs A/B decompositions): store.setValueAtPath(path, value)
      if (import.meta.env.DEV) {
        ;(window as unknown as { __levaStore?: unknown }).__levaStore = store
      }
      const [hidden, setHidden] = useState(
        () =>
          new URLSearchParams(window.location.search).get('hidePanel') === '1'
      )
      useKey(
        event => event.target === document.body && event.key === 'h',
        () => {
          setHidden(value => !value)
        }
      )
      if (!context.title.startsWith('clouds-webgl/')) {
        return <Story />
      }
      return (
        <LevaStoreProvider store={store}>
          <LevaPanel store={store} hidden={hidden} />
          <Story />
        </LevaStoreProvider>
      )
    }
  ]
}

export default preview
