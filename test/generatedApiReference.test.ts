import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  API_PATH,
  checkApiReference,
  classifyExport,
  collectApi,
  renderApiReference,
  type ApiEntry
} from '../scripts/docs/api-reference.mjs'
import { CloudLayer } from '../src/CloudLayer'
import { CloudLayers } from '../src/CloudLayers'
import { experimentalDefaults } from '../src/experimental/options'
import { defaults, qualityPresets } from '../src/qualityPresets'
import { log } from './helpers/log'

const ROOT = resolve(import.meta.dirname, '..')
const runtime = {
  CloudLayer,
  CloudLayers,
  experimentalDefaults,
  defaults,
  qualityPresets
}
let api: ApiEntry[]
let generated: string

beforeAll(() => {
  api = collectApi(ROOT)
  generated = renderApiReference(ROOT, runtime, api)
})

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading)
  if (start < 0) throw new Error(`Missing section ${heading}`)
  return markdown.slice(start + heading.length).split('\n## ')[0]!
}

function localLinks(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[^\n]*\n[\s\S]*?\n```/g, '')
  return [...withoutCode.matchAll(/\]\(([^)]+)\)/g)]
    .map(match => match[1]!)
    .filter(link => !/^(?:[a-z]+:|\/\/)/i.test(link))
}

function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map(match =>
    match[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-')
  )
}

describe('generated consumer API reference', () => {
  it('the actual generated document matches current source metadata and runtime defaults', () => {
    log('generated-api', {
      exports: api.length,
      bytes: Buffer.byteLength(generated)
    })
    expect(api.length).toBeGreaterThan(0)
    expect(readFileSync(resolve(ROOT, API_PATH), 'utf8')).toBe(generated)
    expect(() => checkApiReference(ROOT, generated)).not.toThrow()
    expect(generated).not.toMatch(
      /\/Users\/|node_modules|import\("\/|\.\.\. \d+ more/
    )
    expect(generated).not.toMatch(/\bcw-[a-z0-9]/)
  })

  it('classifies every real export and rejects unreviewed module families', () => {
    const names = api.map(entry => `${entry.entry}:${entry.name}`)
    log(
      'api-groups',
      Object.fromEntries(
        [...new Set(api.map(entry => entry.group))].map(group => [
          group,
          api.filter(entry => entry.group === group).length
        ])
      )
    )
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('root:clouds')
    expect(names).toContain('r3f:Clouds')
    expect(
      api.find(entry => entry.name === 'createHashJitterTexture')?.group
    ).toBe('Reference and testing support')
    expect(() =>
      classifyExport('unreviewed', 'src/new-module.ts', 'root')
    ).toThrow('Unclassified public export')
  })

  it('shows recommended signatures, units, mutation, prerequisites and ownership', () => {
    const recommended = section(
      generated,
      '## Recommended integration and configuration'
    )
    for (const required of [
      '### clouds',
      '### CloudsContext',
      '### CloudsPassNode',
      '### loadBakedCloudTextures',
      'Units:',
      'Domain:',
      'Mutation:',
      'Requires:',
      'Ownership:'
    ]) {
      expect(recommended, required).toContain(required)
    }
    const pass = api.find(
      entry => entry.entry === 'root' && entry.name === 'CloudsPassNode'
    )!
    const context = api.find(
      entry => entry.entry === 'root' && entry.name === 'CloudsContext'
    )!
    expect(
      pass.members.find(member => member.name === 'dispose')?.documentation
    ).toContain('not the context')
    expect(
      context.members.find(member => member.name === 'time')?.documentation
    ).toContain('Seconds')
    expect(
      context.members.find(member => member.name === 'sunDirection')
        ?.documentation
    ).toContain('ECEF')
    expect(pass.members.some(member => member.name.startsWith('_'))).toBe(false)
    expect(pass.members.some(member => member.name === 'inputVersion')).toBe(
      false
    )
    log('api-semantic-fields', {
      members: pass.members.length + context.members.length,
      ownership: true,
      units: true
    })
  })

  it('renders every current experimental default and rejects the original all-false claim', () => {
    const options = section(generated, '### Experimental options')
    for (const [name, value] of Object.entries(experimentalDefaults)) {
      expect(options).toContain(`| \`${name}\` | \`${value}\` |`)
    }
    const enabled = Object.entries(experimentalDefaults).filter(
      ([, value]) => value
    )
    expect(enabled.length).toBeGreaterThan(0)
    const allFalse = Object.fromEntries(
      Object.keys(experimentalDefaults).map(name => [name, false])
    )
    const incorrect = renderApiReference(
      ROOT,
      { ...runtime, experimentalDefaults: allFalse },
      api
    )
    expect(() => checkApiReference(ROOT, incorrect)).toThrow(
      'Stale docs/API.md'
    )
    log('api-experimental-defaults', {
      enabled: enabled.map(([name]) => name),
      staleAllFalseRejected: true
    })
  })

  it('preserves constructors, parameter properties and inherited option fields', () => {
    const find = (name: string): ApiEntry =>
      api.find(entry => entry.entry === 'root' && entry.name === name)!
    const layer = find('CloudLayer')
    expect(
      layer.members.find(member => member.name === 'constructor')?.type
    ).toContain('options?: CloudLayerLike')
    expect(find('CloudLayerLike').members.map(member => member.name)).toEqual(
      expect.arrayContaining(['altitude', 'height', 'shadow', 'densityProfile'])
    )
    expect(
      find('DensityProfile').members.find(member => member.name === 'exponent')
        ?.initialExpression
    ).toBe('0')
    const context = find('CloudsContext')
    expect(
      context.members.find(member => member.name === 'coverage')
        ?.initialExpression
    ).toBe('0.3')
    expect(
      context.members.find(member => member.name === 'resolutionScale')
        ?.initialExpression
    ).toBe('defaults.resolutionScale')
    expect(generated.indexOf('### clouds')).toBeLessThan(
      generated.indexOf('### CloudsContext')
    )
    log('api-construction-metadata', {
      constructors: true,
      parameterProperties: true,
      inheritedOptions: true,
      initializers: true
    })
  })

  it('publishes React props, asset readiness and borrowed lifecycle contracts', () => {
    const react = section(generated, '## React adapter')
    for (const name of [
      'Clouds',
      'CloudsProps',
      'CloudsPassContextValue',
      'CloudsAssetState',
      'useClouds',
      'CloudLayer',
      'CloudLayerProps'
    ]) {
      expect(react).toContain(`### /r3f: ${name}`)
    }
    for (const contract of [
      'loading/ready/error',
      'not shader compilation',
      'objects and lazy default jitter are ready inputs',
      'never disposed',
      'explicit null for sky-only',
      'Removed props return to that slot',
      'invalid on unmount'
    ]) {
      expect(react).toContain(contract)
    }
    const props = api.find(
      entry => entry.entry === 'r3f' && entry.name === 'CloudsProps'
    )!
    expect(props.members.map(member => member.name)).toEqual(
      expect.arrayContaining([
        'sceneDepth',
        'coverage',
        'time',
        'frame',
        'qualityPreset',
        'stbnTexture'
      ])
    )
    expect(react).toContain('| `coverage` |')
    expect(react).toContain('| `assets` |')
    log('api-react-contracts', {
      props: props.members.length,
      assetsDistinctFromGpuReadiness: true,
      borrowedLifecycle: true,
      fixedSlots: true
    })
  })

  it('exposes loader failure, diagnostic observation and integration classifications', () => {
    for (const contract of [
      '### CloudTextureLoadError',
      'AbortError is cancellation',
      'no lazy jitter texture is allocated',
      'graph and frame stay unobserved',
      'uninitialized, unknown or non-native WebGPU backend'
    ]) {
      expect(generated).toContain(contract)
    }
    for (const name of [
      'createCloudsIntegration',
      'CloudsIntegration',
      'CloudsIntegrationOptions',
      'CloudsIntegrationTextures',
      'CloudsIntegrationUpdate'
    ]) {
      expect(classifyExport(name, 'src/integration.ts', 'root')).toBe(
        'Recommended integration and configuration'
      )
    }
    expect(generated).toContain('[Integration guide](../INTEGRATION.md)')
    expect(generated).toContain('[Advanced WebGPU wiring](../WEBGPU.md)')
    log('api-final-contracts', {
      cancellation: 'AbortError',
      graph: 'unobserved',
      frame: 'unobserved',
      helperClassification: 'recommended'
    })
  })

  it('tracks preset and layer defaults without a second manually maintained value table', () => {
    const changed = renderApiReference(
      ROOT,
      {
        ...runtime,
        qualityPresets: {
          ...qualityPresets,
          high: { ...qualityPresets.high, resolutionScale: 0.123 }
        },
        CloudLayers: {
          DEFAULT: [new CloudLayer({ altitude: 1234, height: 500 })]
        }
      },
      api
    )
    expect(changed).not.toBe(generated)
    expect(changed).toContain('`0.123`')
    expect(changed).toContain('`1234`')
    expect(() => checkApiReference(ROOT, changed)).toThrow('Stale docs/API.md')
    expect(() =>
      renderApiReference(ROOT, { ...runtime, experimentalDefaults: {} }, api)
    ).toThrow('must not be empty')
    log('api-runtime-default-drift', {
      quality: true,
      layers: true,
      emptyRefused: true
    })
  })

  it('links to existing local declarations, guides and generated headings', () => {
    const links = localLinks(generated)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      const [path, fragment] = link.split('#')
      const target =
        path === ''
          ? resolve(ROOT, API_PATH)
          : resolve(ROOT, dirname(API_PATH), path!)
      expect(existsSync(target), link).toBe(true)
      if (fragment != null && target.endsWith('.md')) {
        expect(headings(readFileSync(target, 'utf8')), link).toContain(fragment)
      }
    }
    log('api-links', { local: links.length })
  })

  it('checks documentation in check, packing and CI without blocking local builds', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    const build = manifest.scripts.build!
    expect(build).not.toContain('docs:api')
    expect(manifest.scripts.typecheck).not.toContain('docs:api')
    const check = manifest.scripts.check!
    expect(check).toContain('pnpm typecheck')
    expect(check).toContain('pnpm docs:api:check')
    expect(check.indexOf('pnpm typecheck')).toBeLessThan(
      check.indexOf('pnpm docs:api:check')
    )
    expect(manifest.scripts.prepack).toBe(
      'node scripts/release/pack-provenance.mjs check && pnpm docs:api:check'
    )
    expect(manifest.scripts['docs:api:check']).toBe(
      'node scripts/docs/api-reference.mjs --check'
    )
    expect(manifest.scripts['docs:api']).toContain(
      'pnpm build:code && node scripts/docs/api-reference.mjs &&'
    )
    const active = '.github/workflows/ci.yml'
    const workflow = readFileSync(resolve(ROOT, active), 'utf8')
    const workflows = workflow.includes('# workflow: private')
      ? [active, '.github/public-workflows/ci.yml']
      : [active]
    for (const path of workflows) {
      expect(readFileSync(resolve(ROOT, path), 'utf8')).toContain(
        'run: pnpm docs:api:check'
      )
    }
    log('api-build-order', { build, check, prepack: manifest.scripts.prepack })
  })
})
