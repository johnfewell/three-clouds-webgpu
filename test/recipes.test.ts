import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createRoot } from '@react-three/fiber'
import { act } from 'react'
import { PCFShadowMap, PCFSoftShadowMap, PerspectiveCamera } from 'three'
import ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'

import { workspaceOverrides } from '../scripts/port-gates/lockfile-manifests.mjs'
import { log } from './helpers/log'

const repoRoot = resolve(import.meta.dirname, '..')
const recipesRoot = join(repoRoot, 'recipes')
const names = ['vanilla', 'r3f'] as const
const assetPaths = [
  'local_weather.png',
  'shape.bin',
  'shape_detail.bin',
  'turbulence.png'
].map(name => `three-clouds-webgpu/assets/${name}?url`)

type Sources = Record<string, string>

function sources(name: string): Sources {
  const directory = join(recipesRoot, name, 'src')
  return Object.fromEntries(
    readdirSync(directory)
      .filter(file => /\.tsx?$/.test(file))
      .map(file => [file, readFileSync(join(directory, file), 'utf8')])
  )
}

function parse(files: Sources): ts.SourceFile[] {
  return Object.entries(files).map(([name, source]) =>
    ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true)
  )
}

function descendants(files: Sources): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    result.push(node)
    ts.forEachChild(node, visit)
  }
  parse(files).forEach(visit)
  return result
}

function imports(files: Sources): string[] {
  return descendants(files)
    .filter(ts.isImportDeclaration)
    .map(node => (node.moduleSpecifier as ts.StringLiteral).text)
}

function configureCalls(
  calls: readonly ts.CallExpression[]
): ts.CallExpression[] {
  return calls.filter(
    node =>
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'configure'
  )
}

function objectProperty(
  object: ts.Node | undefined,
  name: string
): ts.PropertyAssignment | undefined {
  if (object == null || !ts.isObjectLiteralExpression(object)) return undefined
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText() === name
  )
}

// Fiber 9.7 picks PCFSoftShadowMap, which r187 removed, so every configure call
// passes shadows { enabled: false, type: PCFShadowMap } (startup and resize)
function hasExplicitShadowMode(calls: readonly ts.CallExpression[]): boolean {
  const configurations = configureCalls(calls)
  return (
    configurations.length > 0 &&
    configurations.every(node => {
      const shadows = objectProperty(node.arguments[0], 'shadows')?.initializer
      const enabled = objectProperty(shadows, 'enabled')?.initializer
      const type = objectProperty(shadows, 'type')?.initializer
      return (
        enabled?.kind === ts.SyntaxKind.FalseKeyword &&
        type != null &&
        ts.isIdentifier(type) &&
        type.text === 'PCFShadowMap'
      )
    })
  )
}

