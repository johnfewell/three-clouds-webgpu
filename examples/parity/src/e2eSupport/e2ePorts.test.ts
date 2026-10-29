// The served-tree gate's decisions, without a browser or a port
//
// WHAT IS WORTH TESTING HERE: the gate's whole value is that it refuses on the
// cases it does not understand. A gate that only passes when the answer is
// clean is a log line. So the tests below are mostly refusals, and the
// red-proof at the bottom breaks the gate and shows a run would have gone on

import { describe, expect, it } from 'vitest'

import { table } from '../../../../test/helpers/cpuTwin'
import {
  portOf,
  probeServedRoot,
  resolveE2eOrigins,
  type E2eServerSpec
} from './e2ePorts'
import { requireOwnServers } from './servedRootGate'

const REPO = '/Users/somebody/code/wt-e2eports'
const THEIRS = '/Users/somebody/code/wt-somebody-else'

const SERVERS: E2eServerSpec[] = [
  { port: 5301, name: 'parity', packageName: 'parity' },
  { port: 5302, name: 'basic', packageName: 'basic' },
  { port: 5303, name: 'r3f', packageName: 'r3f' }
]

const baseOf = (spec: E2eServerSpec): string => `http://localhost:${spec.port}`

type Probe = (
  base: string,
  repoRoot: string
) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>

/** Answers ok for the servers in `ours`, and 'another tree' for the rest */
function probeFor(ours: string[]): Probe {
  return base => {
    const spec = SERVERS.find(s => baseOf(s) === base)!
    const ok: Awaited<ReturnType<Probe>> = ours.includes(spec.name)
      ? { ok: true, path: `/@fs${REPO}/package.json` }
      : {
          ok: false,
          reason: `${base}/@fs${REPO}/package.json answered 403 Forbidden: a Vite dev server answered, and this tree is outside what it serves, so ANOTHER checkout is on this port`
        }
    return Promise.resolve(ok)
  }
}

const silent = (): void => {}

describe('served-tree gate', () => {
  it('passes when every server serves this tree, and says how many it checked', async () => {
    const logged: string[] = []
    const proved = await requireOwnServers({
      repoRoot: REPO,
      specs: SERVERS,
      baseOf,
      probe: probeFor(['parity', 'basic', 'r3f']),
      log: m => logged.push(m)
    })
    table('all three ours', [
      { field: 'servers proved', expected: 3, actual: proved },
      {
        field: 'logged 3/3',
        expected: true,
        actual: logged[0]?.includes('3/3 servers')
      },
      {
        field: 'logged the tree',
        expected: true,
        actual: logged[0]?.includes(REPO)
      }
    ])
    expect(proved).toBe(3)
    // The count is in the message because "it passed" and "it checked three
    // servers" are different claims, and only one of them is what happened
    expect(logged[0]).toContain('3/3')
    expect(logged[0]).toContain(REPO)
  })

  it('REFUSES when one server is another checkout, naming it', async () => {
    let thrown: Error | null = null
    try {
      await requireOwnServers({
        repoRoot: REPO,
        specs: SERVERS,
        baseOf,
        probe: probeFor(['parity', 'r3f']),
        log: silent
      })
    } catch (error) {
      thrown = error as Error
    }
    const message = thrown?.message ?? ''
    table('basic is foreign', [
      { field: 'refused', expected: true, actual: thrown != null },
      {
        field: 'names basic',
        expected: true,
        actual: message.includes('basic')
      },
      {
        field: 'names the ports',
        expected: true,
        actual: message.includes('5302')
      },
      {
        field: 'names the fix',
        expected: true,
        actual: message.includes('PARITY_E2E_PORTS')
      }
    ])
    expect(thrown).toBeInstanceOf(Error)
    expect(message).toContain('basic')
    expect(message).toContain('5302')
    expect(message).toContain('PARITY_E2E_PORTS')
  })

  it('names EVERY foreign server in one refusal, not just the first', async () => {
    // A gate that threw on the first failure would name one server and leave
    // the reader to fix the other two across two more failed runs
    let message = ''
    try {
      await requireOwnServers({
        repoRoot: REPO,
        specs: SERVERS,
        baseOf,
        probe: probeFor([]),
        log: silent
      })
    } catch (error) {
      message = (error as Error).message
    }
    table('all three foreign', [
      {
        field: 'names parity',
        expected: true,
        actual: message.includes('parity')
      },
      {
        field: 'names basic',
        expected: true,
        actual: message.includes('basic')
      },
      { field: 'names r3f', expected: true, actual: message.includes('r3f') }
    ])
    expect(message).toContain('parity')
    expect(message).toContain('basic')
    expect(message).toContain('r3f')
  })

  it('refuses an UNANSWERED probe rather than reading it as a pass', async () => {
    // The fleet's recurring shape: an absent answer is indistinguishable from
    // a clean one exactly when it matters. A dead port, a non-Vite server and
    // a hung request are three causes that all mean "not proven to be ours"
    let thrown: Error | null = null
    try {
      await requireOwnServers({
        repoRoot: REPO,
        specs: SERVERS,
        baseOf,
        probe: () =>
          Promise.resolve({
            ok: false,
            reason:
              'http://localhost:5301/@fs/x/package.json did not answer within 5000ms. Either nothing is serving it, or whatever is never replies.'
          }),
        log: silent
      })
    } catch (error) {
      thrown = error as Error
    }
    table('nothing answers', [
      { field: 'refused', expected: true, actual: thrown != null }
    ])
    expect(thrown).toBeInstanceOf(Error)
  })
})

