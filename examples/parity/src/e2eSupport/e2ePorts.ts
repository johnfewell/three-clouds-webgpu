// Which tree answered an e2e run, and which ports it runs on
// A digest compares BYTES, equal across worktrees of one commit, and the
// symlink check in captureProvenance.mjs describes THIS tree rather than the
// tree answering. The question is about the SERVER, so it is asked of the
// server: Vite answers /@fs/<abs> 200 inside its fs.allow and 403 outside
import { createServer } from 'node:net'

/** What each e2e server serves, and the port it is expected on */
export interface E2eServerSpec {
  /** The port number itself, as configured */
  port: number
  /** Stable name for logs and errors */
  name: string
  /** Which workspace package this server runs */
  packageName: string
}

/**
 * One served path per server, chosen to exist in every checkout
 *
 * `package.json` is that choice: tracked, so present before any build, and
 * identical across trees of the same commit (which is why the RESPONSE BODY is
 * not what proves anything, the STATUS is)
 */
export const SERVED_PROBE_SUFFIX = 'package.json'

/**
 * Ask one server whether our repo root is inside what it serves
 *
 * Uses a request-level timeout rather than a bare fetch: a port held by a
 * half-dead foreign process accepts the connection and never answers, and an
 * unanswered probe must be a refusal within bounded time, not a hang that
 * looks like a slow suite
 *
 * @param base the server origin, e.g. `http://localhost:6123`
 * @param repoRoot absolute path of the tree that started the run
 * @param timeoutMs per-request cap
 * @returns `{ ok: true, path: string }` when the server served our root, else
 *   `{ ok: false, reason: string }` naming what came back
 */
export async function probeServedRoot(
  base: string,
  repoRoot: string,
  timeoutMs = 5_000
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  // Vite's /@fs/ takes an absolute POSIX path, and a trailing slash or a
  // doubled separator is 404 rather than 403, so normalize rather than trust
  // a caller's argument to be tidy
  const abs = repoRoot.replace(/\/+$/, '')
  const path = `/@fs${abs}/${SERVED_PROBE_SUFFIX}`
  const url = `${base.replace(/\/+$/, '')}${path}`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (response.status === 200) return { ok: true, path }
    // 403 is the informative one: a Vite server answered and this path is
    // outside its fs.allow, which is exactly "another tree". Anything else is
    // an unknown and is reported as one rather than read as either verdict
    const detail =
      response.status === 403
        ? '403 Forbidden: a Vite dev server answered, and this tree is ' +
          'outside what it serves, so ANOTHER checkout is on this port'
        : `unexpected ${response.status}`
    return {
      ok: false,
      reason: `${url} answered ${detail}`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason:
        `${url} did not answer within ${timeoutMs}ms (${message}). Either ` +
        'nothing is serving it, or whatever is never replies. Neither is ' +
        'proof that this tree answered'
    }
  }
}

/**
 * The refusal text, so the config log and any future caller say the same thing
 *
 * @param specs the servers as configured
 * @param baseOf the origin for one spec
 * @param repoRoot the tree that started the run
 * @param result what `probeServedRoot` returned
 * @param names the names of the OTHER servers that failed, so one line names
 *   the whole set rather than making the reader fix them one run at a time
 */
export function servedRootRefusal(
  specs: E2eServerSpec[],
  baseOf: (spec: E2eServerSpec) => string,
  repoRoot: string,
  result: { ok: false; reason: string },
  names: string[]
): string {
  return (
    `[e2e] REFUSING to run: ${result.reason}\n` +
    `[e2e] This run was launched from ${repoRoot}, so the only server it can ` +
    `trust is one started by it. Ports: ` +
    specs.map(s => `${s.name} ${s.port} (${s.packageName})`).join(', ') +
    `.\n[e2e] Servers that answered for another tree: ${names.join(', ')}.\n` +
    `[e2e] A run that measures another checkout produces evidence that looks ` +
    `normal and describes the wrong code. Either stop the other ` +
    `server, or give this run its own ports with PARITY_E2E_PORTS= and let it ` +
    `start its own.`
  )
}

/** The origins the config publishes, in the order the packages are served */
export const SERVED_PACKAGES = ['parity', 'basic', 'r3f'] as const

/** One env var per package, holding that server's full origin */
export const SERVED_URL_VARS = [
  'PARITY_HARNESS_URL',
  'PARITY_BASIC_URL',
  'PARITY_R3F_URL'
] as const

/**
 * The port an origin names, refusing one that names none
 *
 * `new URL('http://localhost').port` is `''`, which would reach Vite as
 * `--port ` with nothing after it and leave the server on its default, the
 * very substitution this module removes, one layer down. An origin with no
 * explicit port is a refusal, not a default
 */
export function portOf(origin: string, urlVar: string): number {
  const port = Number(new URL(origin).port)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `${urlVar}="${origin}" names no port. Every e2e server needs an explicit ` +
        'one, because a server that fell back to a default is a server this ' +
        'run did not choose. Write the port into the origin.'
    )
  }
  return port
}

