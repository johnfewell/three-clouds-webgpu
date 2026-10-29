import { beforeEach } from 'vitest'

import { setCurrentSpec } from './log'

/**
 * Vendor assets a CPU graph build asks for, answered from memory.
 *
 * Both `@takram` packages fetch a 1 MB star table and a 1 MB jitter volume by
 * DEFAULT when their nodes are constructed, and a test that only COMPILES a
 * graph never reads either. Real `fetch` starts a reader loop that constructs
 * `ProgressEvent`, which node lacks, so under load the callback lands after
 * teardown: every test green, an unhandled rejection, exit code 1.
 */

/**
 * A 200 with an EMPTY stream, on purpose. three's loader reads it to `done` with
 * no chunk ever enqueued, so the progress branch is never entered and no
 * `ProgressEvent` is constructed. Nothing is silenced here: defining the global
 * instead would hide the rejection behind a network call a unit test has no
 * business making.
 */
const VENDOR_ASSET_HOST = 'media.githubusercontent.com'

/** How many vendor-asset requests the stub answered, for a test to assert on */
export const vendorAssetRequests = { count: 0 }

function vendorAssetResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.close()
    }
  })
  return new Response(stream, { status: 200 })
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

const realFetch = globalThis.fetch

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (urlOf(input).includes(VENDOR_ASSET_HOST)) {
    vendorAssetRequests.count++
    return Promise.resolve(vendorAssetResponse())
  }
  return realFetch(input, init)
}

beforeEach(({ task }) => {
  const file = task.file?.name ?? 'unknown'
  const base =
    file
      .split('/')
      .pop()
      ?.replace(/\.test\.ts$/, '') ?? 'unknown'
  setCurrentSpec(base)
})