describe('pairing a published origin with the server it is', () => {
  it('keeps all three findable when they share ONE origin', async () => {
    // The setup file's first version kept a Map<origin, spec> and recovered an
    // origin by spec identity, so two servers on one origin left the second
    // unreachable and the gate threw, on the input it most needed to judge
    const { serversFromOrigins } = await import('./e2ePorts')
    const origins = [
      'http://localhost:4173',
      'http://localhost:4173',
      'http://localhost:4173'
    ]
    const servers = serversFromOrigins(origins)
    const baseOf = (spec: E2eServerSpec): string => {
      const found = servers.find(s => s.spec === spec)
      if (found == null) throw new Error(`no published origin for ${spec.name}`)
      return found.origin
    }
    const reached = servers.map(s => {
      try {
        return baseOf(s.spec)
      } catch (error) {
        return `threw: ${error instanceof Error ? error.message : 'unknown'}`
      }
    })
    table('three servers, one origin', [
      { field: 'entries', expected: 3, actual: servers.length },
      {
        field: 'names',
        expected: 'parity,basic,r3f',
        actual: servers.map(s => s.spec.name).join(',')
      },
      {
        field: 'ports parsed',
        expected: '4173,4173,4173',
        actual: servers.map(s => s.spec.port).join(',')
      },
      {
        field: 'every spec reachable',
        expected: 0,
        actual: reached.filter(r => r.startsWith('threw')).length
      }
    ])
    expect(servers.map(s => s.spec.name)).toEqual(['parity', 'basic', 'r3f'])
    expect(servers.map(s => s.spec.port)).toEqual([4173, 4173, 4173])
    // Zero throws is the assertion the Map version could not pass
    expect(reached.filter(r => r.startsWith('threw'))).toHaveLength(0)
  })

  it('pairs distinct origins positionally, and survives an unnamed extra', async () => {
    const { serversFromOrigins } = await import('./e2ePorts')
    const servers = serversFromOrigins([
      'http://localhost:5301',
      'http://localhost:5302',
      'http://localhost:5303',
      'http://localhost:5304'
    ])
    table('four origins', [
      {
        field: 'first',
        expected: 'parity:5301',
        actual: `${servers[0]!.spec.name}:${servers[0]!.spec.port}`
      },
      {
        field: 'third',
        expected: 'r3f:5303',
        actual: `${servers[2]!.spec.name}:${servers[2]!.spec.port}`
      },
      // Beyond the three known packages: named, never indexed off the end of
      // the array, which would throw while building the refusal
      {
        field: 'the extra one is named',
        expected: 'server3',
        actual: servers[3]!.spec.name
      }
    ])
    expect(servers[0]!.spec.name).toBe('parity')
    expect(servers[2]!.spec.name).toBe('r3f')
    expect(servers[3]!.spec.name).toBe('server3')
  })
})

