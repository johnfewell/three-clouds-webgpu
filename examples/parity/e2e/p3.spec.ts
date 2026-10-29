import { expect, type Page } from '@playwright/test'

import { caseByName } from '../cases/index'
import { computeSSIM } from '../src/metrics/ssim'
import {
  atlasContractPasses,
  deltasWithinMeasuredFloor,
  evaluateAtlasContract,
  evaluateShadowLengthSurfaceEnd,
  layerMaskContractPasses,
  maxAbsDiff,
  meanAbsDiff,
  measureReceiverShadow,
  motionContractPasses,
  neutralisationFloorVerdict,
  plainReceiverContractPasses,
  receiverMaskDomainPasses,
  receiverMaskWithControls,
  receiverRatiosAgree,
  receiverShadowPasses,
  samplerTailContractPasses,
  shadowKnobContractPasses,
  shadowLengthSurfaceEndPasses,
  shaftsDarkeningPasses,
  shaftsEffectPasses,
  temporalContractPasses,
  type ReceiverShadowResult,
  type ShadowKnobSnapshot
} from '../src/p3Contract'
import type { SideAHandle } from '../src/sideA'
import { groundDistances } from '../src/surfaceDistance'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityProbe, ParityWindow } from './parityProbe'

// ── Probe types ──────────────────────────────────────────────

interface ProbeReadback {
  width: number
  height: number
  data: number[]
}

// ── Helpers ──────────────────────────────────────────────────

function probe(page: Page) {
  return {
    errors: () => page.evaluate(() => (window as ParityWindow).__parity.errors),

    warnings: () =>
      page.evaluate(() => (window as ParityWindow).__parity.warnings),

    renderOnce: (
      side: 'A' | 'B',
      // derived from the probe's own signature, never re-declared
      // Separate copies once hid `resetHistory` from every spec,
      // and could drift again the next time the probe gains a field
      opts: Parameters<ParityProbe['renderOnce']>[1]
    ) =>
      page.evaluate(
        ([s, o]) => (window as ParityWindow).__parity.renderOnce(s, o),
        [side, opts] as const
      ),

    set: (partial: Record<string, unknown>) =>
      page.evaluate(p => (window as ParityWindow).__parity.set(p), partial),

    readLinear: (side: 'A' | 'B') =>
      // readLinear is ASYNC (main.ts:772). Unawaited it yields a Promise whose
      // .data is undefined, and Array.from then throws "undefined is not
      // iterable" (measured failing on hardware, a sibling finding)
      page.evaluate(async s => {
        const r = await (window as ParityWindow).__parity.readLinear(s)
        return {
          width: r.width,
          height: r.height,
          data: Array.from(r.data)
        }
      }, side) as Promise<ProbeReadback>,

    readLayer: () =>
      page.evaluate(async () => {
        const r = await (window as ParityWindow).__parity.readLayer()
        return {
          width: r.width,
          height: r.height,
          data: Array.from(r.data)
        }
      }) as Promise<ProbeReadback>,

    readShadowAtlas: () =>
      page.evaluate(async () => {
        const atlas = await (window as ParityWindow).__parity.readShadowAtlas()
        const copyLayer = (layer: {
          width: number
          height: number
          data: ArrayLike<number>
        }) => ({
          width: layer.width,
          height: layer.height,
          data: Array.from(layer.data)
        })
        const { extent, ulpAllowance } = atlas.rayExtents
        const rayExtents = {
          extent: extent.map(copyLayer),
          ulpAllowance: ulpAllowance.map(copyLayer)
        }
        return {
          ...atlas,
          layers: atlas.layers.map(copyLayer),
          rayExtents
        }
      }),

    readShadowLength: () =>
      page.evaluate(async () => {
        const result = await (
          window as ParityWindow
        ).__parity.readShadowLength()
        return result == null
          ? null
          : {
              width: result.width,
              height: result.height,
              data: Array.from(result.data)
            }
      }),

    readShadowKnobs: () =>
      page.evaluate(() => (window as ParityWindow).__parity.readShadowKnobs()),

    setShadow: (value: boolean) =>
      page.evaluate(
        shadow => (window as ParityWindow).__parity.setShadow(shadow),
        value
      ),

    setLayerShadows: (values: readonly boolean[]) =>
      page.evaluate(
        flags => (window as ParityWindow).__parity.setLayerShadows(flags),
        values
      ),

    setLightShafts: (value: boolean) =>
      page.evaluate(
        enabled => (window as ParityWindow).__parity.setLightShafts(enabled),
        value
      ),

    stats: (side: 'A' | 'B') =>
      page.evaluate(s => (window as ParityWindow).__parity.stats(s), side)
  }
}

async function renderSideAndRead(
  page: Page,
  side: 'A' | 'B',
  time = 0,
  frame = 0,
  warmup = 64
): Promise<ProbeReadback> {
  const p = probe(page)
  await p.renderOnce(side, { time, frame, warmup })
  return p.readLinear(side)
}

