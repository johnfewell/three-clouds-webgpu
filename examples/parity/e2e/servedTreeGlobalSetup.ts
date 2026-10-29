// Refuses an e2e run whose servers belong to another checkout
// Runs as Playwright's globalSetup, after the webServers and before any test,
// so every spec goes through it, including basic and r3f, whose only other
// guard is a <title> another agent's checkout also ships. It measures nothing,
// which is what lets one HTTP request per server fail hard on an unknown answer
import { resolve } from 'node:path'

import { probeServedRoot, serversFromOrigins } from '../src/e2eSupport/e2ePorts'
import { requireOwnServers } from '../src/e2eSupport/servedRootGate'

/** The env vars the config publishes one origin into, in package order */
const SERVED_URL_VARS = [
  'PARITY_HARNESS_URL',
  'PARITY_BASIC_URL',
  'PARITY_R3F_URL'
]

/**
 * The origins as the config published them, or a named refusal
 *
 * Refusing here rather than defaulting is the point: a missing value would
 * otherwise mean this gate quietly probed the three legacy ports and reported
 * on whatever answered, which is the defect it exists to catch
 */
function publishedOrigins(): { origins: string[]; missing: string[] } {
  const origins: string[] = []
  const missing: string[] = []
  for (const name of SERVED_URL_VARS) {
    const value = process.env[name]
    if (value == null || value === '') missing.push(name)
    else origins.push(value)
  }
  return { origins, missing }
}

export default async function globalSetup(): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
  const { origins, missing } = publishedOrigins()
  if (missing.length > 0) {
    throw new Error(
      `[e2e] REFUSING to run: the config published no origin for ` +
        `${missing.join(', ')}, so this gate cannot tell which tree answered. ` +
        'It is reached through examples/parity/e2e/playwright.config.ts, which ' +
        'sets those before Playwright loads a setup file. Reaching it any other ' +
        'way is a wiring change, and guessing the ports here is exactly the ' +
        'substitution this gate exists to catch.'
    )
  }

  // Paired by index, in serversFromOrigins: an origin-keyed lookup cannot find
  // the second of two servers sharing an origin, which made this file throw
  // "no published origin" on exactly the input it most needed to judge
  const servers = serversFromOrigins(origins)

  await requireOwnServers({
    repoRoot,
    specs: servers.map(s => s.spec),
    baseOf: spec => {
      const found = servers.find(s => s.spec === spec)
      if (found == null) throw new Error(`no published origin for ${spec.name}`)
      return found.origin
    },
    probe: probeServedRoot,
    log: console.log
  })
}