/**
 * The three origins an e2e run needs, one per served package
 *
 * Per-server precedence, because two env vars can each name a port and they can
 * be set independently:
 *   1. that package's URL var (PARITY_BASIC_URL and friends), if set
 *   2. its slot in PARITY_E2E_PORTS, if that is set
 *   3. an OS free-port probe
 *
 * Resolving them separately is what keeps the origins and the ports a run
 * actually starts coherent. Honouring `PARITY_E2E_PORTS` and overwriting the
 * URL vars would mean a caller who set only `PARITY_BASIC_URL`, an override
 * the basic smoke has always documented, got a server started on a probed
 * port while the spec navigated to their origin, which measures whatever is on
 * it. That is this task's defect with a new coat of paint
 *
 * A URL var that contradicts its `PARITY_E2E_PORTS` slot is a refusal: both
 * were named, they disagree, and guessing which one was meant is how a run ends
 * up testing a port nobody chose
 *
 * @param env the environment to read
 * @param probe the free-port finder, injectable so the choice is testable
 * @returns the resolved origins, and which source supplied each
 */
export async function resolveE2eOrigins(
  env: Record<string, string | undefined>,
  probe: (prefer?: number) => Promise<number> = freePort
): Promise<{
  origins: Record<(typeof SERVED_PACKAGES)[number], string>
  sources: Record<(typeof SERVED_PACKAGES)[number], 'url' | 'ports' | 'probe'>
}> {
  const requested = parseE2ePorts(env.PARITY_E2E_PORTS)
  const origins = {} as Record<(typeof SERVED_PACKAGES)[number], string>
  const sources = {} as Record<
    (typeof SERVED_PACKAGES)[number],
    'url' | 'ports' | 'probe'
  >

  for (const [i, pkg] of SERVED_PACKAGES.entries()) {
    const url = env[SERVED_URL_VARS[i]!]?.trim()
    const fromPorts = requested?.[i]
    if (url != null && url !== '' && fromPorts != null) {
      const urlPort = Number(new URL(url).port)
      if (urlPort !== fromPorts) {
        throw new Error(
          `${SERVED_URL_VARS[i]} names port ${urlPort} but PARITY_E2E_PORTS ` +
            `names ${fromPorts} for ${pkg}. Both were set and they disagree, so ` +
            `there is no port this run can start on that the caller also asked ` +
            `to be visited. Set one of them.`
        )
      }
    }
    if (url != null && url !== '') {
      origins[pkg] = url
      sources[pkg] = 'url'
      continue
    }
    const port = fromPorts ?? (await probe())
    origins[pkg] = `http://localhost:${port}`
    sources[pkg] = fromPorts != null ? 'ports' : 'probe'
  }

  return { origins, sources }
}

/**
 * PARITY_E2E_PORTS as three numbers, or null when it is unset
 *
 * A malformed or short value refuses rather than falling back to the probe:
 * honouring two of three ports runs a different set of servers than the caller
 * asked for, which is the confusion being removed
 */
function parseE2ePorts(
  raw: string | undefined
): [number, number, number] | null {
  if (raw == null || raw.trim() === '') return null
  const parts = raw.split(',').map(p => p.trim())
  if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) {
    throw new Error(
      `PARITY_E2E_PORTS="${raw}" is not three comma-separated port numbers ` +
        '(parity,basic,r3f). Refusing rather than falling back to the probe: ' +
        'a partial override would run some of the servers this run asked for ' +
        'and start the rest on other ports.'
    )
  }
  const [parity, basic, r3f] = parts.map(Number) as [number, number, number]
  if (new Set([parity, basic, r3f]).size !== 3) {
    throw new Error(
      `PARITY_E2E_PORTS="${raw}" repeats a port. The three servers must not ` +
        'share one, or a check aimed at one grades another.'
    )
  }
  return [parity, basic, r3f]
}

/**
 * Pair each published origin with the server spec it is, BY INDEX
 *
 * The pairing is positional and never an origin-keyed lookup. The first version
 * of the setup file kept a `Map<origin, spec>` and found an origin by comparing
 * spec identity, which cannot work when two servers share one origin: the map
 * holds one entry and the second spec is unreachable, so the gate threw "no
 * published origin" while the probe it was about to run would have answered
 * A shared origin is legal input here, the port resolver refuses it, but this
 * reads the ENVIRONMENT, and a caller may point all three at one server on
 * purpose
 */
export function serversFromOrigins(origins: string[]): {
  spec: E2eServerSpec
  origin: string
}[] {
  return origins.map((origin, i) => ({
    spec: {
      port: Number(new URL(origin).port),
      name: SERVED_PACKAGES[i] ?? `server${i}`,
      packageName: SERVED_PACKAGES[i] ?? 'unknown'
    },
    origin
  }))
}

/**
 * A port nothing is listening on, from the OS
 *
 * Used as the DEFAULT rather than a fixed per-worktree offset because a fixed
 * default is a shared default with extra steps: two worktrees whose offset
 * hashes collide are back to fighting over one port, and the hash has to be
 * stable across machines and checkouts for the ports to be reproducible at all
 *
 * The socket is bound and then released, so there is an unavoidable window in
 * which another process could take the port. That is why `reuseExistingServer`
 * is false: the run starts its OWN server and Playwright fails loudly if it
 * cannot, which turns that race into a refusal instead of a silent
 * substitution. Reusing whatever answers is the one behaviour that cannot
 * detect it
 *
 * @param prefer a port to try first, so a caller that names one keeps it when
 *   it is free
 */
export function freePort(prefer?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', error => {
      server.close(() => {})
      reject(error)
    })
    server.listen({ port: prefer ?? 0, host: '127.0.0.1' }, () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address != null ? address.port : null
      server.close(() => {
        if (port == null) reject(new Error('the OS reported no port'))
        else resolve(port)
      })
    })
  })
}