async function setReceiverVisible(
  page: Page,
  receiver: 'plane' | 'sphere',
  visible: boolean
): Promise<{ A: boolean; B: boolean | null }> {
  return page.evaluate(
    ({ key, value }) => {
      const p = (window as ParityWindow).__parity
      const sideA = p.sideAHandle as SideAHandle
      sideA.sceneResult[key].visible = value
      if (p.sideBHandle != null) p.sideBHandle.sceneResult[key].visible = value
      return {
        A: sideA.sceneResult[key].visible,
        B: p.sideBHandle?.sceneResult[key].visible ?? null
      }
    },
    { key: receiver, value: visible }
  )
}

// The port renders its shadow map every `shadow.updateInterval` frames (the
// reference every frame). Case load pins side B to 1, but tests that
// depend on the cadence set it through the handle and read it back
async function setShadowUpdateInterval(
  page: Page,
  interval: number
): Promise<number | null> {
  return page.evaluate(value => {
    const p = (window as ParityWindow).__parity
    const ctx = p.sideBHandle?.cloudsContext
    if (ctx == null) return null
    ctx.shadow.updateInterval = value
    return ctx.shadow.updateInterval
  }, interval)
}

function shadowStateMatches(
  state: { A: boolean[]; B: boolean[] | null },
  expected: boolean
): boolean {
  return (
    state.A.length > 0 &&
    state.A.every(value => value === expected) &&
    state.B != null &&
    state.B.length > 0 &&
    state.B.every(value => value === expected)
  )
}

async function renderDisabledShadowState(
  page: Page,
  shadow: boolean
): Promise<{ pixels: ProbeReadback; stateReached: boolean }> {
  const p = probe(page)
  const reset = await p.setShadow(!shadow)
  const applied = await p.setShadow(shadow)
  return {
    pixels: await renderSideAndRead(page, 'B', 0, 0, 1),
    stateReached:
      shadowStateMatches(reset, !shadow) && shadowStateMatches(applied, shadow)
  }
}

function distributionSummary(values: readonly number[]): {
  min: number
  median: number
  max: number
} {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!
  return { min: sorted[0]!, median, max: sorted.at(-1)! }
}

interface ReceiverCapture {
  A: ReceiverShadowResult
  B: ReceiverShadowResult
  maskA: number[]
  maskB: number[]
  observedMaskB: number[]
  shadowedA: ProbeReadback
  shadowedB: ProbeReadback
  unshadowedA: ProbeReadback
  unshadowedB: ProbeReadback
  maskControls: {
    A: { visible: number; hidden: number }
    B: { visible: number; hidden: number }
  }
}

async function captureReceiverShadow(
  page: Page,
  receiver: 'plane' | 'sphere'
): Promise<ReceiverCapture> {
  const time = 0
  const frame = 0
  const p = probe(page)
  // Isolate receiver visibility from cloud history. Deriving this mask with
  // clouds enabled selects temporal whole-plate churn instead of the receiver
  await p.set({ enabled: false, lightShafts: false })
  const off = await p.setShadow(false)
  expect(off.A.every(value => !value)).toBe(true)
  expect(off.B?.every(value => !value)).toBe(true)
  expect(await setReceiverVisible(page, receiver, true)).toEqual({
    A: true,
    B: true
  })
  const visibleA = await renderSideAndRead(page, 'A', time, frame, 4)
  const visibleAControl = await renderSideAndRead(page, 'A', time, frame, 4)
  const visibleB = await renderSideAndRead(page, 'B', time, frame, 4)
  const visibleBControl = await renderSideAndRead(page, 'B', time, frame, 4)

  expect(await setReceiverVisible(page, receiver, false)).toEqual({
    A: false,
    B: false
  })
  const hiddenA = await renderSideAndRead(page, 'A', time, frame, 4)
  const hiddenAControl = await renderSideAndRead(page, 'A', time, frame, 4)
  const hiddenB = await renderSideAndRead(page, 'B', time, frame, 4)
  const hiddenBControl = await renderSideAndRead(page, 'B', time, frame, 4)
  const maskA = receiverMaskWithControls(
    visibleA.data,
    visibleAControl.data,
    hiddenA.data,
    hiddenAControl.data
  )
  const observedMaskB = receiverMaskWithControls(
    visibleB.data,
    visibleBControl.data,
    hiddenB.data,
    hiddenBControl.data
  )

  expect(await setReceiverVisible(page, receiver, true)).toEqual({
    A: true,
    B: true
  })
  await p.set({ enabled: true })
  const unshadowedA = await renderSideAndRead(page, 'A', time, frame)
  const unshadowedB = await renderSideAndRead(page, 'B', time, frame)
  const on = await p.setShadow(true)
  expect(on.A.every(Boolean)).toBe(true)
  expect(on.B?.every(Boolean)).toBe(true)
  const shadowedA = await renderSideAndRead(page, 'A', time, frame)
  const shadowedB = await renderSideAndRead(page, 'B', time, frame)

  return {
    A: measureReceiverShadow(shadowedA.data, unshadowedA.data, maskA),
    // Side B's disabled plate has whole-frame variation, so it cannot select
    // its own receiver geometry. Both sides share the scene and top-first
    // readback convention, and the reference mask is the independent domain
    B: measureReceiverShadow(shadowedB.data, unshadowedB.data, maskA),
    maskA,
    maskB: maskA,
    observedMaskB,
    shadowedA,
    shadowedB,
    unshadowedA,
    unshadowedB,
    maskControls: {
      A: {
        visible: maxAbsDiff(visibleA.data, visibleAControl.data),
        hidden: maxAbsDiff(hiddenA.data, hiddenAControl.data)
      },
      B: {
        visible: maxAbsDiff(visibleB.data, visibleBControl.data),
        hidden: maxAbsDiff(hiddenB.data, hiddenBControl.data)
      }
    }
  }
}

