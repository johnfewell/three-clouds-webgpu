// Opt-in visibility: every experimental option measured as an image delta at one
// fixed pose, judged against its OWN off-vs-off noise bracket
//
// Green unit tests, green gates, a WGSL snapshot and a graph digest are all
// compatible with an option that renders nothing. `compileWGSL` on a bare pass
// node is an 814-byte stub, so the composite path stays out of unit reach

import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import type { Vector3 } from 'three'
import type { ExperimentalCloudOptions } from 'three-clouds-webgpu'

import { test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// The built library, at the path the vite dev server serves it on with its bare
// specifiers rewritten. The page gets the SAME module instance the harness app
// runs, so these arms reach `applyCloudTypePreset` and `createCloudTypeMap`
const LIB_URL = '/node_modules/three-clouds-webgpu/build/index.js'

// One pose for every option: 12 km up, looking level east. A wide sky band, and
// far enough downrange for `distantCloudShadows` to reach its 87-100 km range
const CASE_NAME = 'sky-horizon-low-sun'

// Pinned, and identical on all three arms: a moving clock would grow the
// off-vs-off bracket until every option passed. t is not 0, so the
// `evolvingWeather` clock has moved off its start
const PINNED_TIME = 12.5
const PINNED_FRAME = 0

// Identical on every arm, from cold history. Temporal accumulation is why the
// off arm needs a bracket at all, and an off arm warmed differently from the on
// arm would measure the warm-up rather than the flag
const WARMUP = 32

// How far past its own noise floor an option has to land. The floor is measured
// per option, so this is a ratio and not a hard-coded pixel threshold
const NOISE_FACTOR = 4

// An option that lands under this has moved nothing a human could see, whatever
// its ratio to a near-zero floor says. The smallest measured on-arm delta sits
// three orders of magnitude above it, and the hardware numbers are in the PR
const ABSOLUTE_FLOOR = 1e-4

interface Comparison {
  count: number
  rmse: number
  relativeRmse: number
  meanAbs: number
  maxAbs: number
  changedFrac: number
}

interface OptionMeasurement {
  option: string
  note: string
  /** Set when the option is excluded, with the reason it is inert here */
  documentedInert: string | null
  /** Off arm 1 against off arm 2: this configuration's own noise */
  noise: Comparison
  /** Off arm 1 against the flag-on arm: what the option did */
  delta: Comparison
  cloudFractions: [number, number, number]
  blankOffArm: boolean
  enabled: boolean
  thrown: string | null
  errors: string[]
}

test.beforeEach(async ({ page }) => {
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }))
  await page.route('**/stars.bin', route =>
    route.fulfill({
      path: fileURLToPath(
        new URL(
          '../../../node_modules/@takram/three-atmosphere/assets/stars.bin',
          import.meta.url
        )
      )
    })
  )
})

