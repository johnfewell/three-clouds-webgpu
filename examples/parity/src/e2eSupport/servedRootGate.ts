// The served-tree gate's refusals, and the logging around them
// Its whole value is refusing what it cannot interpret, so the tests for it are
// mostly refusals: a gate that only passes on a clean answer is a log line
// Lives in src/ because examples/parity/e2e/ is not in the vitest include list,
// so a test beside a spec there is collected by nothing
import { servedRootRefusal, type E2eServerSpec } from './e2ePorts'

/** Port resolution and the probe, injected so the gate is testable without ports */
export interface ServedRootGateDeps {
  repoRoot: string
  specs: E2eServerSpec[]
  baseOf: (spec: E2eServerSpec) => string
  probe: (
    base: string,
    repoRoot: string,
    timeoutMs?: number
  ) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  log: (message: string) => void
}

/**
 * Probe every configured server and refuse if any of them is not serving this
 * tree. Returns the number of servers proved, so a caller that logs can say
 * "3/3" instead of implying a check it did not run
 */
export async function requireOwnServers(
  deps: ServedRootGateDeps
): Promise<number> {
  const { repoRoot, specs, baseOf, probe, log } = deps
  const results = await Promise.all(
    specs.map(async spec => ({
      spec,
      result: await probe(baseOf(spec), repoRoot)
    }))
  )
  // Every server probed, every verdict collected, and only THEN judged: a gate
  // that threw on the first failure would report one server and leave the
  // reader guessing about the other two
  const foreign = results.filter(r => !r.result.ok).map(r => r.spec.name)
  if (foreign.length > 0) {
    const first = results.find(r => !r.result.ok)!
    throw new Error(
      servedRootRefusal(
        specs,
        baseOf,
        repoRoot,
        first.result as { ok: false; reason: string },
        foreign
      )
    )
  }
  const paths = results.map(r => `${r.spec.name} ${baseOf(r.spec)}`)
  log(
    `[e2e] served-tree gate: ${results.length}/${specs.length} servers serve ` +
      `${repoRoot} (${paths.join(', ')})`
  )
  return results.length
}
