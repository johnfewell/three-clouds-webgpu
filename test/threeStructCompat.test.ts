import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REVISION } from 'three'
import { float, struct } from 'three/tsl'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { workspaceOverrides } from '../scripts/port-gates/lockfile-manifests.mjs'
import { log } from './helpers/log'

// three 0.185 replaced the struct layout API with a Proxy. The npm builds of
// the @takram packages read the old shape at import and fail on 0.185. The
// fork builds pinned in pnpm-workspace.yaml read the new one, on stock three

describe('three struct layout API compatibility', () => {
  const DensityProfileLayer = struct(
    { width: 'float', expTerm: 'float', expScale: 'float' },
    'DensityProfileLayer'
  )

  // The proxy API arrived in 0.185. On 0.184 struct() is a plain callable. The
  // library itself uses neither name nor isStructTypeNode
  it.skipIf(Number(REVISION) < 185)(
    'keeps the three 0.185 struct proxy API',
    () => {
      const actual = {
        name: DensityProfileLayer.name,
        isStructTypeNode: (
          DensityProfileLayer as unknown as { isStructTypeNode?: boolean }
        ).isStructTypeNode
      }
      log('struct-0187-api', [
        { field: 'name', expected: 'DensityProfileLayer', actual: actual.name },
        {
          field: 'isStructTypeNode',
          expected: true,
          actual: actual.isStructTypeNode
        }
      ])
      expect(actual.name).toBe('DensityProfileLayer')
      expect(actual.isStructTypeNode).toBe(true)
    }
  )

  it('still constructs struct instances through the proxy', () => {
    const instance = DensityProfileLayer([float(1), float(2), float(3)])
    const actual = (instance as unknown as { isStructNode?: boolean })
      .isStructNode
    log('struct-instance', [{ field: 'isStructNode', expected: true, actual }])
    expect(actual).toBe(true)
  })

  it('imports @takram/three-atmosphere/webgpu on stock three', async () => {
    const atmosphere = await import('@takram/three-atmosphere/webgpu')
    expect(typeof atmosphere.AtmosphereContext).toBe('function')
    const context = new atmosphere.AtmosphereContext()
    log('atmosphere-import', [
      {
        field: 'exports',
        expected: '>= 20',
        actual: Object.keys(atmosphere).length
      },
      {
        field: 'AtmosphereContext',
        expected: 'function',
        actual: typeof atmosphere.AtmosphereContext
      },
      {
        field: 'new AtmosphereContext()',
        expected: 'object',
        actual: typeof context
      }
    ])
    expect(Object.keys(atmosphere).length).toBeGreaterThanOrEqual(20)
  })

  it('imports @takram/three-geospatial/webgpu (FnLayout struct types) on stock three', async () => {
    const geospatial = await import('@takram/three-geospatial/webgpu')
    expect(typeof geospatial.FnLayout).toBe('function')
    log('geospatial-import', [
      {
        field: 'exports',
        expected: '>= 60',
        actual: Object.keys(geospatial).length
      },
      {
        field: 'FnLayout',
        expected: 'function',
        actual: typeof geospatial.FnLayout
      }
    ])
    expect(Object.keys(geospatial).length).toBeGreaterThanOrEqual(60)
  })
})