function audit(name: string, files: Sources): string[] {
  const nodes = descendants(files)
  const calls = nodes.filter(ts.isCallExpression)
  const called = (expression: string): boolean =>
    calls.some(node => node.expression.getText() === expression)
  const imported = imports(files)
  const checks: Record<string, boolean> = {
    initializesRenderer: called('renderer.init'),
    rejectsFallback: called('assertWebGPUSupported'),
    fourPublicAssetImports: assetPaths.every(path => imported.includes(path)),
    explicitAssetRoute: called('assetUrls'),
    mrt: called('scenePass.setMRT') && called('mrt'),
    sceneDepth:
      called('scenePass.getTextureNode') ||
      called('resources.scenePass.getTextureNode'),
    pipelineOutput: nodes.some(
      node =>
        ts.isBinaryExpression(node) &&
        node.left.getText() === 'pipeline.outputNode'
    ),
    rendersPipeline:
      called('pipeline.render') || called('outputPipeline.render'),
    callerUpdates: called('integration.update') || called('active.update'),
    historyReset:
      called('integration.resetHistory') || called('active.resetHistory'),
    rendererCleanup: called('renderer.dispose'),
    scenePassCleanup: called('scenePass.dispose'),
    atmosphereCleanup: called('atmosphere.dispose'),
    helper: called('createCloudsIntegration') || called('factory'),
    localImportsOnly: imported.every(path => !path.startsWith('../')),
    noWorkspaceImports: imported.every(path => !path.includes('workspace:'))
  }
  if (name === 'vanilla') {
    checks.animationLoop = called('renderer.setAnimationLoop')
    checks.cancellableLoad =
      called('loadBakedCloudTextures') && called('controller.abort')
    checks.generatedJitter = called('createJitterTexture')
  } else {
    checks.renderTakeover = calls.some(
      node =>
        node.expression.getText() === 'useFrame' &&
        node.arguments[1]?.getText() === '1'
    )
    checks.strictMode = nodes.some(
      node =>
        ts.isJsxOpeningElement(node) && node.tagName.getText() === 'StrictMode'
    )
    checks.borrowsCloudsPass =
      nodes.some(
        node =>
          ts.isShorthandPropertyAssignment(node) &&
          node.name.text === 'cloudsPass'
      ) && !called('clouds')
    checks.observesAssets = nodes.some(
      node =>
        ts.isPropertyAccessExpression(node) &&
        node.getText() === 'assets.status'
    )
    checks.deferredRootCleanup = called('unmountComponentAtNode')
    checks.explicitShadowMode = hasExplicitShadowMode(calls)
    checks.noPerFrameReactState = !called('setTick')
    checks.explicitEnabled = nodes.some(
      node =>
        ts.isJsxAttribute(node) &&
        node.name.getText() === 'enabled' &&
        node.initializer?.getText() === '{props.controls.enabled}'
    )
  }
  return Object.entries(checks)
    .filter(([, valid]) => !valid)
    .map(([check]) => check)
}

// Strips the shadows property from the index-th configure call
function removeShadows(files: Sources, index: number): Sources {
  for (const file of parse(files)) {
    const call = configureCalls(
      descendants({ [file.fileName]: files[file.fileName]! }).filter(
        ts.isCallExpression
      )
    )[index]
    const property = objectProperty(call?.arguments[0], 'shadows')
    if (property == null) continue
    const source = files[file.fileName]!
    const end = source[property.end] === ',' ? property.end + 1 : property.end
    return {
      ...files,
      [file.fileName]: source.slice(0, property.getStart()) + source.slice(end)
    }
  }
  throw new Error(`Mutation found no shadows in configure call ${index}`)
}

function removeCall(files: Sources, expression: string): Sources {
  for (const file of parse(files)) {
    const call = descendants({ [file.fileName]: files[file.fileName]! })
      .filter(ts.isCallExpression)
      .find(node => node.expression.getText() === expression)
    if (call == null) continue
    const source = files[file.fileName]!
    return {
      ...files,
      [file.fileName]:
        source.slice(0, call.getStart()) + 'undefined' + source.slice(call.end)
    }
  }
  throw new Error(`Mutation found zero ${expression} calls`)
}