describe('port resolution', () => {
  const probed: number[] = []
  const probe = (): Promise<number> => {
    probed.push(probed.length)
    return Promise.resolve(6000 + probed.length)
  }

  it('probes three distinct origins when nothing is requested', async () => {
    probed.length = 0
    const { origins, sources } = await resolveE2eOrigins({}, probe)
    table('default is a probe', [
      { field: 'parity', expected: 6001, actual: portOf(origins.parity, 'x') },
      { field: 'basic', expected: 6002, actual: portOf(origins.basic, 'x') },
      { field: 'r3f', expected: 6003, actual: portOf(origins.r3f, 'x') },
      {
        field: 'every source is the probe',
        expected: true,
        actual: Object.values(sources).every(v => v === 'probe')
      }
    ])
    expect(origins).toEqual({
      parity: 'http://localhost:6001',
      basic: 'http://localhost:6002',
      r3f: 'http://localhost:6003'
    })
    expect(sources).toEqual({ parity: 'probe', basic: 'probe', r3f: 'probe' })
    // Three servers sharing a port is the defect in another shape: the check
    // aimed at one would grade another
    expect(new Set(Object.values(origins)).size).toBe(3)
  })

  it('honours PARITY_E2E_PORTS positionally without probing', async () => {
    probed.length = 0
    const { origins, sources } = await resolveE2eOrigins(
      { PARITY_E2E_PORTS: '4173, 5199 ,5200' },
      probe
    )
    table('explicit override', [
      { field: 'parity', expected: 4173, actual: portOf(origins.parity, 'x') },
      { field: 'basic', expected: 5199, actual: portOf(origins.basic, 'x') },
      { field: 'r3f', expected: 5200, actual: portOf(origins.r3f, 'x') },
      { field: 'probes taken', expected: 0, actual: probed.length }
    ])
    expect(origins).toEqual({
      parity: 'http://localhost:4173',
      basic: 'http://localhost:5199',
      r3f: 'http://localhost:5200'
    })
    expect(sources.parity).toBe('ports')
    expect(probed).toHaveLength(0)
  })

  it('honours ONE URL var and probes the rest, keeping the origins coherent', async () => {
    // Applying PARITY_E2E_PORTS over documented PARITY_BASIC_URL would probe
    // a server while navigating elsewhere, repeating the defect under test
    probed.length = 0
    const { origins, sources } = await resolveE2eOrigins(
      { PARITY_BASIC_URL: 'http://localhost:5555' },
      probe
    )
    table('one pinned origin', [
      {
        field: 'basic kept',
        expected: 5555,
        actual: portOf(origins.basic, 'x')
      },
      { field: 'basic source', expected: 'url', actual: sources.basic },
      {
        field: 'parity probed',
        expected: 6001,
        actual: portOf(origins.parity, 'x')
      },
      { field: 'r3f probed', expected: 6002, actual: portOf(origins.r3f, 'x') },
      { field: 'probes taken', expected: 2, actual: probed.length }
    ])
    expect(origins.basic).toBe('http://localhost:5555')
    expect(sources.basic).toBe('url')
    expect(sources.parity).toBe('probe')
    // Exactly two probes: the third was not needed
    expect(probed).toHaveLength(2)
  })

  it('refuses a URL var that contradicts its PARITY_E2E_PORTS slot', async () => {
    // Both were named and they disagree. Guessing which was meant is how a run
    // ends up visiting a port nobody chose to start
    let message = ''
    try {
      await resolveE2eOrigins(
        {
          PARITY_BASIC_URL: 'http://localhost:5555',
          PARITY_E2E_PORTS: '4173,5199,5200'
        },
        probe
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    table('contradiction', [
      { field: 'refused', expected: true, actual: message !== '' },
      {
        field: 'names the var',
        expected: true,
        actual: message.includes('PARITY_BASIC_URL')
      },
      {
        field: 'names both ports',
        expected: true,
        actual: message.includes('5555') && message.includes('5199')
      }
    ])
    expect(message).toContain('PARITY_BASIC_URL')
    expect(message).toContain('5555')
    expect(message).toContain('5199')
  })

  it('refuses an origin that names no port', () => {
    // new URL('http://localhost').port is '', which reaches Vite as `--port `
    // and leaves the server on its default: the substitution, one layer down
    expect(() => portOf('http://localhost', 'PARITY_BASIC_URL')).toThrow(
      /names no port/
    )
    expect(portOf('http://localhost:5302', 'PARITY_BASIC_URL')).toBe(5302)
  })

  it('refuses a malformed override instead of half-honouring it', async () => {
    // Two ports honoured and one probed is a run whose evidence covers a
    // different set of servers than the caller asked for, which is the exact
    // confusion the task removes
    const bad = ['4173', '4173,5199', 'a,b,c', '4173,5199,5200,5300', '']
    // AWAITED, because resolveE2eOrigins is async: a malformed value REJECTS
    // rather than throwing, so a synchronous try/catch around the call would
    // miss every refusal and report them all as 'resolved'
    const outcomes = await Promise.all(
      bad.map(async value => {
        try {
          await resolveE2eOrigins({ PARITY_E2E_PORTS: value }, probe)
          return 'resolved'
        } catch (error) {
          return error instanceof Error ? 'refused' : 'other'
        }
      })
    )
    table('malformed overrides', [
      {
        field: 'no ports given falls back to the probe',
        expected: 'resolved',
        actual: outcomes[4]
      },
      { field: 'two ports', expected: 'refused', actual: outcomes[0] },
      { field: 'repeated port', expected: 'refused', actual: outcomes[1] },
      { field: 'non-numeric', expected: 'refused', actual: outcomes[2] },
      { field: 'four ports', expected: 'refused', actual: outcomes[3] }
    ])
    expect(outcomes[4]).toBe('resolved')
    for (const outcome of outcomes.slice(0, 4)) expect(outcome).toBe('refused')
  })

  it('asks the OS for a port that is actually free', async () => {
    // The probe is the default, so a probe that returns a busy port would make
    // every default run fail on a port nothing chose
    const { freePort } = await import('./e2ePorts')
    const first = await freePort()
    const second = await freePort()
    table('two probes', [
      {
        field: 'first is a port',
        expected: true,
        actual: first > 1024 && first < 65536
      },
      { field: 'second differs', expected: true, actual: second !== first }
    ])
    expect(first).toBeGreaterThan(1024)
    expect(second).not.toBe(first)
  })

  it('keeps a requested port when it is free, and REFUSES a busy one', async () => {
    const { freePort } = await import('./e2ePorts')
    const { createServer } = await import('node:net')

    // A port is only busy while something HOLDS it. freePort releases its own
    // socket before returning, so probing once and asking for that number is
    // not a busy-port test, which is what the first version of this did
    const wanted = await freePort()
    const kept = await freePort(wanted)
    table('prefer a free port', [
      { field: 'wanted', expected: true, actual: wanted > 1024 },
      { field: 'kept the requested port', expected: wanted, actual: kept }
    ])
    expect(kept).toBe(wanted)

    const holder = createServer()
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject)
      holder.listen(wanted, '127.0.0.1', resolve)
    })
    let refused = false
    let reason = ''
    try {
      await freePort(wanted)
    } catch (error) {
      refused = true
      reason = error instanceof Error ? error.message : String(error)
    }
    await new Promise<void>(resolve => holder.close(() => resolve()))
    table('prefer a held port', [
      {
        field: 'refused rather than silently moved',
        expected: true,
        actual: refused
      }
    ])
    // It must refuse rather than fall back to an OS-assigned port: a caller
    // that NAMED a port and silently got a different one is the substitution
    // this whole task exists to remove
    expect(refused).toBe(true)
    expect(reason).not.toBe('')
  })
})

