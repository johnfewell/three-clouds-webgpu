import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Vector2, Vector3 } from 'three'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import { workspaceOverrides } from '../scripts/port-gates/lockfile-manifests.mjs'
import { log } from './helpers/log'

// The WebGL fallback recipe: one settings object for the original and the
// port, derived from the migration table, and a shape with exactly two
// branches chosen before any renderer exists

const repoRoot = resolve(import.meta.dirname, '..')
const recipe = join(repoRoot, 'recipes', 'webgl-fallback')
const sourceDir = join(recipe, 'src')

function source(name: string): string {
  return readFileSync(join(sourceDir, name), 'utf8')
}

function stringArrayLiteral(file: string, identifier: string): string[] {
  const sf = ts.createSourceFile(
    file,
    source(file),
    ts.ScriptTarget.ES2022,
    true
  )
  let found: string[] | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier &&
      node.initializer != null
    ) {
      let init: ts.Expression = node.initializer
      if (ts.isAsExpression(init)) init = init.expression
      if (ts.isArrayLiteralExpression(init)) {
        found = init.elements.map(element => {
          if (!ts.isStringLiteral(element))
            throw new Error(`${identifier} holds a non-string element`)
          return element.text
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (found == null) throw new Error(`${identifier} not found in ${file}`)
  return found
}

// PARITY_KEYS read from its source: importing parityState.ts would pull the
// harness's side A module into this program, which it is not written for
function parityKeysFromSource(): string[] {
  const file = join(repoRoot, 'examples', 'parity', 'src', 'parityState.ts')
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  )
  const keys: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'PARITY_KEYS' &&
      node.initializer != null
    ) {
      // The list ends in `as const`
      let init: ts.Expression = node.initializer
      if (ts.isAsExpression(init)) init = init.expression
      if (!ts.isArrayLiteralExpression(init))
        throw new Error('PARITY_KEYS is not an array literal')
      for (const element of init.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue
        const text = (name: string): string | undefined => {
          const property = element.properties.find(
            candidate =>
              ts.isPropertyAssignment(candidate) &&
              ts.isIdentifier(candidate.name) &&
              candidate.name.text === name
          )
          return property != null &&
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.initializer)
            ? property.initializer.text
            : undefined
        }
        const key = text('key')
        if (key == null) throw new Error('a PARITY_KEYS entry has no key')
        const nested = text('nested')
        keys.push(nested != null ? `${nested}.${key}` : key)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (keys.length === 0) throw new Error('PARITY_KEYS read as zero entries')
  return keys
}

// The rows the parity test writes verbatim into docs/MIGRATION.md
function migrationRows(): Array<{ key: string; status: string }> {
  const file = readFileSync(join(repoRoot, 'docs', 'MIGRATION.md'), 'utf8')
  const rows: Array<{ key: string; status: string }> = []
  for (const line of file.split('\n')) {
    const match =
      /^\| ([A-Za-z0-9_.]+) \| (?:true|false) \| (?:true|false) \| ([A-Za-z-]+) \|/.exec(
        line
      )
    if (match != null) rows.push({ key: match[1]!, status: match[2]! })
  }
  if (rows.length === 0)
    throw new Error('the migration table matched zero rows')
  return rows
}

// settings.ts carries only type imports, so its transpiled form runs in Node
async function loadSettingsModule(): Promise<{
  applySettings: (target: object, settings: object, backend: string) => void
  SETTINGS_KEYS: readonly string[]
  PORT_ONLY_KEYS: readonly string[]
}> {
  const js = ts.transpileModule(source('settings.ts'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true
    }
  }).outputText
  if (/^import /m.test(js)) throw new Error('settings.ts has a runtime import')
  const dir = mkdtempSync(join(tmpdir(), 'clouds-fallback-settings-'))
  const path = join(dir, 'settings.mjs')
  writeFileSync(path, js)
  return (await import(pathToFileURL(path).href)) as never
}

describe('the WebGL fallback recipe', () => {
  it('lists exactly the keys the migration table marks ported', () => {
    const keys = stringArrayLiteral('settings.ts', 'SETTINGS_KEYS')
    const ported = migrationRows()
      .filter(row => row.status === 'ported')
      .map(row => row.key)
    const missing = ported.filter(key => !keys.includes(key))
    const extra = keys.filter(key => !ported.includes(key))
    log('fallback-keys', [
      { field: 'ported rows', expected: '> 0', actual: ported.length },
      { field: 'recipe keys', expected: ported.length, actual: keys.length },
      { field: 'missing', expected: '', actual: missing.join(' ') },
      { field: 'extra', expected: '', actual: extra.join(' ') }
    ])
    expect(ported.length).toBeGreaterThan(0)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(new Set(keys).size).toBe(keys.length)
    // And directly against the list the table is generated from
    expect([...keys].sort()).toEqual([...parityKeysFromSource()].sort())
  })

  it('port-only keys are outside the table and are declared', () => {
    const portOnly = stringArrayLiteral('settings.ts', 'PORT_ONLY_KEYS')
    const tableKeys = new Set(migrationRows().map(row => row.key))
    expect(portOnly.length).toBeGreaterThan(0)
    for (const key of portOnly) expect(tableKeys.has(key)).toBe(false)
  })

  it('writes scalars, copies vectors, maps splitMode, and warns once per port-only key on WebGL', async () => {
    const { applySettings } = await loadSettingsModule()
    const webgl = {
      coverage: 0,
      localWeatherVelocity: new Vector2(),
      shapeOffset: new Vector3(),
      clouds: { minStepSize: 0 },
      shadow: { splitMode: 'practical', mapSize: new Vector2(512, 512) }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const settings = {
        coverage: 0.4,
        localWeatherVelocity: { x: 0.001, y: 0 },
        shapeOffset: new Vector3(1, 2, 3),
        clouds: { minStepSize: 75 },
        shadow: { splitMode: 1, mapSize: { x: 256, y: 256 } },
        time: 5,
        experimental: { rainShafts: true }
      }
      applySettings(webgl, settings, 'webgl')
      applySettings(webgl, settings, 'webgl')
      const actual = {
        coverage: webgl.coverage,
        velocity: webgl.localWeatherVelocity.toArray(),
        offset: webgl.shapeOffset.toArray(),
        minStepSize: webgl.clouds.minStepSize,
        splitMode: webgl.shadow.splitMode,
        mapSize: webgl.shadow.mapSize.toArray(),
        time: (webgl as { time?: unknown }).time,
        warnings: warn.mock.calls.length
      }
      log('fallback-apply-webgl', [
        { field: 'coverage', expected: 0.4, actual: actual.coverage },
        {
          field: 'splitMode',
          expected: 'logarithmic',
          actual: actual.splitMode
        },
        {
          field: 'warnings for 2 port-only keys, applied twice',
          expected: 2,
          actual: actual.warnings
        }
      ])
      expect(actual).toEqual({
        coverage: 0.4,
        velocity: [0.001, 0],
        offset: [1, 2, 3],
        minStepSize: 75,
        splitMode: 'logarithmic',
        mapSize: [256, 256],
        time: undefined,
        warnings: 2
      })
      // The port keeps the index and takes the port-only keys
      const webgpu = {
        shadow: { splitMode: 2 },
        time: 0,
        experimental: {}
      }
      applySettings(webgpu, { shadow: { splitMode: 1 }, time: 5 }, 'webgpu')
      expect(webgpu.shadow.splitMode).toBe(1)
      expect(webgpu.time).toBe(5)
    } finally {
      warn.mockRestore()
    }
  })

  it('pins the same baseline as the other recipes plus the original clouds package', () => {
    const manifest = JSON.parse(
      readFileSync(join(recipe, 'package.json'), 'utf8')
    ) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(manifest.dependencies).toMatchObject({
      three: '0.185.1',
      '@takram/three-clouds': '0.7.6',
      '@takram/three-atmosphere': '0.19.1',
      '@takram/three-geospatial': '0.9.1',
      postprocessing: '6.39.4',
      'three-clouds-webgpu': 'file:./vendor/three-clouds-webgpu.tgz'
    })
    expect(manifest.dependencies.react).toBeUndefined()
    expect(manifest.devDependencies['@types/three']).toBe('0.185.0')
    expect(manifest.scripts.build).toBe('tsc --noEmit && vite build')
    const config = JSON.parse(
      readFileSync(join(recipe, 'tsconfig.json'), 'utf8')
    ) as { compilerOptions: { strict: boolean; moduleResolution: string } }
    expect(config.compilerOptions.strict).toBe(true)
    expect(config.compilerOptions.moduleResolution).toBe('bundler')
    const yaml = readFileSync(join(recipe, 'pnpm-workspace.yaml'), 'utf8')
    expect(yaml).toContain('autoInstallPeers: false')
    // The original depends on the atmosphere package, so the URL override is
    // a sub-dependency and the guard must be off, as in the repository
    expect(yaml).toContain('blockExoticSubdeps: false')
    expect(workspaceOverrides(recipe)).toEqual(workspaceOverrides(repoRoot))
    expect(readFileSync(join(recipe, 'index.html'), 'utf8')).toContain(
      '/src/main.ts'
    )
  })

  it('decides the backend before any renderer and keeps exactly two branches', () => {
    const files = Object.fromEntries(
      readdirSync(sourceDir)
        .filter(file => file.endsWith('.ts'))
        .map(file => [file, source(file)])
    )
    const all = Object.values(files).join('\n')
    const imports = [...all.matchAll(/from '([^']+)'/g)].map(m => m[1]!)
    const checks: Record<string, boolean> = {
      detectsBeforeRenderers: /await detectBackend\(\)/.test(files['main.ts']!),
      detectReadsNavigatorGpu: /navigator[\s\S]*\.gpu/.test(
        files['detect.ts']!
      ),
      detectRequestsAdapter: /requestAdapter\(\)/.test(files['detect.ts']!),
      overrideParameter: /get\('backend'\)/.test(files['detect.ts']!),
      webgpuInitsAndRefuses:
        /renderer\.init\(\)/.test(files['webgpu.ts']!) &&
        /assertWebGPUSupported\(renderer\)/.test(files['webgpu.ts']!),
      webgpuUsesHelper: /createCloudsIntegration\(/.test(files['webgpu.ts']!),
      webglUsesOriginal:
        /new WebGLRenderer\(/.test(files['webgl.ts']!) &&
        /new CloudsEffect\(/.test(files['webgl.ts']!) &&
        /new AerialPerspectiveEffect\(/.test(files['webgl.ts']!) &&
        /composer\.render\(/.test(files['webgl.ts']!),
      webglNeverImportsWebGPURenderer: !/three\/webgpu/.test(
        files['webgl.ts']!
      ),
      oneBranchOnly:
        /backend === 'webgpu'\s*\?\s*await startWebGPU\(options\)\s*:\s*await startWebGL\(options\)/.test(
          files['main.ts']!
        ),
      badgeReportsBackend: /badge\.dataset\.backend = backend/.test(
        files['main.ts']!
      ),
      sharedSettingsBothBranches:
        /applySettings\(integration\.context, settings, 'webgpu'\)/.test(
          files['webgpu.ts']!
        ) &&
        /applySettings\(clouds, settings, 'webgl'\)/.test(files['webgl.ts']!),
      fourPublicAssetImports: [
        'local_weather.png',
        'shape.bin',
        'shape_detail.bin',
        'turbulence.png'
      ].every(name =>
        imports.includes(`three-clouds-webgpu/assets/${name}?url`)
      ),
      localImportsOnly: imports.every(path => !path.startsWith('../')),
      noWorkspaceImports: imports.every(path => !path.includes('workspace:'))
    }
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
    log('fallback-shape', [
      {
        field: 'checks',
        expected: Object.keys(checks).length,
        actual: Object.keys(checks).length
      },
      { field: 'failed', expected: '', actual: failed.join(' ') }
    ])
    expect(failed).toEqual([])
  })
})