// Packed installations must resolve peers outside the workspace. Each Three.js
// version gets its own fixture, so filtering or shuffling cannot change it
describe('packed consumer installation compatibility', () => {
  const root = join(import.meta.dirname, '..')
  const temps: string[] = []
  let tarballPath: string

  function run(cwd: string, command: string, args: string[]): string {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 180_000,
      env: {
        ...process.env,
        CI: 'true',
        // no install through a symlinked node_modules
        pnpm_config_verify_deps_before_run: 'false'
      }
    })
  }

  // The fork build overrides the repository itself installs with, so the
  // consumer fixture pins exactly what the development tree runs
  function forkOverrides(): Record<string, string> {
    // a vendored tarball is relative to the repository, not to the fixture
    const overrides = Object.fromEntries(
      Object.entries(workspaceOverrides(root)).map(([name, spec]) => [
        name,
        spec.replace(/^file:\.\//, `file:${root}/`)
      ])
    )
    log('consumer-fork-overrides', overrides)
    expect(Object.keys(overrides).length, 'overrides').toBeGreaterThan(0)
    return overrides
  }

  // @types/three publishes .0 releases only
  const TYPES_FOR: Record<string, string> = { '0.187.0': '0.187.0' }

  function createConsumer(version: string, fork = false): string {
    const dir = mkdtempSync(join(tmpdir(), 'three-clouds-consumer-'))
    temps.push(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer-test',
        type: 'module',
        packageManager: 'pnpm@11.8.0',
        dependencies: {
          three: version,
          '@takram/three-atmosphere': '0.19.1',
          '@takram/three-geospatial': '0.9.1',
          react: '19.2.8',
          '@react-three/fiber': '9.7.0',
          'three-clouds-webgpu': `file:${tarballPath}`,
          typescript: '5.9.2',
          '@types/three': TYPES_FOR[version] ?? version,
          '@types/react': '19.2.2'
        }
      })
    )
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - '.'\n" +
        (fork
          ? 'overrides:\n' +
            Object.entries(forkOverrides())
              .map(([name, spec]) => `  '${name}': ${spec}\n`)
              .join('')
          : '')
    )
    run(dir, 'pnpm', [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      '--config.package-import-method=copy'
    ])
    writeFileSync(
      join(dir, 'test-import.mjs'),
      `
import * as clouds from 'three-clouds-webgpu';
import * as webgpu from 'three-clouds-webgpu/webgpu';
import * as r3f from 'three-clouds-webgpu/r3f';
import * as atmo from '@takram/three-atmosphere/webgpu';
import * as geo from '@takram/three-geospatial/webgpu';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';

// The baked volumes the loader fetches. A bundler or a plain require has to
// reach them THROUGH the exports map, or the consumer copies them in a
// postinstall. createRequire().resolve() is the same resolution a bundler does,
// and it throws ERR_PACKAGE_PATH_NOT_EXPORTED when the map has no entry
const require = createRequire(import.meta.url);
const assets = {};
for (const file of ['local_weather.png', 'shape.bin', 'shape_detail.bin', 'turbulence.png']) {
  const resolved = require.resolve('three-clouds-webgpu/assets/' + file);
  assets[file] = statSync(resolved).size;
}
console.log(JSON.stringify({
  cloudsExports: Object.keys(clouds).length,
  webgpuExports: Object.keys(webgpu).length,
  r3fExports: Object.keys(r3f).length,
  typeofClouds: typeof clouds.clouds,
  typeofWebgpuClouds: typeof webgpu.clouds,
  typeofR3fClouds: typeof r3f.Clouds,
  typeofAtmoContext: typeof atmo.AtmosphereContext,
  typeofFnLayout: typeof geo.FnLayout,
  assetFiles: Object.keys(assets).length,
  shapeBinBytes: assets['shape.bin']
}));
`
    )
    return dir
  }

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  })

  beforeAll(() => {
    const packDir = mkdtempSync(join(tmpdir(), 'three-clouds-pack-'))
    temps.push(packDir)
    // pnpm test is also supported without a preceding pnpm check/build
    run(root, 'pnpm', ['build'])
    run(root, 'pnpm', ['pack', '--pack-destination', packDir])
    const tarballs = readdirSync(packDir).filter(file => file.endsWith('.tgz'))
    expect(tarballs, 'pack must produce one versioned tarball').toHaveLength(1)
    tarballPath = join(packDir, tarballs[0]!)
  }, 400_000)

  function checkImports(dir: string): void {
    const actual = JSON.parse(
      run(dir, process.execPath, ['test-import.mjs'])
    ) as Record<string, string | number>
    const expected = {
      typeofClouds: 'function',
      typeofWebgpuClouds: 'function',
      typeofR3fClouds: 'function',
      typeofAtmoContext: 'function',
      typeofFnLayout: 'function',
      // All four baked volumes resolved through the exports map, and shape.bin
      // is the 2 MB one rather than a stub
      assetFiles: 4,
      shapeBinBytes: 2 * 1024 * 1024
    }
    log(
      'consumer-imports',
      Object.entries(expected).map(([field, value]) => ({
        field,
        expected: value,
        actual: actual[field]
      }))
    )
    expect(actual).toMatchObject(expected)
    expect(actual.cloudsExports).toBeGreaterThanOrEqual(40)
    expect(actual.webgpuExports).toBeGreaterThanOrEqual(40)
    expect(actual.r3fExports).toBeGreaterThanOrEqual(5)
  }

  function typecheckFixture(consumerDir: string, label: string): void {
    writeFileSync(
      join(consumerDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
          strict: true
        },
        include: ['src']
      })
    )
    const srcDir = join(consumerDir, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(
      join(srcDir, 'index.ts'),
      `
import { clouds, CloudsContext, CloudsPassNode } from 'three-clouds-webgpu';
import { clouds as cloudsWebgpu } from 'three-clouds-webgpu/webgpu';
import { Clouds, CloudLayer } from 'three-clouds-webgpu/r3f';
const context = new CloudsContext();
export { clouds, cloudsWebgpu, Clouds, CloudLayer, CloudsPassNode, context };
`
    )
    const output = run(consumerDir, 'pnpm', ['exec', 'tsc', '--noEmit'])
    log(label, [
      {
        field: 'tsc diagnostics',
        expected: '',
        actual: output.trim()
      }
    ])
    expect(output.trim()).toBe('')
  }

  // Proof that the fixture installed the fork builds rather than npm's
  function expectForkBuilds(consumerDir: string, label: string): void {
    const version = (name: string): string =>
      (
        JSON.parse(
          readFileSync(
            join(consumerDir, 'node_modules', name, 'package.json'),
            'utf8'
          )
        ) as { version: string }
      ).version
    const actual = {
      atmosphere: version('@takram/three-atmosphere'),
      geospatial: version('@takram/three-geospatial')
    }
    log(label, [actual])
    expect(actual.atmosphere).toMatch(/^0\.19\.1\+fork\.\d+$/)
    expect(actual.geospatial).toMatch(/^0\.9\.1\+fork\.\d+$/)
  }

  describe('npm builds on stock three 0.187', () => {
    let consumerDir: string
    beforeAll(() => {
      consumerDir = createConsumer('0.187.0')
    }, 200_000)

    it('reproduces the npm builds struct layout error on stock three@0.187.0', () => {
      let caughtError: string | null = null
      try {
        run(consumerDir, process.execPath, ['test-import.mjs'])
      } catch (err: unknown) {
        caughtError =
          (err as { stderr?: string }).stderr ?? (err as Error).message
      }
      log('consumer-import-0187-npm', [
        {
          field: 'fails on struct layout skew',
          expected: true,
          actual: caughtError?.includes(
            "Cannot read properties of undefined (reading 'name')"
          )
        }
      ])
      expect(caughtError).toContain(
        "Cannot read properties of undefined (reading 'name')"
      )
      expect(caughtError).toContain('@takram/three-atmosphere/build/webgpu.js')
    })
  })

  describe('fork builds on stock three 0.187', () => {
    let consumerDir: string
    beforeAll(() => {
      consumerDir = createConsumer('0.187.0', true)
    }, 200_000)

    it('imports cleanly across all export subpaths on stock three@0.187.0', () => {
      expectForkBuilds(consumerDir, 'consumer-fork-versions-0187')
      checkImports(consumerDir)
    })

    it('typechecks the import-only NodeNext fixture on three@0.187.0', () => {
      typecheckFixture(consumerDir, 'consumer-typecheck-0187-fork')
    })
  })
})
