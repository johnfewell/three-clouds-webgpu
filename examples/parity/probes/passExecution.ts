// execution-count instrumentation. The e2e
// read path runs cloudsPass TWICE per frame (render + renderLinear)
// Assuming no mechanism, it counts executions per frame on both paths, whether
// readLinear adds one, and which history each resolve blended against. It
// wraps instance methods at runtime (no library change), undone by uninstall()

interface TargetLike {
  readonly width?: number
  readonly height?: number
}

/** Structural view of the fields this probe reads. No library import. */
interface PassLike {
  resolveRT: TargetLike | null
  historyRT: TargetLike | null
  shadowResolveRT?: TargetLike | null
  shadowHistoryRT?: TargetLike | null
}

type AnyFn = (...args: never[]) => unknown

export interface ExecEvent {
  /** Monotonic index across the whole session */
  seq: number
  /** Caller-supplied phase, e.g. "step:3:render" or "readLinear". */
  mark: string
  method: string
  /** Ping-pong identities before the call */
  before: { resolve: number | null; history: number | null }
  /** …and after it, so a swap is visible as a transposition */
  after: { resolve: number | null; history: number | null }
}

export interface ExecReport {
  /**
   * THE CHECK THAT CAN KILL THIS INSTRUMENT: every method the probe expected to
   * wrap, and every one it could not find. An unwrapped method reports ZERO
   * calls, indistinguishable from an uncalled one, so `wrappedAll: false` means
   * the counts below are a FAILED MEASUREMENT, not data.
   */
  instrument: { wrapped: string[]; missing: string[]; wrappedAll: boolean }
  events: ExecEvent[]
  /** method -> call count, per mark */
  perMark: Record<string, Record<string, number>>
  /**
   * For each colour resolve, the buffer it WROTE and the buffer it BLENDED
   * AGAINST, plus whether that blend source was the immediately-previous
   * resolve's output. `blendedAgainstPrevious: false` on a steady-state frame is
   * the ordering-family signature the lane is looking for.
   */
  resolveChain: Array<{
    seq: number
    mark: string
    wrote: number | null
    blendedAgainst: number | null
    blendedAgainstPrevious: boolean | null
    /** What the composite samples afterwards (outputTextureNode = historyRT) */
    compositeSamples: number | null
    compositeSamplesJustWritten: boolean | null
  }>
}

interface Installed {
  mark: (label: string) => void
  report: () => ExecReport
  reset: () => void
  uninstall: () => void
}

export function installPassExecutionProbe(passIn: object): Installed {
  const pass = passIn as PassLike & Record<string, unknown>
  let nextId = 1
  const ids = new WeakMap<object, number>()
  const idOf = (rt: TargetLike | null | undefined): number | null => {
    if (rt == null) return null
    const key = rt as object
    let id = ids.get(key)
    if (id == null) {
      id = nextId++
      ids.set(key, id)
    }
    return id
  }
  let seq = 0
  let mark = 'init'
  const events: ExecEvent[] = []
  const originals = new Map<string, AnyFn>()

  const snapshot = (): { resolve: number | null; history: number | null } => ({
    resolve: idOf(pass.resolveRT),
    history: idOf(pass.historyRT)
  })

  const wrapped: string[] = []
  const missing: string[] = []

  const wrap = (method: string): void => {
    const original = pass[method]
    if (typeof original !== 'function') {
      // Loud, not silent: a rename upstream must not degrade into a zero count
      missing.push(method)
      return
    }
    wrapped.push(method)
    const fn = original as AnyFn
    originals.set(method, fn)
    pass[method] = function wrapped(this: unknown, ...args: never[]): unknown {
      const before = snapshot()
      const result = fn.apply(this, args)
      events.push({
        seq: seq++,
        mark,
        method,
        before,
        after: snapshot()
      })
      return result
    }
  }

  // updateBefore is the per-render entry point, the three render*Pass methods
  // are the accumulators bbui touched, and the swap re-points the composite
  for (const m of [
    'updateBefore',
    'renderResolvePass',
    'swapResolveBuffers',
    'renderShadowPass',
    'renderShadowLengthResolvePass'
  ]) {
    wrap(m)
  }

  const buildReport = (): ExecReport => {
    const perMark: Record<string, Record<string, number>> = {}
    for (const e of events) {
      perMark[e.mark] ??= {}
      perMark[e.mark]![e.method] = (perMark[e.mark]![e.method] ?? 0) + 1
    }

    // A colour resolve WRITES its pre-call resolveRT and BLENDS AGAINST its
    // pre-call historyRT. The swap that follows makes the written buffer the
    // history the composite samples, if the plumbing is healthy
    const resolveChain: ExecReport['resolveChain'] = []
    let previousWrote: number | null = null
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!
      if (e.method !== 'renderResolvePass') continue
      const wrote = e.before.resolve
      const blendedAgainst = e.before.history
      // The composite samples historyRT. Find the next swap after this resolve
      const nextSwap = events
        .slice(i + 1)
        .find(x => x.method === 'swapResolveBuffers')
      const compositeSamples = nextSwap
        ? nextSwap.after.history
        : e.after.history
      resolveChain.push({
        seq: e.seq,
        mark: e.mark,
        wrote,
        blendedAgainst,
        blendedAgainstPrevious:
          previousWrote == null ? null : blendedAgainst === previousWrote,
        compositeSamples,
        compositeSamplesJustWritten:
          compositeSamples == null ? null : compositeSamples === wrote
      })
      previousWrote = wrote
    }
    return {
      instrument: {
        wrapped: [...wrapped],
        missing: [...missing],
        wrappedAll: missing.length === 0
      },
      events: [...events],
      perMark,
      resolveChain
    }
  }

  if (missing.length > 0) {
    console.error(
      `[passExecution] REFUSING to vouch for these counts: could not wrap ` +
        `${missing.join(', ')}. A method that was never wrapped reports zero ` +
        `calls, which reads as "never executed". Treat this run as a failed ` +
        `measurement, not as data.`
    )
  }

  return {
    mark: (label: string) => {
      mark = label
    },
    report: buildReport,
    reset: () => {
      events.length = 0
      seq = 0
    },
    uninstall: () => {
      for (const [method, fn] of originals) {
        pass[method] = fn
      }
      originals.clear()
    }
  }
}