test('every opt-in visual option moves the image past its own noise bracket', async ({
  page
}) => {
  test.setTimeout(900_000)
  await page.goto(`/?case=${CASE_NAME}&e2e=1&w=640&h=360`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )

  // Arm order is off, off, ON, and every row starts from the harness's own
  // state. The preset arms mutate coverage, the lanes and the sun, so they run
  // LAST, or a later row would be measured on a preset sky
  const measurements = (await page.evaluate(
    async ({ libUrl, time, frame, warmup }) => {
      const p = (window as ParityWindow).__parity
      const ctx = p.sideBHandle!.cloudsContext
      const lib = (await import(libUrl)) as {
        applyCloudTypePreset: (
          target: unknown,
          name: string
        ) => { coverage: number }
        applyScenePreset: (
          target: unknown,
          name: string,
          request: {
            date: Date | number
            location: { longitude: number; latitude: number }
            sinks: unknown
          }
        ) => unknown
        CloudLayers: { DEFAULT: Parameters<typeof ctx.cloudLayers.copy>[0] }
        flashPositionCPU: (
          index: number,
          seed: number,
          bottomRadius: number,
          altitude: number
        ) => Vector3
        createCloudTypeMap: (options?: {
          size?: number
          cells?: number
          seed?: number
        }) => Parameters<typeof ctx.cloudTypes.setMap>[0]
      }
      // What the harness itself installed at setup (sideB.ts:258), captured
      // before any row runs, so a row that clears it can put it back
      const harnessWeather = ctx.localWeatherTexture
      // The shape knobs are magnitudes, not flags: each row resets them here so
      // no row inherits another's, then sets its own in arm()
      const neutralShape = { ...ctx.cloudShape }

      type Flag = keyof ExperimentalCloudOptions
      interface OptionRow {
        id: string
        // null means the arm IS the setting, not a flag
        flag: Flag | null
        note: string
        // Set when the option cannot act here. The row is still measured, and
        // the assertions then require it to stay inside its own bracket
        documentedInert?: string
        // The off arms have no weather map, so they have no clouds by
        // construction. Only the on arm may hold cloud pixels
        blankOffArm?: boolean
        // Applied to ALL THREE arms, so the flag is the only difference
        prepare?: () => void
        arm?: () => void
        // After the on arm. A row that moves the HARNESS state and not the
        // context's own settings decides the next row's off arms otherwise,
        // and the next row cannot see that it did
        restore?: () => void
      }

      const rows: OptionRow[] = [
        {
          id: 'convectiveProfile',
          flag: 'convectiveProfile',
          note: 'anvil shoulder plus coverage concentration, shipped defaults'
        },
        {
          id: 'moonlight',
          flag: 'moonlight',
          note: 'the march light handed to the moon, sun 30 degrees down',
          // Every case here runs with the sun up, where the option is inert by
          // construction, so all THREE arms get the sun and the moon below and
          // the flag is still the only difference between them
          prepare: () => {
            setSun(-30, 135)
            // Up at the observer, and a unit vector across it, so the moon can
            // be placed by hand with no constructor in the page
            const cam = ctx.cameraUniforms.cameraPositionECEF.value
            const len = Math.hypot(cam.x, cam.y, cam.z) || 1
            const ux = cam.x / len
            const uy = cam.y / len
            const uz = cam.z / len
            // up x (0,0,1), normalized
            const across = Math.hypot(uy, ux) || 1
            const rx = uy / across
            const ry = -ux / across
            // 50 degrees up, on the azimuth opposite the sun's, which is a
            // nearly full moon: the elongation is what sets the phase
            const up = Math.cos((50 * Math.PI) / 180)
            const side = Math.sin((50 * Math.PI) / 180)
            ctx.moonDirection.set(
              up * ux - side * rx,
              up * uy - side * ry,
              up * uz
            )
            ctx.moonGain = 4e5
          },
          // sky-horizon-low-sun's own sun (cases/index.ts SUN_LOW), or the
          // next row's off arms run 30 degrees down and read almost nothing
          restore: () => setSun(10, 180)
        },
        {
          id: 'proceduralWeather',
          flag: 'proceduralWeather',
          note: 'seeded compute weather map where there was none',
          blankOffArm: true,
          // syncProceduralWeather returns early when a caller has set
          // localWeatherTexture, and sideB.ts:258 always has, so the flag is a
          // no-op until that texture is cleared: off is then a sky with no map
          prepare: () => {
            ctx.localWeatherTexture = null
          }
        },
        {
          id: 'evolvingWeather',
          flag: 'evolvingWeather',
          note: 'time-driven flow map and life cycles'
        },
        {
          id: 'cloudTypeMap',
          flag: 'cloudTypeMap',
          note: 'per-location morph over a two-cell map',
          // docs/EXPERIMENTAL.md: "Nothing happens until
          // context.cloudTypes.setMap() is called". So the map goes on every
          // arm and the flag activates it. Two cells, so regions stay large
          prepare: () => {
            ctx.cloudTypes.setMap(lib.createCloudTypeMap({ cells: 2, seed: 3 }))
          }
        },
        {
          id: 'directionalSkylight',
          flag: 'directionalSkylight',
          note: 'two-lobe skylight, low sun over a level horizon',
          // docs/EXPERIMENTAL.md keeps it opt-in because "cloudsPass.composite()
          // throws while building the whole pass graph". Asserting the other way
          // round makes this exclusion self-revoking: the day it works, it fails
          documentedInert:
            'documented opt-in only: composite() throws with it on, and its ' +
            'measured delta sits inside its own off-vs-off bracket'
        },
        {
          id: 'distantCloudShadows',
          flag: 'distantCloudShadows',
          note: 'zero-step sun-march fallback read from the shadow map',
          // docs/EXPERIMENTAL.md: inert at defaults, acting only beyond ~87-100
          // km and only where the sun march takes zero steps. Both are
          // settings, so both go on every arm and the flag is the only change
          prepare: () => {
            p.setShadow(true)
            ctx.clouds.maxIterationCountToSun = 0
          }
        },
        {
          id: 'cloudShape.baseShadow',
          flag: null,
          note: 'Beer extinction of the cloud above a shaded sample',
          prepare: () => {
            ctx.cloudShape = { ...neutralShape }
          },
          arm: () => {
            ctx.cloudShape = { ...neutralShape, baseShadowStrength: 1.6 }
          }
        },
        {
          id: 'cloudShape.horizonCoverage',
          flag: null,
          note: 'coverage added with distance from the camera',
          prepare: () => {
            ctx.cloudShape = { ...neutralShape }
          },
          arm: () => {
            ctx.cloudShape = {
              ...neutralShape,
              horizonCoverageAmount: 0.35,
              horizonCoverageStart: 4000,
              horizonCoverageRamp: 30000
            }
          }
        },
        {
          id: 'cloudShape.windSkew',
          flag: null,
          note: 'shape lookup leaned east and north by height',
          prepare: () => {
            ctx.cloudShape = { ...neutralShape }
          },
          arm: () => {
            ctx.cloudShape = { ...neutralShape, windSkewEast: 320 }
          }
        },
        {
          id: 'cloudShape.erosionShape',
          flag: null,
          note: 'shape carve scaled above 1 for thinner edges',
          prepare: () => {
            ctx.cloudShape = { ...neutralShape }
          },
          arm: () => {
            ctx.cloudShape = { ...neutralShape, erosionShape: 1.2 }
          }
        },
        {
          id: 'lightning',
          flag: 'lightning',
          note: 'a point source inside the deck, six-step march toward it',
          // The flash is STATE, not a flag, so the off arms have to be told to
          // hold none. prepare runs before both off arms, and the on arm's
          // ctx.experimental assignment cannot clear it
          prepare: () => {
            ctx.lightning = null
          },
          // Seed 142408 puts the strike 28 km from the point below the camera,
          // 20 degrees under the level view and inside the 50 degree frame, on
          // the shell at flashPositionCPU's 1600 m, i.e. inside the deck
          arm: () => {
            ctx.lightning = {
              position: lib.flashPositionCPU(0, 142408, 6378137, 1600),
              // Radiance over distance squared, in metres, so the scale is the
              // square of a flash's range: 1e9 puts the core near the strike
              // about 7 units of in-scatter and the deck 30 km out about 0.2
              intensity: 1e9,
              // The camera's own Vector3, cloned and set, because the state
              // wants three vectors and this page shares one three with the lib
              colour: p.sideBHandle!.camera.position.clone().set(0.85, 0.9, 1)
            }
          }
        },
        {
          id: 'cloudEnvironment',
          flag: 'cloudEnvironment',
          note: 'a cube map of the sky plus this cloud march',
          // docs/EXPERIMENTAL.md: the map reaches a scene through
          // scene.environmentNode, and this harness paints every pixel from the
          // cloud composite, so nothing here samples it
          documentedInert:
            'no consumer in this scene reads cloudsPass.environment, so the ' +
            'bake changes no pixel and its delta must stay inside the bracket'
        },
        {
          id: 'cloudTypePreset:overcastSheet',
          flag: null,
          note: 'coverage 0.92 over the default 0.3, a high translucent sheet',
          // The default sky is fair-weather, so coverage 0.92 as one high sheet
          // is further from it than any other preset in the table
          arm: () => {
            lib.applyCloudTypePreset(ctx, 'overcastSheet')
          }
        },
        {
          id: 'scenePreset:hazy',
          flag: null,
          note: 'a whole scene: the haze layer on, and the sun at local noon',
          // The previous row leaves its overcast sky behind, so put the default
          // sky back: CloudLayers.DEFAULT, not cloudLayers.reset(), which copies
          // CloudLayer.DEFAULT into every lane and leaves the off arms cloudless
          prepare: () => {
            ctx.coverage = 0.3
            ctx.haze = false
            ctx.cloudLayers.copy(lib.CloudLayers.DEFAULT)
          },
          // No flag: a scene preset is a helper, not an option. It writes cloud
          // type, coverage, haze and the sun, so the sun is part of the delta
          arm: () => {
            lib.applyScenePreset(ctx, 'hazy', {
              date: new Date('2026-10-04T12:00:00Z'),
              location: { longitude: 0, latitude: 0 },
              sinks: [{ sunDirection: ctx.sunDirection }]
            })
          }
        }
      ]

      // The harness's own sun. A row that moves it moves the ATMOSPHERE's too,
      // which no context setting puts back
      const setSun = (elevation: number, azimuth: number): void => {
        const handle = (
          window as unknown as {
            __parity: {
              sideBHandle: { setSun: (e: number, a: number) => void }
            }
          }
        ).__parity.sideBHandle
        handle.setSun(elevation, azimuth)
      }

      const allOff = (): Partial<ExperimentalCloudOptions> => {
        const next = { ...ctx.experimental }
        for (const key of Object.keys(next) as Flag[]) next[key] = false
        return next
      }

      const compare = (a: Float32Array, b: Float32Array) => {
        let error = 0
        let energy = 0
        let abs = 0
        let max = 0
        let changed = 0
        for (let i = 0; i < a.length; i++) {
          const delta = a[i]! - b[i]!
          error += delta * delta
          energy += a[i]! * a[i]!
          abs += Math.abs(delta)
          if (Math.abs(delta) > max) max = Math.abs(delta)
          if (Math.abs(delta) > 1e-4) changed++
        }
        return {
          count: a.length,
          rmse: Math.sqrt(error / a.length),
          relativeRmse: Math.sqrt(error / Math.max(energy, 1e-12)),
          meanAbs: abs / a.length,
          maxAbs: max,
          changedFrac: changed / a.length
        }
      }

      const shoot = async (): Promise<{
        plate: Float32Array
        clouds: number
      }> => {
        await p.renderOnce('B', { time, frame, warmup, resetHistory: true })
        const layer = await p.readLayer()
        let occupied = 0
        for (let i = 3; i < layer.data.length; i += 4)
          if (layer.data[i]! > 0) occupied++
        return {
          plate: (await p.readLinear('B')).data,
          clouds: occupied / (layer.data.length / 4)
        }
      }

      const out: Array<Record<string, unknown>> = []
      for (const row of rows) {
        try {
          // Every row starts from the harness state, so one row's leftovers
          // cannot become the next row's off arm
          ctx.localWeatherTexture = harnessWeather
          row.prepare?.()
          ctx.experimental = allOff()
          const offA = await shoot()
          // The same assignment as arm 1, so this arm measures the harness
          // repeating itself rather than a rebuild
          ctx.experimental = allOff()
          const offB = await shoot()
          row.arm?.()
          const on = allOff()
          if (row.flag != null) on[row.flag] = true
          ctx.experimental = on
          const onArm = await shoot()
          out.push({
            option: row.id,
            note: row.note,
            documentedInert: row.documentedInert ?? null,
            noise: compare(offA.plate, offB.plate),
            delta: compare(offA.plate, onArm.plate),
            cloudFractions: [offA.clouds, offB.clouds, onArm.clouds],
            blankOffArm: row.blankOffArm === true,
            enabled: row.flag == null ? true : ctx.experimental[row.flag],
            thrown: null,
            errors: [...p.errors]
          })
          row.restore?.()
        } catch (error) {
          // One option that throws must not hide the other six readings
          out.push({
            option: row.id,
            note: row.note,
            documentedInert: row.documentedInert ?? null,
            noise: null,
            delta: null,
            cloudFractions: [0, 0, 0],
            blankOffArm: row.blankOffArm === true,
            enabled: false,
            thrown: error instanceof Error ? error.message : String(error),
            errors: [...p.errors]
          })
        }
      }
      return out
    },
    {
      libUrl: LIB_URL,
      time: PINNED_TIME,
      frame: PINNED_FRAME,
      warmup: WARMUP
    }
  )) as unknown as OptionMeasurement[]

  expect(measurements.length).toBeGreaterThan(0)
  for (const m of measurements) {
    if (m.thrown != null) {
      console.log(`[opt-in visibility] ${m.option} | THREW: ${m.thrown}`)
      continue
    }
    console.log(
      `[opt-in visibility] ${m.option} | ${m.note}` +
        `${m.documentedInert == null ? '' : ' | EXCLUDED'}\n` +
        `    noise rmse ${m.noise.rmse.toExponential(3)} rel ` +
        `${m.noise.relativeRmse.toExponential(3)} changed ` +
        `${(m.noise.changedFrac * 100).toFixed(4)}%\n` +
        `    delta rmse ${m.delta.rmse.toExponential(3)} rel ` +
        `${m.delta.relativeRmse.toExponential(3)} changed ` +
        `${(m.delta.changedFrac * 100).toFixed(3)}% meanAbs ` +
        `${m.delta.meanAbs.toExponential(3)} maxAbs ` +
        `${m.delta.maxAbs.toExponential(3)} ratio ` +
        `${(m.delta.rmse / Math.max(m.noise.rmse, 1e-12)).toFixed(1)}x\n` +
        `    cloud fraction ${m.cloudFractions.map(f => f.toFixed(5)).join(' / ')}` +
        ` | enabled ${m.enabled} | errors ${JSON.stringify(m.errors)}`
    )
  }

  // A row that measured is a row that did not throw. Five options must clear
  // their bracket on their own, so losing one to an exclusion is a failure
  const active = measurements.filter(
    m => m.thrown == null && m.documentedInert == null
  )
  expect(
    active.length,
    'fewer than five options were measured as active'
  ).toBeGreaterThanOrEqual(5)
  for (const m of measurements) {
    expect(m.thrown, `${m.option} threw: ${m.thrown}`).toBeNull()
    expect(m.errors, `${m.option} logged errors`).toEqual([])
    expect(m.enabled, `${m.option} did not read back as on`).toBe(true)
    const onArmClouds = m.cloudFractions[2]
    expect(onArmClouds, `${m.option} rendered an empty on arm`).toBeGreaterThan(
      0
    )
    if (!m.blankOffArm)
      for (const [index, fraction] of m.cloudFractions.entries())
        expect(
          fraction,
          `${m.option} off arm ${index} rendered no clouds`
        ).toBeGreaterThan(0)
    if (m.documentedInert != null) {
      // Self-revoking exclusion: still inside the bracket, or the documented
      // reason is out of date and the option belongs in the active set
      expect(
        m.delta.rmse,
        `${m.option} is excluded as inert but measured ` +
          `${m.delta.rmse.toExponential(3)} against a bracket of ` +
          `${m.noise.rmse.toExponential(3)}. Drop the exclusion`
      ).toBeLessThanOrEqual(m.noise.rmse * NOISE_FACTOR)
      continue
    }
    expect(
      m.delta.rmse,
      `${m.option} did not clear its noise bracket`
    ).toBeGreaterThan(m.noise.rmse * NOISE_FACTOR)
    expect(
      m.delta.rmse,
      `${m.option} moved the plate below the visibility floor`
    ).toBeGreaterThan(ABSOLUTE_FLOOR)
  }
})
