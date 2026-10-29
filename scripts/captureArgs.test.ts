// the capture parser refuses help, typos, and missing values, and a
// valid argv still means what the old indexOf parser meant. This file imports
// the parser only. It does not import or spawn capture.mjs.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { log } from '../test/helpers/log'
import {
  CAPTURE_FLAGS,
  formatCaptureUsage,
  parseCaptureArgs,
  type CaptureArgsResult,
  type CaptureValues
} from './captureArgs.mjs'
import { formatUsage } from './cliArgs.mjs'
import {
  formatSetupAssetsUsage,
  parseSetupAssetsArgs
} from './setupAssetsArgs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The pre-fix capture parser: first indexOf wins, unknown tokens ignored */
function legacyCapture(args: readonly string[]): CaptureValues {
  const argVal = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`)
    if (idx < 0 || idx + 1 >= args.length) return undefined
    const value = args[idx + 1]
    return value
  }
  const phaseRaw = argVal('phase')
  const onlyRaw = argVal('only-phase')
  return {
    phaseFilter: phaseRaw != null ? Number(phaseRaw) : undefined,
    onlyPhaseFilter: onlyRaw != null ? Number(onlyRaw) : undefined,
    caseFilter: argVal('case'),
    sabotageMode: argVal('sabotage'),
    allowSkip: args.includes('--allow-skip'),
    keepLinear: args.includes('--keep-linear'),
    outDirOverride: argVal('out'),
    // The legacy parser had no such flag: always the reference profile
    atmosphereProfile: undefined
  }
}

function requireRefusal(result: CaptureArgsResult, argument: string): string {
  if (result.ok) {
    throw new Error(`expected refusal of ${argument}`)
  }
  expect(result.help).toBe(false)
  expect(result.argument).toBe(argument)
  expect(result.error).toContain(argument)
  return result.error
}

describe('parseCaptureArgs', () => {
  it('help: --help and -h request usage and do not accept a run', () => {
    const rows = ['--help', '-h', '--help --nope', '--phase --help'].map(
      spec => {
        const argv = spec.split(' ')
        const result = parseCaptureArgs(argv)
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error('narrow')
        expect(result.help).toBe(true)
        return { argv: spec, help: result.help, ok: result.ok }
      }
    )
    log('help', rows)
  })

  it('refuses an unknown flag by name', () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['--nope'], '--nope'],
      [['--phase', '1', 'extra'], 'extra'],
      [['positional'], 'positional']
    ]
    const rows = cases.map(([argv, argument]) => {
      const error = requireRefusal(parseCaptureArgs(argv), argument)
      return { argv: argv.join(' '), argument, error }
    })
    log('unknown', rows)
  })

  it('refuses a typo of a real flag by name', () => {
    const rows = [
      ['--cases', 'cumulus'],
      ['--phases', '1'],
      ['--allow-skips']
    ].map(argv => {
      const argument = argv[0] ?? ''
      const error = requireRefusal(parseCaptureArgs(argv), argument)
      return { argv: argv.join(' '), argument, error }
    })
    log('typo', rows)
  })

  it('refuses a known flag that is missing its value', () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['--phase'], '--phase'],
      [['--only-phase'], '--only-phase'],
      [['--case'], '--case'],
      [['--sabotage'], '--sabotage'],
      [['--out'], '--out'],
      [['--phase', '--case', 'cumulus'], '--phase'],
      [['--out', '--keep-linear'], '--out'],
      [['--phase', '1', '--case'], '--case'],
      [['--phase', '1', '--phase'], '--phase']
    ]
    const rows = cases.map(([argv, argument]) => {
      const error = requireRefusal(parseCaptureArgs(argv), argument)
      expect(error).toContain('requires a value')
      return { argv: argv.join(' '), argument, error }
    })
    log('missing-value', rows)
  })

  it('refuses a non-numeric value for a numeric flag', () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['--phase', 'foo'], '--phase'],
      [['--phase', '0x10'], '--phase'],
      [['--only-phase', 'NaN'], '--only-phase']
    ]
    const rows = cases.map(([argv, argument]) => {
      const error = requireRefusal(parseCaptureArgs(argv), argument)
      expect(error).toContain('expects a number')
      return { argv: argv.join(' '), argument, error }
    })
    log('non-numeric', rows)
  })

  it('parses a valid invocation to the previous result', () => {
    const invocations: readonly (readonly string[])[] = [
      [],
      ['--phase', '2'],
      ['--phase', '0'],
      ['--phase', '08'],
      ['--phase', '1.5'],
      ['--phase', '-1'],
      ['--phase', '+2'],
      ['--phase', '1e2'],
      ['--only-phase', '3'],
      ['--only-phase', '0'],
      ['--case', 'cumulus'],
      ['--sabotage', 'exposure'],
      ['--allow-skip'],
      ['--keep-linear'],
      ['--out', 'tmp/out'],
      ['--out', '<tmp>/abs'],
      ['--keep-linear', '--phase', '2', '--allow-skip'],
      ['--phase', '1', '--phase', '9'],
      ['--case', 'a', '--case', 'b'],
      [
        '--phase',
        '1',
        '--only-phase',
        '1',
        '--case',
        'foo',
        '--sabotage',
        'exposure',
        '--allow-skip',
        '--keep-linear',
        '--out',
        'rel/dir'
      ]
    ]
    const rows = invocations.map(argv => {
      const result = parseCaptureArgs(argv)
      const expected = legacyCapture(argv)
      if (!result.ok) {
        throw new Error(`${argv.join(' ')} refused: ${result.error}`)
      }
      expect(result.help).toBe(false)
      expect(result.values).toEqual(expected)
      return {
        argv: argv.join(' ') || '(none)',
        phase: expected.phaseFilter,
        onlyPhase: expected.onlyPhaseFilter,
        case: expected.caseFilter,
        sabotage: expected.sabotageMode,
        allowSkip: expected.allowSkip,
        keepLinear: expected.keepLinear,
        out: expected.outDirOverride
      }
    })
    log('valid-invocation', rows)
  })

  it('usage text is the flag table, not a second list', () => {
    const usage = formatCaptureUsage()
    expect(usage).toBe(
      formatUsage('pnpm --filter parity capture', CAPTURE_FLAGS)
    )
    const rows = CAPTURE_FLAGS.map(flag => {
      expect(usage).toContain(`--${flag.name}`)
      expect(usage).toContain(flag.help)
      for (const alias of flag.aliases ?? []) expect(usage).toContain(alias)
      return { flag: flag.name, help: flag.help }
    })
    log('usage', rows)
  })

  it('the parser module does not touch the filesystem or exit the process', () => {
    const src = readFileSync(join(ROOT, 'scripts/cliArgs.mjs'), 'utf8')
    expect(src).not.toContain('node:fs')
    expect(src).not.toContain('node:child_process')
    expect(src).not.toContain('process.exit')
    log('pure', { filesystem: false, exit: false })
  })
})

describe('parseCaptureArgs --atmosphere-profile', () => {
  it('is unset by default, so a normal capture stays on the reference profile', () => {
    const rows = [[], ['--out', 'tmp/out'], ['--case', 'baseline-medium']].map(
      argv => {
        const result = parseCaptureArgs(argv)
        if (!result.ok) throw new Error(`${argv.join(' ')} refused`)
        expect(result.values.atmosphereProfile).toBeUndefined()
        return { argv: argv.join(' ') || '(none)', profile: 'unset' }
      }
    )
    log('profile-default', rows)
  })

  // ADR-013 Amendment 6: lookup-both (equal to the new default) and the
  // raymarch-256 opt-in (the former pin) are the two capture profiles
  it('accepts lookup-both and raymarch-256 with an --out outside parity/results', () => {
    const rows = (['lookup-both', 'raymarch-256'] as const).flatMap(profile =>
      [
        ['--out', 'test-results/lookup-qualification'],
        ['--out', '<tmp>/lookup-qualification'],
        ['--out', join(ROOT, 'test-results', 'lq')]
      ].map(out => {
        const argv = ['--atmosphere-profile', profile, '--case', 'x', ...out]
        const result = parseCaptureArgs(argv)
        if (!result.ok)
          throw new Error(`${argv.join(' ')} refused: ${result.error}`)
        expect(result.values.atmosphereProfile).toBe(profile)
        expect(result.values.outDirOverride).toBe(out[1])
        return { out: out[1], profile: result.values.atmosphereProfile }
      })
    )
    log('profile-accepted', rows)
  })

  it('refuses without an --out outside parity/results, and any other profile', () => {
    const cases: readonly (readonly string[])[] = [
      ['--atmosphere-profile', 'lookup-both'],
      ['--atmosphere-profile', 'lookup-both', '--out', 'parity/results'],
      ['--atmosphere-profile', 'lookup-both', '--out', 'parity/results/0'],
      [
        '--atmosphere-profile',
        'lookup-both',
        '--out',
        'test-results/../parity/results/x'
      ],
      [
        '--atmosphere-profile',
        'lookup-both',
        '--out',
        join(ROOT, 'parity', 'results', '3')
      ],
      ['--atmosphere-profile', 'raymarch-256'],
      ['--atmosphere-profile', 'raymarch-256', '--out', 'parity/results/1'],
      ['--atmosphere-profile', 'reference', '--out', 'test-results/lq'],
      ['--atmosphere-profile', 'samples-scene-64', '--out', 'test-results/lq']
    ]
    const rows = cases.map(argv => {
      const error = requireRefusal(
        parseCaptureArgs(argv),
        '--atmosphere-profile'
      )
      return { argv: argv.slice(1).join(' '), error }
    })
    log('profile-refused', rows)
  })

  it('--help still wins over the profile checks', () => {
    const result = parseCaptureArgs([
      '--atmosphere-profile',
      'lookup-both',
      '--help'
    ])
    expect(result.ok).toBe(true)
    expect(result.help).toBe(true)
    log('profile-help', { help: result.help })
  })
})

describe('parseSetupAssetsArgs', () => {
  it('help does not require --example or --from', () => {
    for (const argv of [['--help'], ['-h'], ['--help', '--example']]) {
      const result = parseSetupAssetsArgs(argv)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('narrow')
      expect(result.help).toBe(true)
    }
    const usage = formatSetupAssetsUsage()
    expect(usage).toContain('--example')
    expect(usage).toContain('--from')
    expect(usage).toContain('--help')
    expect(usage).toContain('-h')
    log('setup-help', { help: true, namesExample: true, namesFrom: true })
  })

  it('refuses an unknown flag before a copy would be allowed', () => {
    const result = parseSetupAssetsArgs([
      '--example',
      'examples/parity',
      '--from',
      'three-clouds-webgpu',
      '--extra'
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('narrow')
    expect(result.argument).toBe('--extra')
    expect(result.error).toContain('--extra')
    log('setup-unknown', { argument: result.argument, error: result.error })
  })

  it('names a missing required argument', () => {
    const missingExample = parseSetupAssetsArgs(['--from', 'pkg'])
    const missingFrom = parseSetupAssetsArgs(['--example', 'examples/parity'])
    const missingBoth = parseSetupAssetsArgs([])
    for (const result of [missingExample, missingBoth]) {
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('narrow')
      expect(result.argument).toBe('--example')
      expect(result.error).toContain('--example')
    }
    expect(missingFrom.ok).toBe(false)
    if (missingFrom.ok) throw new Error('narrow')
    expect(missingFrom.argument).toBe('--from')
    log('setup-required', {
      neither: missingBoth.ok ? '' : missingBoth.argument,
      fromOnly: missingExample.ok ? '' : missingExample.argument,
      exampleOnly: missingFrom.argument
    })
  })

  it('names a valued flag that was not given a value', () => {
    const result = parseSetupAssetsArgs([
      '--example',
      '--from',
      'three-clouds-webgpu'
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('narrow')
    expect(result.argument).toBe('--example')
    expect(result.error).toContain('requires a value')
    log('setup-missing-value', {
      argument: result.argument,
      error: result.error
    })
  })

  it('parses a valid invocation', () => {
    const result = parseSetupAssetsArgs([
      '--from',
      '@takram/three-clouds',
      '--example',
      'examples/parity'
    ])
    expect(result).toEqual({
      ok: true,
      help: false,
      values: { example: 'examples/parity', from: '@takram/three-clouds' }
    })
    log('setup-valid', {
      example: 'examples/parity',
      from: '@takram/three-clouds'
    })
  })
})
