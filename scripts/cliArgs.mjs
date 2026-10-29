// Side-effect-free argv parsing
//
// The flag table is the only list of accepted options. formatUsage renders
// it, and any token that is not in it is refused. A valued flag whose next
// token is missing, or is itself a flag, is refused too: swallowing that
// token is how a typo used to fall through into the flag's default action

/**
 * @typedef {object} FlagSpec
 * @property {string} name
 * @property {readonly string[]} [aliases] full tokens, such as '-h'
 * @property {string} [takes] value placeholder; absent means a boolean flag
 * @property {'number' | 'string'} [kind]
 * @property {boolean} [required]
 * @property {string} help
 */

/**
 * @typedef {Record<string, string | number | boolean | undefined>} FlagValues
 */

/**
 * @typedef {object} ParseOk
 * @property {true} ok
 * @property {boolean} help
 * @property {FlagValues} values
 */

/**
 * @typedef {object} ParseErr
 * @property {false} ok
 * @property {false} help
 * @property {string} argument
 * @property {string} error
 */

// Whole-token decimal / scientific form. Number('0x10') and Number('foo')
// are deliberately not values: the former is 16 and the latter is NaN, and
// either one used to be handed to the caller as if the flag had been set
const NUMBER_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * @param {FlagSpec} flag
 */
function flagToken(flag) {
  return `--${flag.name}`
}

/**
 * @param {FlagSpec} flag
 * @param {string} token
 */
function matches(flag, token) {
  return token === flagToken(flag) || (flag.aliases ?? []).includes(token)
}

/**
 * @param {readonly FlagSpec[]} flags
 * @param {string} token
 */
function isKnownToken(flags, token) {
  return flags.some(flag => matches(flag, token))
}

/**
 * @param {readonly FlagSpec[]} flags
 * @param {FlagSpec} flag
 * @param {string} token
 */
function isFlagLike(flags, flag, token) {
  if (isKnownToken(flags, token)) return true
  if (flag.kind === 'number' && NUMBER_TOKEN.test(token)) return false
  return token.startsWith('-')
}

/**
 * @param {readonly string[]} argv
 * @param {readonly FlagSpec[]} flags
 * @returns {ParseOk | ParseErr}
 */
export function parseArgs(argv, flags) {
  /** @type {FlagValues} */
  const values = {}
  for (const flag of flags) {
    values[flag.name] = flag.takes ? undefined : false
  }

  let help = false
  /** @type {{ argument: string, error: string } | null} */
  let failure = null
  /**
   * @param {string} argument
   * @param {string} error
   */
  const fail = (argument, error) => {
    if (failure == null) failure = { argument, error }
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token == null) continue
    const flag = flags.find(candidate => matches(candidate, token))
    if (flag == null) {
      fail(token, `unrecognised argument: ${token}`)
      continue
    }
    if (flag.name === 'help') {
      help = true
      values.help = true
      continue
    }
    if (!flag.takes) {
      values[flag.name] = true
      continue
    }
    const next = argv[i + 1]
    const name = flagToken(flag)
    if (next == null || isFlagLike(flags, flag, next)) {
      fail(name, `${name} requires a value`)
      continue
    }
    if (flag.kind === 'number') {
      if (!NUMBER_TOKEN.test(next)) {
        fail(name, `${name} expects a number, got ${next}`)
        i += 1
        continue
      }
      // indexOf kept the first occurrence. A later copy is consumed so its
      // value is not reported as an unrecognised positional
      if (values[flag.name] === undefined) values[flag.name] = Number(next)
      i += 1
      continue
    }
    if (values[flag.name] === undefined) values[flag.name] = next
    i += 1
  }

  if (help) return { ok: true, help: true, values }
  if (failure != null) return { ok: false, help: false, ...failure }

  for (const flag of flags) {
    if (!flag.required || values[flag.name] != null) continue
    const name = flagToken(flag)
    return {
      ok: false,
      help: false,
      argument: name,
      error: `missing required argument: ${name}`
    }
  }

  return { ok: true, help: false, values }
}

/**
 * @param {string} invocation
 * @param {readonly FlagSpec[]} flags
 */
export function formatUsage(invocation, flags) {
  const rows = flags.map(flag => {
    const names = [`--${flag.name}`, ...(flag.aliases ?? [])].join(', ')
    const left = flag.takes ? `${names} <${flag.takes}>` : names
    return { left, help: flag.help }
  })
  const width = rows.reduce((max, row) => Math.max(max, row.left.length), 0)
  const synopsis = flags
    .map(flag => {
      const body = flag.takes
        ? `--${flag.name} <${flag.takes}>`
        : `--${flag.name}`
      return flag.required ? body : `[${body}]`
    })
    .join(' ')
  const lines = [`Usage: ${invocation} ${synopsis}`, '']
  for (const row of rows) {
    lines.push(`  ${row.left.padEnd(width)}  ${row.help}`)
  }
  return lines.join('\n')
}