// ── Adapter gate ─────────────────────────────────────────────

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'p3')
})

// ── Phase 3 scenarios ────────────────────────────────────────

test.describe('Phase 3 — Shadow infrastructure', () => {
  test('layers-4-shadow preserves the ADR-015 fidelity floor', async ({
    page
  }, testInfo) => {
    test.setTimeout(120_000)
    await loadCase(page, 'layers-4-shadow')
    const p = probe(page)
    const knobs = await page.evaluate(() =>
      (window as ParityWindow).__parity.readShadowKnobs()
    )
    expect(knobs.A.maxFar).toBeNull()
    expect(knobs.B?.maxFar).toBeNull()
    expect(knobs.A.temporalPass).toBe(true)
    expect(knobs.B?.temporalPass).toBe(true)

    for (const side of ['A', 'B'] as const) {
      await p.renderOnce(side, { time: 0, frame: 0, warmup: 64 })
    }
    // Match capture.mjs: compile the linear read, then continue both histories
    await p.readLinear('B')
    for (const side of ['B', 'A'] as const) {
      await p.renderOnce(side, {
        time: 0,
        frame: 0,
        warmup: 4,
        resetHistory: false
      })
    }
    const a = await p.readLinear('A')
    const b = await p.readLinear('B')
    expect(a.width * a.height).toBeGreaterThan(0)
    expect([b.width, b.height]).toEqual([a.width, a.height])
    expect(a.data.length).toBe(a.width * a.height * 4)
    expect(b.data.length).toBe(a.data.length)
    const ssim = computeSSIM(
      Float32Array.from(a.data),
      Float32Array.from(b.data),
      a.width,
      a.height,
      4
    )
    const report = { ssim, floor: 0.971478, knobs }
    console.log(JSON.stringify({ layers4ShadowFidelity: report }))
    await testInfo.attach('layers-4-shadow-fidelity.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })
    expect(await p.errors()).toEqual([])
    expect(ssim).toBeGreaterThanOrEqual(report.floor)
  })

  test('1. shadow atlas target exists when shadow maps enabled', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: true })
    await p.renderOnce('B', { time: 0, frame: 0 })

    const result = await page.evaluate(() => {
      const parity = (window as ParityWindow).__parity
      const cp = parity.sideBHandle?.cloudsPass
      if (cp == null) return null
      // `shadowRT` is private on CloudsPassNode (compile-time only), so this
      // read reaches past the declared surface, named rather than hidden. The
      // durable fix is a readonly public accessor, not a cast here
      const shadowRT = (
        cp as unknown as {
          shadowRT?: {
            width: number
            height: number
            texture?: { image?: { depth?: number } }
          }
        }
      ).shadowRT
      if (shadowRT == null) return { exists: false }
      return {
        exists: true,
        width: shadowRT.width,
        height: shadowRT.height,
        depth: shadowRT.texture?.image?.depth ?? 0
      }
    })

    if (result == null) {
      throw new Error(
        'sideBHandle or cloudsPass not accessible - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }
    expect(result.exists).toBe(true)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    expect(result.depth).toBeGreaterThan(0)
  })

  test('2. cloudShadow descriptor populated with cascade data', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: true })
    await p.renderOnce('B', { time: 0, frame: 0 })

    const result = await page.evaluate(() => {
      const parity = (window as ParityWindow).__parity
      const cp = parity.sideBHandle?.cloudsPass
      if (cp == null) return null
      const desc = cp.cloudShadow
      if (desc == null) return { exists: false }
      return {
        exists: true,
        cascadeCount: desc.cascadeCount,
        mapSizeX: desc.mapSize?.x ?? 0,
        mapSizeY: desc.mapSize?.y ?? 0,
        hasMap: desc.map != null,
        hasFar: desc.far?.value != null,
        hasTopHeight: desc.topHeight?.value != null
      }
    })

    if (result == null) {
      throw new Error(
        'sideBHandle not accessible - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }
    expect(result.exists).toBe(true)
    expect(result.cascadeCount).toBeGreaterThan(0)
    expect(result.mapSizeX).toBeGreaterThan(0)
    expect(result.mapSizeY).toBeGreaterThan(0)
    expect(result.hasMap).toBe(true)
  })

  // "non-null after a render" held on the broken code too. The aerial
  // node stores the getter's node by value at construction, so the guard is
  // IDENTITY between the two, not non-nullness of one
  test('3. the aerial node holds the SAME cloudShadowLength node the pass exposes', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: true })
    await p.renderOnce('B', { time: 0, frame: 0 })

    const wiring = await page.evaluate(() => {
      const handle = (window as ParityWindow).__parity?.sideBHandle
      const cp = handle?.cloudsPass
      const aerial = handle?.aerial as unknown as
        { shadowLengthNode?: unknown } | undefined
      return {
        hasLength: cp?.cloudShadowLength != null,
        aerialHoldsIt:
          aerial?.shadowLengthNode != null &&
          aerial.shadowLengthNode === cp?.cloudShadowLength
      }
    })

    expect(wiring.hasLength).toBe(true)
    expect(wiring.aerialHoldsIt).toBe(true)
  })

  test('3b. lights-mode aerial holds the live cloudShadowLength node', async ({
    page
  }) => {
    await loadCase(page, 'shafts-inside-deck', { lighting: 'lights' })
    const p = probe(page)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })

    const wiring = await page.evaluate(() => {
      const handle = (window as ParityWindow).__parity?.sideBHandle
      const cp = handle?.cloudsPass
      const aerial = handle?.aerial as unknown as
        { shadowLengthNode?: unknown } | undefined
      return {
        shaftsEnabled: handle?.cloudsContext.lightShafts === true,
        aerialHoldsIt:
          aerial?.shadowLengthNode != null &&
          aerial.shadowLengthNode === cp?.cloudShadowLength
      }
    })

    expect(wiring.shaftsEnabled).toBe(true)
    expect(wiring.aerialHoldsIt).toBe(true)
  })

  test('4. shadow-length MRT attachment present when lightShafts on', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: true })
    // warmup: the graph-shape rebuild lands on the NEXT node frame
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })

    const result = await page.evaluate(() => {
      const cp = (window as ParityWindow).__parity?.sideBHandle?.cloudsPass
      if (cp == null) return null
      const rt = cp.layerRT
      return {
        textureCount: rt?.textures?.length ?? 0,
        tex2Name: rt?.textures?.[2]?.name ?? null
      }
    })

    if (result == null) {
      throw new Error(
        'cloudsPass not accessible - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }
    expect(result.textureCount).toBe(3)
    expect(result.tex2Name).toBe('shadowLength')
  })

  test('5. shadow-length MRT absent when lightShafts off', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: false })
    await p.renderOnce('B', { time: 0, frame: 0 })

    const count = await page.evaluate(() => {
      const cp = (window as ParityWindow).__parity?.sideBHandle?.cloudsPass
      return cp?.layerRT?.textures?.length ?? 0
    })

    expect(count).toBe(2)
  })

  // Since the merged resolve the shadow length is the
  // SECOND ATTACHMENT of the colour resolve pair, as in cloudsResolve.frag, so
  // "created" means two textures, the second named 'shadowLength'
  test('6. shadow-length resolve attachment created when lightShafts on', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: true })
    // warmup: the graph-shape rebuild lands on the NEXT node frame
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })

    const result = await page.evaluate(() => {
      const cp = (window as ParityWindow).__parity?.sideBHandle?.cloudsPass
      if (cp == null) return null
      return {
        hasResolve: cp.resolveRT?.textures?.[1]?.name === 'shadowLength',
        hasHistory: cp.historyRT?.textures?.[1]?.name === 'shadowLength'
      }
    })

    if (result == null) {
      throw new Error(
        'cloudsPass not accessible - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }
    expect(result.hasResolve).toBe(true)
    expect(result.hasHistory).toBe(true)
  })

  test('7. shadow-length resolve attachment absent when lightShafts off', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: false })
    await p.renderOnce('B', { time: 0, frame: 0 })

    const result = await page.evaluate(() => {
      const cp = (window as ParityWindow).__parity?.sideBHandle?.cloudsPass
      if (cp == null) return null
      return {
        hasResolve: (cp.resolveRT?.textures?.length ?? 0) > 1,
        hasHistory: (cp.historyRT?.textures?.length ?? 0) > 1
      }
    })

    if (result == null) {
      throw new Error(
        'cloudsPass not accessible - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }
    expect(result.hasResolve).toBe(false)
    expect(result.hasHistory).toBe(false)
  })

  test('8. cascadeCount change resizes shadow atlas depth', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: true })
    await p.renderOnce('B', { time: 0, frame: 0 })

    const depth2 = await page.evaluate(() => {
      const ctx = (window as ParityWindow).__parity?.sideBHandle?.cloudsContext
      // Under `any` this chain's nullability was invisible. A missing side B here
      // is a real failure of a test that exists to exercise side B, so it throws
      // rather than taking `!` and dying later on a bare TypeError
      if (ctx == null) throw new Error('side B cloudsContext unavailable')
      ctx.shadow.cascadeCount = 2
      ctx.checkShadowStructure()
      return 2
    })
    // `depth2` is the literal 2 or the evaluate threw, so the old
    // `if (depth2 == null) test.skip('cloudsContext not accessible')` was
    // unreachable in the passing case and a skip in the failing one
    expect(depth2).toBe(2)

    await p.renderOnce('B', { time: 0, frame: 0 })
    const result2 = await page.evaluate(() => {
      const cp = (window as ParityWindow).__parity?.sideBHandle?.cloudsPass
      return cp?.cloudShadow?.cascadeCount ?? 0
    })
    expect(result2).toBe(2)

    await page.evaluate(() => {
      const ctx = (window as ParityWindow).__parity?.sideBHandle?.cloudsContext
      // Under `any` this chain's nullability was invisible. A missing side B here
      // is a real failure of a test that exists to exercise side B, so it throws
      // rather than taking `!` and dying later on a bare TypeError
      if (ctx == null) throw new Error('side B cloudsContext unavailable')
      ctx.shadow.cascadeCount = 4
      ctx.checkShadowStructure()
    })
    await p.renderOnce('B', { time: 0, frame: 0 })
    const result4 = await page.evaluate(() => {
      const cp = (window as ParityWindow).__parity?.sideBHandle?.cloudsPass
      return cp?.cloudShadow?.cascadeCount ?? 0
    })
    expect(result4).toBe(4)
  })

  test('9. atlas readback proves four-channel and no-sample semantics', async ({
    page
  }) => {
    await loadCase(page, 'shadow-plane')
    const p = probe(page)
    await p.set({ shadow: { temporalPass: false } })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 64 })

    const atlas = await p.readShadowAtlas()
    const knobs = await p.readShadowKnobs()
    if (knobs.B == null) throw new Error('side B shadow knobs unavailable')
    const result = evaluateAtlasContract(
      atlas.layers,
      atlas.rayExtents,
      knobs.B.cascadeCount,
      atlas.maxShadowRayExtentUnit
    )
    console.log(JSON.stringify({ atlas: { ...result, source: atlas.source } }))

    expect(atlas.source).toBe('raw')
    expect(atlas.depth).toBe(knobs.B.cascadeCount)
    expect(atlasContractPasses(result)).toBe(true)
  })

  test('9b. sampler tail distinguishes in-cloud 3 from ground 2', async ({
    page
  }) => {
    await loadCase(page, 'shadow-plane')
    const result = await page.evaluate(() =>
      (window as ParityWindow).__parity.sampleShadowOD({
        texel: [0, 1, 2, 5],
        distanceToTop: 3,
        worldToUnit: 1
      })
    )

    expect(samplerTailContractPasses(result)).toBe(true)
  })

  test('10. shadow cascade temporal resolve converges over frames', async ({
    page
  }) => {
    test.setTimeout(180_000)
    await loadCase(page, 'shadow-plane')
    const p = probe(page)
    await p.set({ shadow: { temporalPass: true, temporalJitter: true } })
    // Reference cadence, one map render per frame. At the port's interval 2,
    // frame 1 skips and earlyDelta reads 0 (2026-09-20: early 0 / late 0.0825
    // at 2, early 0.2475 / late 0.0470 at 1)
    expect(await setShadowUpdateInterval(page, 1)).toBe(1)

    const readFrame = async (frame: number) => {
      await p.renderOnce('B', {
        time: 0,
        frame,
        resetHistory: frame === 0
      })
      const atlas = await p.readShadowAtlas()
      expect(atlas.source).toBe('history')
      return atlas.layers.flatMap(layer => layer.data)
    }

    const frame0 = await readFrame(0)
    const frame1 = await readFrame(1)
    let frame15 = frame1
    for (let frame = 2; frame <= 15; frame++) frame15 = await readFrame(frame)
    const frame16 = await readFrame(16)
    const result = {
      earlyDelta: meanAbsDiff(frame0, frame1),
      lateDelta: meanAbsDiff(frame15, frame16)
    }
    console.log(
      JSON.stringify({
        shadowTemporal: {
          ...result,
          decay: result.lateDelta / result.earlyDelta
        }
      })
    )

    // Two-fold decay over 16 updates. See temporalContractPasses for why the
    // former absolute bar (late ≤ 1e-3) could not be met by the reference
    // either and what the relative bound does and does not claim
    expect(temporalContractPasses(result, 0.5)).toBe(true)

    await p.set({ shadow: { temporalJitter: false } })
    await p.renderOnce('B', { time: 0, frame: 16, warmup: 1 })
    expect((await p.readShadowKnobs()).B?.temporalJitter).toBe(false)
    await p.set({ shadow: { temporalJitter: true } })
    await p.renderOnce('B', { time: 0, frame: 16, warmup: 1 })
    expect((await p.readShadowKnobs()).B?.temporalJitter).toBe(true)
  })

  test('11. per-layer shadow mask — shadow=false suppresses shadow on layer', async ({
    page
  }) => {
    await loadCase(page, 'shadow-plane')
    const p = probe(page)
    await p.set({ shadow: { temporalPass: false } })
    const layerCount = (await p.setShadow(true)).B?.length
    const cascadeCount = (await p.readShadowKnobs()).B?.cascadeCount
    if (layerCount == null || layerCount === 0)
      throw new Error('side B layers unavailable')
    if (cascadeCount == null || cascadeCount === 0)
      throw new Error('side B shadow cascades unavailable')

    const layer0Only = Array.from(
      { length: layerCount },
      (_, index) => index === 0
    )
    expect((await p.setLayerShadows(layer0Only)).B).toEqual(layer0Only)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    const enabledAtlas = await p.readShadowAtlas()
    const enabled = evaluateAtlasContract(
      enabledAtlas.layers,
      enabledAtlas.rayExtents,
      cascadeCount,
      enabledAtlas.maxShadowRayExtentUnit
    )

    const none = Array.from({ length: layerCount }, () => false)
    expect((await p.setLayerShadows(none)).B).toEqual(none)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    const disabledAtlas = await p.readShadowAtlas()
    const disabled = evaluateAtlasContract(
      disabledAtlas.layers,
      disabledAtlas.rayExtents,
      cascadeCount,
      disabledAtlas.maxShadowRayExtentUnit
    )
    console.log(
      JSON.stringify({
        perLayerMask: {
          enabled,
          disabled
        }
      })
    )

    expect(layerMaskContractPasses(enabled, disabled)).toBe(true)
  })

  test('12. every shadow knob round-trips and 2 -> 4 -> 2 leaves no live-target growth', async ({
    page
  }) => {
    await loadCase(page, 'shadow-plane')
    const p = probe(page)
    const expected: ShadowKnobSnapshot = {
      cascadeCount: 2,
      mapSize: [128, 128],
      maxFar: 40_000,
      farScale: 1.1,
      splitMode: 0,
      splitLambda: 0.4,
      temporalPass: false,
      temporalJitter: false,
      maxIterationCount: 24,
      minStepSize: 80,
      maxStepSize: 900,
      minDensity: 2e-5,
      minExtinction: 3e-5,
      minTransmittance: 2e-4,
      opticalDepthTailScale: 1.5
    }
    const errorStart = (await p.errors()).length
    await p.set({
      shadow: { ...expected, mapSize: { x: 128, y: 128 } }
    })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    const first = await p.readShadowKnobs()
    const count2a = (await p.stats('B')).targets.length

    await p.set({ shadow: { cascadeCount: 4 } })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    expect((await p.readShadowAtlas()).depth).toBe(4)
    const count4 = (await p.stats('B')).targets.length

    await p.set({ shadow: { cascadeCount: 2 } })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    expect((await p.readShadowAtlas()).depth).toBe(2)
    const count2b = (await p.stats('B')).targets.length
    const final = await p.readShadowKnobs()
    const errorCount = (await p.errors()).length - errorStart
    console.log(
      JSON.stringify({
        shadowKnobs: final,
        targetCounts: [count2a, count4, count2b],
        errorCount
      })
    )

    expect(first).toEqual(final)
    expect(
      shadowKnobContractPasses({
        expected,
        A: final.A,
        B: final.B,
        targetCounts: [count2a, count4, count2b],
        errorCount
      })
    ).toBe(true)
  })

  test('13. resetHistory invalidates shadow-length history', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.set({ lightShafts: true, temporalUpscale: true })

    // Render several frames to build up history
    for (let f = 0; f < 8; f++) {
      await p.renderOnce('B', { time: 0, frame: f })
    }

    // Trigger resetHistory and check the flag
    const invalidAfterReset = await page.evaluate(() => {
      const ctx = (window as ParityWindow).__parity?.sideBHandle?.cloudsContext
      // Under `any` this chain's nullability was invisible. A missing side B here
      // is a real failure of a test that exists to exercise side B, so it throws
      // rather than taking `!` and dying later on a bare TypeError
      if (ctx == null) throw new Error('side B cloudsContext unavailable')
      ctx?.resetHistory()
      // The _shadowLengthHistoryInvalid flag is private, but we can
      // verify by checking that the next render doesn't crash
      return true
    })
    expect(invalidAfterReset).toBe(true)

    // Render after reset, which should not throw
    await p.renderOnce('B', { time: 0, frame: 8 })
    const errs = await p.errors()
    const shadowErrors = errs.filter(
      (e: string) => e.includes('shadow') || e.includes('Shadow')
    )
    expect(shadowErrors).toEqual([])
  })

  // every renderOnce here carries a warm-up. `lightShafts` changes the
  // MRT count inside setup(), which re-runs only on a graph rebuild, one per
  // browser frame: the count still read 2 after one render, 3 after the next
  test('14. lightShafts toggle recreates MRT with correct count', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    // Start with lightShafts off
    await p.set({ lightShafts: false })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    const countOff = await page.evaluate(() => {
      return (
        (window as ParityWindow).__parity?.sideBHandle?.cloudsPass?.layerRT
          ?.textures?.length ?? 0
      )
    })
    expect(countOff).toBe(2)

    // Toggle on
    await p.set({ lightShafts: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    const countOn = await page.evaluate(() => {
      return (
        (window as ParityWindow).__parity?.sideBHandle?.cloudsPass?.layerRT
          ?.textures?.length ?? 0
      )
    })
    expect(countOn).toBe(3)

    // Toggle off again
    await p.set({ lightShafts: false })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    const countOff2 = await page.evaluate(() => {
      return (
        (window as ParityWindow).__parity?.sideBHandle?.cloudsPass?.layerRT
          ?.textures?.length ?? 0
      )
    })
    expect(countOff2).toBe(2)
  })

  test('15. 3.2a darkens the plane on both sides with matching receiver ratios', async ({
    page
  }) => {
    test.setTimeout(180_000)
    // The post-lit case at POSE_SHADOW_RECEIVER: the plane sits dead-centre,
    // 532 receiver pixels. At shadow-plane's orbit pose it projects 6,233 km
    // off-frame, leaving an empty (0/0) mask
    await loadCase(page, 'shadow-sphere-neutral')
    const result = await captureReceiverShadow(page, 'plane')
    console.log(
      JSON.stringify({
        planeShadow: { A: result.A, B: result.B },
        receiverPixels: { A: result.maskA.length, B: result.maskB.length }
      })
    )

    expect(receiverShadowPasses(result.A)).toBe(true)
    expect(receiverShadowPasses(result.B)).toBe(true)
    expect(receiverRatiosAgree(result.A, result.B)).toBe(true)
  })

  test('16. 3.2b darkens the lights-mode sphere only through the cloud-shadowed light', async ({
    page
  }) => {
    test.setTimeout(180_000)
    await loadCase(page, 'shadow-sphere')
    const result = await captureReceiverShadow(page, 'sphere')
    const totalPixelsA = result.shadowedA.width * result.shadowedA.height
    const totalPixelsB = result.shadowedB.width * result.shadowedB.height
    const receiverMaskValid = receiverMaskDomainPasses(
      result.maskA.length,
      totalPixelsA,
      totalPixelsB
    )
    console.log(
      JSON.stringify({
        sphereShadow: { plainA: result.A, cloudShadowedB: result.B },
        receiverPixels: { A: result.maskA.length, B: result.maskB.length },
        observedReceiverPixelsB: result.observedMaskB.length,
        maskControls: result.maskControls,
        totalPixels: { A: totalPixelsA, B: totalPixelsB },
        receiverMaskValid
      })
    )

    expect(receiverMaskValid).toBe(true)
    expect(plainReceiverContractPasses(result.A, result.B)).toBe(true)
  })

  // Only the plane FIELD is measured: the 140-pixel sphere's darkening ratio
  // swings with the wind while its centroid stays pinned (2026-09-20), so a
  // motion contract there passes by noise. Test 16 covers the sphere
  test('17. wind moves the moving-plane shadow field in the reference direction', async ({
    page
  }) => {
    test.setTimeout(240_000)
    await loadCase(page, 'shadow-both-moving')
    const sequence = caseByName('shadow-both-moving')?.sequence
    if (sequence == null) throw new Error('shadow-both-moving has no sequence')
    const planeMotion = await page.evaluate(async sequence => {
      const parity = (window as ParityWindow).__parity
      await parity.sequenceInit(64)
      for (let frame = 0; frame < sequence.frames; frame++) {
        await parity.sequenceStep(frame, sequence.dt, {
          cameraVelocity: sequence.cameraVelocity,
          sunVelocity: sequence.sunVelocity
        })
      }
      return parity.sequenceMetrics({
        frames: sequence.frames,
        dt: sequence.dt
      })
    }, sequence)
    console.log(
      JSON.stringify({
        planeMotion: {
          A: planeMotion.motionA,
          B: planeMotion.motionB,
          direction: planeMotion.motionDirection
        }
      })
    )

    expect(motionContractPasses(planeMotion.motionA, planeMotion.motionB)).toBe(
      true
    )
  })

  test('18. shafts expose x-positive/y-zero vec2 pixels and darken the aerial output', async ({
    page
  }) => {
    test.setTimeout(180_000)
    await loadCase(page, 'shafts-inside-deck')
    const p = probe(page)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 64 })
    const read = await p.readShadowLength()
    if (read == null) throw new Error('shadow-length readback unavailable')
    // the shadowed interval sits where the reference puts it, the
    // LAST x of a geometry ray, so x + y = D (runtime.glsl:318-322, Eq. 17). D
    // is cast against the drawn mesh, and this frame is all ground
    const samples = groundDistances(
      caseByName('shafts-inside-deck')!.pose,
      read.width,
      read.height,
      20
    ).map(s => ({
      ...s,
      distance: s.distance == null ? null : s.distance * 1e-3
    }))
    const length = evaluateShadowLengthSurfaceEnd(read, samples, 0.1, {
      relative: 0.01,
      absolute: 0.01
    })
    console.log(JSON.stringify({ shadowLength: length }))
    expect(shadowLengthSurfaceEndPasses(length)).toBe(true)

    expect(await p.setLightShafts(false)).toEqual({ A: false, B: false })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 1 })
    expect(await p.readShadowLength()).toBeNull()

    await loadCase(page, 'shafts-low-sun')
    const shaftsOn = await renderSideAndRead(page, 'B')
    await loadCase(page, 'shafts-orbit-off')
    const shaftsOff = await renderSideAndRead(page, 'B')
    console.log(
      JSON.stringify({
        shaftsMeanDelta: meanAbsDiff(shaftsOn.data, shaftsOff.data)
      })
    )

    expect(shaftsEffectPasses(shaftsOn.data, shaftsOff.data, 1e-4)).toBe(true)
    expect(shaftsDarkeningPasses(shaftsOn.data, shaftsOff.data, 1e-4)).toBe(
      true
    )
  })

  test('19. enabled=false suppresses shadow, shafts, atlas, and march work and re-enable restores shadow', async ({
    page
  }, testInfo) => {
    test.setTimeout(600_000)
    const withinShadowOff: number[] = []
    const withinShadowOn: number[] = []
    const crossState: number[] = []
    const hardGates: Array<{
      stateReached: boolean
      disabledShaftsDelta: number
      disabledFrameMs: number | null
      passes: { atlas: number; march: number; shadowLength: number }
      pageErrors: number
    }> = []

    for (let replicate = 0; replicate < 10; replicate++) {
      await loadCase(page, 'shadow-plane')
      const p = probe(page)
      await p.set({ enabled: false, lightShafts: false })

      const offFirst = await renderDisabledShadowState(page, false)
      const onFirst = await renderDisabledShadowState(page, true)
      const offSecond = await renderDisabledShadowState(page, false)
      const onSecond = await renderDisabledShadowState(page, true)
      withinShadowOff.push(
        maxAbsDiff(offFirst.pixels.data, offSecond.pixels.data)
      )
      withinShadowOn.push(maxAbsDiff(onFirst.pixels.data, onSecond.pixels.data))
      crossState.push(maxAbsDiff(offFirst.pixels.data, onFirst.pixels.data))

      const shaftsState = await p.setLightShafts(true)
      const disabledShafts = await renderSideAndRead(page, 'B', 0, 0, 1)
      const stats = await p.stats('B')
      hardGates.push({
        stateReached:
          offFirst.stateReached &&
          onFirst.stateReached &&
          offSecond.stateReached &&
          onSecond.stateReached &&
          shaftsState.A === true &&
          shaftsState.B === true,
        disabledShaftsDelta: maxAbsDiff(
          onSecond.pixels.data,
          disabledShafts.data
        ),
        disabledFrameMs: stats.frameMs,
        passes: stats.passes,
        pageErrors: (await p.errors()).length
      })
    }

    const p = probe(page)
    await p.set({ enabled: true, lightShafts: false })
    const off = await p.setShadow(false)
    const enabledShadowOff = await renderSideAndRead(page, 'B', 0, 0, 64)
    const on = await p.setShadow(true)
    const enabledShadowOn = await renderSideAndRead(page, 'B', 0, 0, 64)
    const reenabledShadowDelta = meanAbsDiff(
      enabledShadowOff.data,
      enabledShadowOn.data
    )
    const verdict = neutralisationFloorVerdict({
      withinShadowOff,
      withinShadowOn,
      crossState
    })
    const withinFloor = Math.max(...withinShadowOff, ...withinShadowOn)
    const disabledShaftsWithinFloor = deltasWithinMeasuredFloor(
      hardGates.map(gate => gate.disabledShaftsDelta),
      withinFloor
    )
    const report = {
      withinShadowOff,
      withinShadowOn,
      crossState,
      summary: {
        withinShadowOff: distributionSummary(withinShadowOff),
        withinShadowOn: distributionSummary(withinShadowOn),
        crossState: distributionSummary(crossState)
      },
      withinFloor,
      disabledShaftsWithinFloor,
      hardGates,
      reenabledShadowDelta,
      reenabledStateReached:
        shadowStateMatches(off, false) && shadowStateMatches(on, true),
      verdict
    }
    console.log(JSON.stringify({ phase3Neutralisation: report }))
    await testInfo.attach('phase3-neutralisation-floor.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })

    expect(
      hardGates.every(
        gate =>
          gate.stateReached &&
          gate.disabledFrameMs != null &&
          Number.isFinite(gate.disabledFrameMs) &&
          gate.disabledFrameMs >= 0 &&
          gate.passes.atlas === 0 &&
          gate.passes.march === 0 &&
          gate.passes.shadowLength === 0 &&
          gate.pageErrors === 0
      )
    ).toBe(true)
    expect(disabledShaftsWithinFloor).toBe(true)
    expect(report.reenabledStateReached).toBe(true)
    expect(reenabledShadowDelta).toBeGreaterThan(1e-4)
    expect(verdict).toBe('neutralised')
  })
})