describe('the served-root probe, against real servers', () => {
  // One test with a real HTTP server, because the 403-vs-200 claim is the
  // detector's basis and it is a property of Vite. A double returning 403
  // would pass every test above while the real endpoint answered 200 for both
  it('accepts a path the server serves and refuses one it does not', async () => {
    const { createServer } = await import('node:http')
    const { readFileSync } = await import('node:fs')
    // The real predicate: an allow-prefix match, the way Vite's fs.allow works
    const served = [REPO]
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '').replace(/^\/@fs/, ''))
      const allowed = served.some(root => path.startsWith(`${root}/`))
      if (allowed) {
        res.setHeader('content-type', 'application/json')
        res.end(
          readFileSync(
            path === `${REPO}/package.json` ? 'package.json' : 'package.json'
          )
        )
        return
      }
      res.statusCode = 403
      res.end('<h1>403 Restricted</h1>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

    const ours = await probeServedRoot(base, REPO)
    const theirs = await probeServedRoot(base, THEIRS)
    const dead = await probeServedRoot('http://127.0.0.1:1', REPO, 500)

    table('probe verdicts', [
      { field: 'our own root', expected: true, actual: ours.ok },
      { field: 'another checkout', expected: false, actual: theirs.ok },
      { field: 'a dead port', expected: false, actual: dead.ok }
    ])
    await new Promise<void>(resolve => server.close(() => resolve()))

    expect(ours.ok).toBe(true)
    expect(theirs.ok).toBe(false)
    if (!theirs.ok) expect(theirs.reason).toContain('403')
    expect(dead.ok).toBe(false)
  })
})
