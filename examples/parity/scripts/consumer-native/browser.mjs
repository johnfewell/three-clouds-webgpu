import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createPhaseCadence } from './cadence.mjs'
import {
  inspectDeviceDisposal,
  sampleStoppedFrames,
  waitForDeviceDisposal
} from './disposal.mjs'
import { EVENT_PREFIX, observeDevice } from './observer.mjs'
import {
  assertContribution,
  assertVisible,
  comparePixels,
  decodeScreenshot,
  LIMITS
} from './pixels.mjs'
import {
  assertDevelopmentReplay,
  assertHardware,
  hash,
  insist
} from './proof.mjs'
import { createPhaseSampler } from './sampler.mjs'
import { observeTransport } from './transport.mjs'

const VIEWPORT = { width: 640, height: 360 }
const TIMEOUT = 90000

async function frames(page, count = 12) {
  const start = Number(
    await page.locator('#status').getAttribute('data-frames')
  )
  await page.waitForFunction(
    ({ start, count }) => {
      const status = document.querySelector('#status')
      if (status.dataset.state === 'error') throw new Error(status.textContent)
      return Number(status.dataset.frames) >= start + count
    },
    { start, count },
    { timeout: TIMEOUT }
  )
}

async function waitUntilFrame(page, target) {
  await page.waitForFunction(
    target => {
      const status = document.querySelector('#status')
      if (status.dataset.state === 'error') throw new Error(status.textContent)
      return Number(status.dataset.frames) >= target
    },
    target,
    { timeout: TIMEOUT }
  )
}

async function capture(page, directory, name) {
  const mask = await page.locator('aside').boundingBox()
  insist(mask != null, 'missing HUD mask')
  const before = Number(
    await page.locator('#status').getAttribute('data-frames')
  )
  const bytes = await page.screenshot({
    path: join(directory, `${name}.png`),
    mask: [page.locator('aside')],
    maskColor: '#000000',
    animations: 'disabled'
  })
  const after = Number(
    await page.locator('#status').getAttribute('data-frames')
  )
  return {
    image: decodeScreenshot(bytes, mask),
    sha256: hash(bytes),
    name,
    before,
    after
  }
}

async function converge(page, directory, label, records, target) {
  const deadline = Date.now() + TIMEOUT
  const sampler = createPhaseSampler({
    reference: target?.image,
    referenceLimit: target?.limit
  })
  const cadence = createPhaseCadence()
  let previous
  let iteration = 0
  while (Date.now() < deadline) {
    const currentFrame = Number(
      await page.locator('#status').getAttribute('data-frames')
    )
    const plan = cadence.plan({
      currentFrame,
      iteration,
      hint: previous?.anchor ?? target,
      lastMatch: previous?.recurrences.at(-1) ?? previous?.anchor
    })
    await waitUntilFrame(page, plan.waitUntil)
    const current = await capture(page, directory, `${label}-${iteration++}`)
    const sampling = cadence.observe(plan, current)
    const result = sampler.push(current)
    records.push({
      label,
      sha256: current.sha256,
      target: target?.name ?? null,
      sampling,
      ...result
    })
    if (result.ready) return current
    previous = result
  }
  throw new Error(
    `Consumer native: ${label} did not converge to meaningful pixels`
  )
}

async function resetThroughUI(page, selector) {
  await page.evaluate(
    selector =>
      new Promise((resolve, reject) => {
        const status = document.querySelector('#status')
        const previous = Number(status.dataset.frames)
        const observer = new MutationObserver(() => {
          if (Number(status.dataset.frames) < previous) {
            observer.disconnect()
            clearTimeout(timer)
            resolve()
          }
        })
        const timer = setTimeout(() => {
          observer.disconnect()
          reject(new Error('UI action did not reset the public frame counter'))
        }, 10000)
        observer.observe(status, {
          attributes: true,
          attributeFilter: ['data-frames']
        })
        document.querySelector(selector).click()
      }),
    selector
  )
}

const seek = page => resetThroughUI(page, '#seek')

async function toggle(page, enabled) {
  await page.locator('#clouds-toggle').click()
  insist(
    (await page.locator('#clouds-toggle').getAttribute('aria-pressed')) ===
      String(enabled),
    'cloud toggle state did not change'
  )
}

async function resize(page, size) {
  await page.setViewportSize(size)
  await page.waitForFunction(
    ({ width, height }) => {
      const canvas = document.querySelector('canvas')
      return canvas.width === width && canvas.height === height
    },
    size,
    { timeout: TIMEOUT }
  )
}

function assertLiveDevice(events) {
  assertHardware(events)
  insist(
    !events.some(event => event.type === 'destroy' || event.type === 'lost'),
    'application device was released before final disposal'
  )
}