describe.each(names)('%s complete consumer recipe', name => {
  test('includes strict build inputs, exact peers and an external archive dependency', () => {
    const folder = join(recipesRoot, name)
    const manifest = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8')
    ) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const config = JSON.parse(
      readFileSync(join(folder, 'tsconfig.json'), 'utf8')
    ) as {
      compilerOptions: {
        strict: boolean
        moduleResolution: string
        paths?: unknown
      }
      include: string[]
    }
    expect(manifest.dependencies).toMatchObject({
      three: '0.185.1',
      '@takram/three-atmosphere': '0.19.1',
      '@takram/three-geospatial': '0.9.1',
      postprocessing: '6.39.4',
      'three-clouds-webgpu': 'file:./vendor/three-clouds-webgpu.tgz'
    })
    expect(manifest.devDependencies['@types/three']).toBe('0.185.0')
    expect(manifest.scripts.build).toBe('tsc --noEmit && vite build')
    expect(config.compilerOptions.strict).toBe(true)
    expect(config.compilerOptions.moduleResolution).toBe('bundler')
    expect(config.compilerOptions.paths).toBeUndefined()
    expect(config.include).toContain('src')
    expect(readFileSync(join(folder, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'autoInstallPeers: false'
    )
    // the npm takram builds fail to import on three 0.185, and the recipe
    // must install the same fork builds the repository develops against
    // both names first: two files without overrides would also compare equal
    const overrides = workspaceOverrides(folder)
    log('recipe-overrides', { name, pinned: Object.keys(overrides).join(' ') })
    expect(Object.keys(overrides).sort()).toEqual([
      '@takram/three-atmosphere',
      '@takram/three-geospatial'
    ])
    expect(overrides).toEqual(workspaceOverrides(repoRoot))
    if (name === 'vanilla') {
      expect(manifest.dependencies.react).toBeUndefined()
      expect(manifest.dependencies['@react-three/fiber']).toBeUndefined()
    }
    const html = readFileSync(join(folder, 'index.html'), 'utf8')
    expect(html).toContain(`/src/main.${name === 'r3f' ? 'tsx' : 'ts'}`)
    log('recipe-manifest', { name, strict: true, exactPeerPins: true })
  })

  test('audits executable statements rather than comments or disconnected snippets', () => {
    const files = sources(name)
    expect(Object.keys(files).length).toBeGreaterThan(0)
    expect(audit(name, files)).toEqual([])
    for (const [fileName, source] of Object.entries(files)) {
      const compiled = ts.transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX
        }
      })
      expect(compiled.diagnostics).toEqual([])
      expect(compiled.outputText.length).toBeGreaterThan(0)
    }
    log('recipe-source-audit', { name, sourceFiles: Object.keys(files).length })
  })

  test('documentation embeds the exact executable asset source', () => {
    const markdown = readFileSync(join(recipesRoot, name, 'README.md'), 'utf8')
    const snippet = markdown.match(
      /<!-- source: src\/assets\.ts -->\n```ts\n([\s\S]*?)\n```/
    )?.[1]
    expect(snippet).toBe(sources(name)['assets.ts']?.trimEnd())
    expect(markdown).toContain('../../INTEGRATION.md')
    expect(markdown).toContain('../../docs/CONSUMER_CONTRACT.md')
    log('recipe-snippet', { name, source: 'src/assets.ts', exact: true })
  })

  test('the actual asset resolver supports bundled and explicit base URLs', () => {
    const declaration = descendants(sources(name))
      .filter(ts.isFunctionDeclaration)
      .find(node => node.name?.text === 'assetUrls')!
    expect(declaration).toBeDefined()
    const executable = ts.transpileModule(declaration.getText(), {
      compilerOptions: { module: ts.ModuleKind.CommonJS }
    }).outputText
    const bundled = {
      localWeather: '/bundled/weather.png',
      turbulence: '/bundled/turbulence.png',
      shape: '/bundled/shape.bin',
      shapeDetail: '/bundled/shape-detail.bin'
    }
    const files = {
      localWeather: 'local_weather.png',
      turbulence: 'turbulence.png',
      shape: 'shape.bin',
      shapeDetail: 'shape_detail.bin'
    }
    for (const base of [
      null,
      '/cloud-assets',
      '/cloud-assets/',
      'cloud-assets'
    ]) {
      const location = new URL('https://example.test/nested/recipe/')
      if (base != null) location.searchParams.set('assets', base)
      const actual = runInNewContext(`${executable}\nassetUrls()`, {
        ...bundled,
        exports: {},
        location,
        URL,
        URLSearchParams
      }) as Record<string, string>
      const expected =
        base == null
          ? bundled
          : Object.fromEntries(
              Object.entries(files).map(([key, file]) => [
                key,
                new URL(`${base.replace(/\/$/, '')}/${file}`, location.href)
                  .href
              ])
            )
      expect(actual).toEqual(expected)
    }
    log('recipe-asset-resolver', { name, executableCases: 4 })
  })

  test('removing initialization or pipeline rendering fails the completeness guard', () => {
    const files = sources(name)
    expect(audit(name, removeCall(files, 'renderer.init'))).toContain(
      'initializesRenderer'
    )
    const render =
      name === 'vanilla' ? 'pipeline.render' : 'outputPipeline.render'
    expect(audit(name, removeCall(files, render))).toContain('rendersPipeline')
    log('recipe-negative-control', {
      name,
      missingInitRejected: true,
      missingRenderRejected: true
    })
  })

  test.runIf(name === 'r3f')(
    'removing shadows from either configure call fails the shadow-mode guard',
    () => {
      const files = sources(name)
      const startup = audit(name, removeShadows(files, 0))
      const resize = audit(name, removeShadows(files, 1))
      log('recipe-shadow-mode-negative-control', {
        startupRejected: startup.includes('explicitShadowMode'),
        resizeRejected: resize.includes('explicitShadowMode')
      })
      expect(startup).toEqual(['explicitShadowMode'])
      expect(resize).toEqual(['explicitShadowMode'])
    }
  )

  test('the actual toggle handler updates enabled state and its accessible label', () => {
    const files = sources(name)
    const callback = descendants(files)
      .filter(ts.isCallExpression)
      .find(
        node => node.expression.getText() === 'cloudsToggle.addEventListener'
      )?.arguments[1]
    expect(callback).toBeDefined()
    const attributes = new Map<string, string>()
    const cloudsToggle = {
      textContent: 'Clouds: on',
      setAttribute: (key: string, value: string) => attributes.set(key, value)
    }
    const integration = { context: { enabled: true }, resetHistory: vi.fn() }
    const controls = { enabled: true }
    const renderScene = vi.fn()
    const bindings = {
      cloudsToggle,
      integration,
      controls,
      renderScene,
      root: {},
      stopped: false,
      mount: 42
    }
    const toggle = runInNewContext(
      `(${callback!.getText()})`,
      bindings
    ) as () => void
    const desired = name === 'vanilla' ? integration.context : controls
    for (const enabled of [false, true]) {
      toggle()
      expect(desired.enabled).toBe(enabled)
      expect(attributes.get('aria-pressed')).toBe(String(enabled))
      expect(cloudsToggle.textContent).toBe(
        enabled ? 'Clouds: on' : 'Clouds: off'
      )
    }
    expect(integration.resetHistory).toHaveBeenCalledTimes(
      name === 'vanilla' ? 2 : 0
    )
    expect(renderScene).toHaveBeenCalledTimes(name === 'r3f' ? 2 : 0)
    expect(bindings.mount).toBe(42)
    const html = readFileSync(join(recipesRoot, name, 'index.html'), 'utf8')
    expect(html).toContain('id="clouds-toggle" aria-pressed="true" disabled')
    log('recipe-cloud-toggle', { name, labelsFollowState: true, sameKey: true })
  })
})

test.each([
  { omitCamera: false, omitShadows: false },
  { omitCamera: true, omitShadows: false },
  { omitCamera: false, omitShadows: true }
])(
  'real Fiber resize preserves camera and disabled PCF shadows (%j)',
  async ({ omitCamera, omitShadows }) => {
    const callback = descendants(sources('r3f'))
      .filter(ts.isCallExpression)
      .find(
        node =>
          node.expression.getText() === 'window.addEventListener' &&
          node.arguments[0]?.getText() === "'resize'"
      )?.arguments[1]
    expect(callback).toBeDefined()
    const executable = ts.transpileModule(`(${callback!.getText()})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
    const renderer = {
      shadowMap: {
        enabled: false,
        type: PCFShadowMap,
        needsUpdate: false
      },
      render: vi.fn(),
      setSize: vi.fn(),
      setPixelRatio: vi.fn()
    }
    const camera = new PerspectiveCamera(50, 640 / 360, 100, 1e8)
    camera.position.set(0, 6378137 + 2500, 0)
    const root = createRoot(new EventTarget())
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    try {
      await root.configure({
        gl: renderer,
        camera,
        shadows: { enabled: false, type: PCFShadowMap },
        size: { width: 640, height: 360, top: 0, left: 0 },
        dpr: 1,
        frameloop: 'never'
      })
      const store = await act(async () => {
        const store = root.render(null)
        await Promise.resolve()
        return store
      })
      expect(store.getState().camera).toBe(camera)
      const pending: { value?: ReturnType<typeof root.configure> } = {}
      const report = vi.fn()
      const stop = vi.fn()
      const resize = runInNewContext(executable, {
        camera,
        renderer,
        root: {
          configure(
            options: NonNullable<Parameters<typeof root.configure>[0]>
          ) {
            const forwarded = { ...options }
            if (omitCamera) delete forwarded.camera
            if (omitShadows) delete forwarded.shadows
            pending.value = root.configure(forwarded)
            return pending.value
          }
        },
        innerWidth: 800,
        PCFShadowMap,
        innerHeight: 450,
        devicePixelRatio: 1,
        report,
        stop
      }) as () => void
      await act(async () => {
        resize()
        expect(pending.value).toBeDefined()
        await pending.value
      })
      const state = store.getState()
      expect(state.camera === camera).toBe(!omitCamera)
      expect(state.camera.position.toArray()).toEqual(
        omitCamera ? [0, 0, 5] : [0, 6380637, 0]
      )
      expect(state.camera.near).toBe(omitCamera ? 0.1 : 100)
      expect(state.camera.far).toBe(omitCamera ? 1000 : 1e8)
      expect(camera.aspect).toBe(800 / 450)
      expect(state.size).toEqual({ width: 800, height: 450, top: 0, left: 0 })
      expect(renderer.setSize).toHaveBeenCalledWith(800, 450)
      expect(renderer.render).not.toHaveBeenCalled()
      expect(renderer.shadowMap.enabled).toBe(false)
      expect(renderer.shadowMap.type).toBe(
        omitShadows ? PCFSoftShadowMap : PCFShadowMap
      )
      expect(report).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
      log('recipe-fiber-resize', {
        omitCamera,
        omitShadows,
        cameraPreserved: state.camera === camera
      })
    } finally {
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
      await vi.advanceTimersByTimeAsync(500)
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  }
)

test('manual vanilla mode keeps the full render loop but bypasses the helper', () => {
  const files = sources('vanilla')
  const manual = {
    'manual.ts': files['manual.ts']!,
    'manualAerial.ts': files['manualAerial.ts']!
  }
  const calls = descendants(manual).filter(ts.isCallExpression)
  expect(
    calls.some(node => node.expression.getText() === 'createCloudsIntegration')
  ).toBe(false)
  expect(
    calls.some(node => node.expression.getText() === 'pass.cloudShadowAt.bind')
  ).toBe(true)
  expect(calls.some(node => node.expression.getText() === 'sampleShadow')).toBe(
    true
  )
  expect(
    calls.some(node => node.expression.getText() === 'pass.composite')
  ).toBe(true)
  expect(
    calls
      .find(node => node.expression.getText() === 'context.moonDirection.copy')
      ?.arguments[0]?.getText()
  ).toBe('moonDirection')
  expect(
    calls
      .find(
        node =>
          node.expression.getText() ===
          'atmosphere.moonDirectionECEF.value.copy'
      )
      ?.arguments[0]?.getText()
  ).toBe('context.moonDirection')
  expect(files['main.ts']).toContain('? createManualIntegration')
  log('manual-recipe', {
    fullGraph: true,
    sharedBootstrap: true,
    moonSynchronizedFromContext: true
  })
})