async function remount(page, directory, records, events, on, off) {
  for (let iteration = 0; iteration < 2; iteration++) {
    const enabled = iteration === 1
    await toggle(page, enabled)
    await frames(page)
    await resetThroughUI(page, '#remount')
    await page.waitForFunction(
      () => document.querySelector('#status').dataset.state === 'rendering',
      null,
      { timeout: TIMEOUT }
    )
    await frames(page)
    await seek(page)
    const target = enabled ? on : off
    await converge(page, directory, `remount-${iteration}`, records, {
      image: target.image,
      name: target.name,
      before: target.before,
      limit: LIMITS.restoreMean
    })
    insist(
      (await page.locator('#clouds-toggle').getAttribute('aria-pressed')) ===
        String(enabled),
      'remount lost enabled intent'
    )
    assertLiveDevice(events)
  }
}

async function dispose(page, events) {
  await page.locator('#stop').click()
  await page.waitForFunction(
    () => document.querySelector('#status').dataset.state === 'stopped'
  )
  const before = await page.locator('#status').getAttribute('data-frames')
  const completion = await waitForDeviceDisposal(listener => {
    page.on('console', listener)
    return () => page.off('console', listener)
  }, events)
  const completionFrames = await page.evaluate(sampleStoppedFrames, before)
  await page.locator('#stop').click()
  const idempotentFrames = await page.evaluate(sampleStoppedFrames, before)
  insist(
    inspectDeviceDisposal(events) != null,
    'missing final device destruction'
  )
  return {
    completion,
    completionFrames,
    idempotentFrames,
    framesBefore: before,
    framesAfter: await page.locator('#status').getAttribute('data-frames'),
    idempotentClick: true
  }
}

export async function runScenario(
  browser,
  scenario,
  server,
  directory,
  reference
) {
  mkdirSync(directory, { recursive: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    serviceWorkers: 'block'
  })
  await context.addInitScript(observeDevice, EVENT_PREFIX)
  const page = await context.newPage()
  page.setDefaultTimeout(TIMEOUT)
  const transport = await observeTransport(
    context,
    page,
    scenario,
    server.origin
  )
  const records = []
  const result = {
    id: scenario.id,
    status: 'failed',
    records,
    transport: transport.evidence
  }
  try {
    const base = scenario.development ? '/' : scenario.build.base
    await page.goto(
      `${server.origin}${base}${scenario.mode === 'manual' ? '?manual=1' : ''}`,
      { waitUntil: 'domcontentloaded', timeout: TIMEOUT }
    )
    await page.waitForFunction(
      () => {
        const status = document.querySelector('#status')
        if (status?.dataset.state === 'error')
          throw new Error(status.textContent)
        return (
          status?.dataset.state === 'rendering' &&
          Number(status.dataset.frames) > 2
        )
      },
      null,
      { timeout: TIMEOUT }
    )
    await page.locator('#pause').click()
    insist(
      (await page.locator('#pause').textContent()) === 'Resume',
      'pause did not engage'
    )
    await seek(page)
    const on = await converge(page, directory, 'on', records, reference)
    const repeat = await converge(page, directory, 'on-repeat', records, {
      image: on.image,
      name: on.name,
      before: on.before,
      limit: LIMITS.stableMean
    })
    if (scenario.development) {
      await transport.finish()
      result.developmentReplay = assertDevelopmentReplay(
        transport.evidence.devices,
        transport.evidence.responses,
        scenario.build.assets
      )
    }
    assertLiveDevice(transport.evidence.devices)
    await toggle(page, false)
    const off = await converge(page, directory, 'off', records)
    await toggle(page, true)
    await seek(page)
    const restored = await converge(page, directory, 'restored', records, {
      image: on.image,
      name: on.name,
      before: on.before,
      limit: LIMITS.restoreMean
    })
    result.contribution = assertContribution(
      on.image,
      repeat.image,
      off.image,
      restored.image
    )
    await resize(page, { width: 800, height: 450 })
    const resized = await converge(page, directory, 'resized', records)
    result.resize = {
      width: resized.image.width,
      height: resized.image.height,
      ...assertVisible(resized.image)
    }
    await resize(page, VIEWPORT)
    await seek(page)
    const resizedBack = await converge(
      page,
      directory,
      'resize-return',
      records,
      {
        image: on.image,
        name: on.name,
        before: on.before,
        limit: LIMITS.restoreMean
      }
    )
    result.resizeReturn = comparePixels(on.image, resizedBack.image)
    insist(
      result.resizeReturn.meanDifference <= LIMITS.restoreMean,
      'resize/seek did not restore output'
    )
    if (scenario.mode === 'r3f')
      await remount(
        page,
        directory,
        records,
        transport.evidence.devices,
        on,
        off
      )
    assertLiveDevice(transport.evidence.devices)
    result.device = assertHardware(transport.evidence.devices)
    result.disposal = await dispose(page, transport.evidence.devices)
    await transport.finish()
    result.status = 'passed'
    return { result, image: on.image, capture: on }
  } catch (error) {
    result.error = String(error?.stack ?? error)
    return { result }
  } finally {
    await page
      .locator('#stop')
      .click({ timeout: 1000 })
      .catch(() => {})
    await context.close()
  }
}
