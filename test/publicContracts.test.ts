import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { LinearSRGBColorSpace, NoToneMapping } from 'three'
import { float, vec3, vec4 } from 'three/tsl'
import { RenderPipeline, type Renderer } from 'three/webgpu'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { CloudsContext } from '../src/CloudsContext'
import { experimentalDefaults } from '../src/experimental/options'
import { createLayerUniforms, updateLayerUniforms } from '../src/layerUniforms'
import { getIntersections } from '../src/march/intersections'
import { compileWGSL } from './helpers/compileWGSL'
import { log } from './helpers/log'

const ROOT = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('contract.ts', code, ts.ScriptTarget.Latest, true)
}

function classDocs(
  path: string,
  className: string,
  memberName?: string
): string {
  const source = parse(read(path))
  const declaration = source.statements.find(
    statement =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  )
  if (declaration == null || !ts.isClassDeclaration(declaration)) {
    throw new Error(`Missing class ${className} in ${path}`)
  }
  const member =
    memberName == null
      ? declaration
      : declaration.members.find(
          entry => entry.name?.getText(source) === memberName
        )
  if (member == null) throw new Error(`Missing member ${memberName} in ${path}`)
  return ts
    .getJSDocCommentsAndTags(member)
    .map(comment => comment.getText(source))
    .join('\n')
}

function snippets(text: string): string[] {
  return [
    ...text.replace(/^\s*\* ?/gm, '').matchAll(/```ts\n([\s\S]*?)\n```/g)
  ].map(match => match[1]!)
}

function firstSnippet(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start < 0) throw new Error(`Missing heading ${heading}`)
  const snippet = snippets(text.slice(start))[0]
  if (snippet == null) throw new Error(`Missing snippet after ${heading}`)
  return snippet
}

function mrtAttachments(code: string): string[][] {
  const source = parse(code)
  const attachments: string[][] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'mrt'
    ) {
      const argument = node.arguments[0]
      if (argument != null && ts.isObjectLiteralExpression(argument)) {
        attachments.push(
          argument.properties
            .map(property =>
              ts.isPropertyAssignment(property)
                ? `${property.name.getText(source)}:${property.initializer.getText(source)}`
                : (property.name?.getText(source) ?? 'spread')
            )
            .sort()
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return attachments
}

function metresPerUnit(documentation: string): number {
  const unit = documentation.match(/\b(?:in|are) (km|kilometres|metres)\b/)?.[1]
  if (unit == null) throw new Error('Missing distance unit')
  return unit === 'metres' ? 1 : 1000
}

function snippetDiagnostics(
  entries: Record<string, string>
): Map<string, string[]> {
  const config = ts.readConfigFile(
    resolve(ROOT, 'tsconfig.json'),
    ts.sys.readFile.bind(ts.sys)
  )
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  const options = {
    ...parsed.options,
    noUnusedLocals: false,
    noUnusedParameters: false
  }
  const sources = new Map(
    Object.entries(entries).map(([name, code]) => [
      resolve(ROOT, `${name}.ts`),
      code
    ])
  )
  const host = ts.createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (
    name,
    languageVersion,
    onError,
    shouldCreateNewSourceFile
  ) => {
    const source = sources.get(name)
    return source == null
      ? originalGetSourceFile(
          name,
          languageVersion,
          onError,
          shouldCreateNewSourceFile
        )
      : ts.createSourceFile(name, source, languageVersion, true)
  }
  const program = ts.createProgram([...sources.keys()], options, host)
  return new Map(
    Object.keys(entries).map(name => {
      const source = program.getSourceFile(resolve(ROOT, `${name}.ts`))!
      const diagnostics = [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source)
      ]
      return [
        name,
        diagnostics.map(diagnostic =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        )
      ]
    })
  )
}

describe('public contracts match executable definitions', () => {
  it('replacement instructions refresh an already-rendered host pipeline', () => {
    const code = firstSnippet(
      read('INTEGRATION.md'),
      '### Replacing an integration'
    )
    const rendered: unknown[] = []
    const renderer = {
      toneMapping: NoToneMapping,
      outputColorSpace: LinearSRGBColorSpace,
      xr: { enabled: false },
      render: (mesh: { material: { fragmentNode: unknown } }) => {
        rendered.push(mesh.material.fragmentNode)
      }
    } as unknown as Renderer
    const pipeline = new RenderPipeline(renderer)
    pipeline.render()
    const previousGraph = rendered.at(-1)
    const replacement = { output: vec4(1, 0, 0, 1) }
    pipeline.outputNode = replacement.output
    pipeline.render()
    expect(rendered.at(-1)).toBe(previousGraph)
    let disposals = 0
    runInNewContext(code, {
      integration: { dispose: () => disposals++ },
      createCloudsIntegration: () => replacement,
      replacementOptions: {},
      pipeline
    })
    expect(pipeline.needsUpdate).toBe(true)
    pipeline.render()
    expect(rendered.at(-1)).not.toBe(previousGraph)
    expect(disposals).toBe(1)
    const diagnostics = snippetDiagnostics({
      replacement: `
        import { createCloudsIntegration, type CloudsIntegration } from 'three-clouds-webgpu'
        import type { RenderPipeline } from 'three/webgpu'
        declare let integration: CloudsIntegration
        declare const replacementOptions: Parameters<typeof createCloudsIntegration>[0]
        declare const pipeline: RenderPipeline
        ${code}
      `
    })
    expect(diagnostics.get('replacement')).toEqual([])
    log('documented-host-pipeline-replacement', {
      rendered: rendered.length,
      helperDisposals: disposals,
      replacementCompiled: rendered.at(-1) !== previousGraph,
      diagnostics: diagnostics.get('replacement')
    })
    pipeline.dispose()
  })

  it('layer documentation uses the units packed into metre-domain shell radii', () => {
    const context = new CloudsContext()
    const uniforms = createLayerUniforms()
    const first = context.cloudLayers[0]!
    context.cloudLayers.slice(1).forEach(layer => {
      layer.height = 0
    })
    updateLayerUniforms(uniforms, context)
    const altitudeScale = metresPerUnit(
      classDocs('src/CloudLayer.ts', 'CloudLayer', 'altitude')
    )
    const heightScale = metresPerUnit(
      classDocs('src/CloudLayer.ts', 'CloudLayer', 'height')
    )
    const documentedBottom = first.altitude * altitudeScale
    const documentedTop = documentedBottom + first.height * heightScale
    const expected = { bottom: 750, top: 1400, radius: 6360000, slots: 4 }
    log('documented-layer-units', {
      documentedBottom,
      documentedTop,
      packedBottom: uniforms.minHeight.value,
      packedTop: uniforms.maxHeight.value,
      ...expected
    })
    expect(documentedBottom).toBe(uniforms.minHeight.value)
    expect(documentedTop).toBe(uniforms.maxHeight.value)
    expect(metresPerUnit(classDocs('src/CloudLayer.ts', 'CloudLayer'))).toBe(1)
    expect([
      first.altitude,
      first.altitude + first.height,
      context.bottomRadius,
      context.cloudLayers.length
    ]).toEqual(Object.values(expected))
    const intersections = getIntersections(
      vec3(0, context.bottomRadius, 0),
      vec3(0, 1, 0),
      float(context.bottomRadius),
      float(uniforms.minHeight.value),
      float(uniforms.maxHeight.value),
      float(uniforms.shadowTopHeight.value)
    )
    const { fragment } = compileWGSL(intersections.get('second'))
    expect(fragment).toMatch(/6360000\.0[^\n]*\+[^\n]*750\.0, 1400\.0, 1400\.0/)
    context.dispose()
  })

  it('rejects the shipped kilometre contract against the packed layer values', () => {
    const context = new CloudsContext()
    const uniforms = createLayerUniforms()
    updateLayerUniforms(uniforms, context)
    const claimed =
      context.cloudLayers[0]!.altitude *
      metresPerUnit("Height of the band's base, in km")
    log('kilometre-contract-rejected', {
      claimed,
      actual: uniforms.minLayerHeights.value.x
    })
    expect(claimed).not.toBe(uniforms.minLayerHeights.value.x)
    context.dispose()
  })

  it('the source graph example owns no cloud attachments in the scene MRT', () => {
    const documented = snippets(
      classDocs('src/CloudsPassNode.ts', 'CloudsPassNode')
    )
    const canonical = mrtAttachments(read('examples/basic/src/main.ts'))
    const actual = documented.flatMap(mrtAttachments)
    log('documented-scene-mrt', { actual, canonical })
    expect(canonical).toEqual([['normal:normalView', 'output']])
    expect(actual).toEqual(canonical)
    const original =
      'scenePass.setMRT(mrt({ output, cloud: cloudsPass.layerNode, cloudDepthVelocity: cloudsPass.depthVelocityNode }))'
    expect(mrtAttachments(original)).not.toEqual(canonical)
  })

  it('the experimental accessor documents exactly the default-on options', () => {
    const documentation = classDocs(
      'src/CloudsContext.ts',
      'CloudsContext',
      'experimental'
    )
    const documented = [...documentation.matchAll(/`([A-Za-z]+)`/g)]
      .map(match => match[1]!)
      .sort()
    const enabled = Object.entries(experimentalDefaults)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .sort()
    log('documented-experimental-defaults', { documented, enabled })
    expect(enabled.length).toBeGreaterThan(0)
    expect(documented).toEqual(enabled)
  })

  it('migration debug values enumerate the exported DebugView union', () => {
    const source = parse(read('src/CloudsContext.ts'))
    const declaration = source.statements.find(
      statement =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text === 'DebugView'
    )
    if (
      declaration == null ||
      !ts.isTypeAliasDeclaration(declaration) ||
      !ts.isUnionTypeNode(declaration.type)
    )
      throw new Error('Missing DebugView union')
    const known = declaration.type.types
      .map(type => type.getText(source).replaceAll("'", ''))
      .sort()
    const row =
      read('docs/MIGRATION.md')
        .split('\n')
        .find(line => line.startsWith('| `debug` |')) ?? ''
    const documented = [...row.matchAll(/'([A-Za-z]+)'/g)]
      .map(match => match[1]!)
      .sort()
    log('documented-debug-views', { documented, known })
    expect(known.length).toBeGreaterThan(0)
    expect(documented).toEqual(known)
  })

  it('asset, generator and graph snippets typecheck against source exports', () => {
    const assets = firstSnippet(read('WEBGPU.md'), '## Baked assets')
    const generators = firstSnippet(
      read('docs/MIGRATION.md'),
      '## Texture inputs'
    )
    const graph = `
      import { clouds } from 'three-clouds-webgpu'
      import { mrt, normalView, output, pass } from 'three/tsl'
      import { PerspectiveCamera, RenderPipeline, Scene, type Node, type Renderer } from 'three/webgpu'
      declare const renderer: Renderer
      declare const aerial: Node<'vec4'>
      const camera = new PerspectiveCamera()
      const scenePass = pass(new Scene(), camera)
      const pipeline = new RenderPipeline(renderer)
      ${snippets(classDocs('src/CloudsPassNode.ts', 'CloudsPassNode')).join('\n')}
    `
    const invalid =
      "import { CloudsContext } from 'three-clouds-webgpu'\nconst cloudsContext = new CloudsContext()\ncloudsContext.shapeTexture = await loadShapeTexture({ url: 'shape.bin' })"
    const diagnostics = snippetDiagnostics({
      assets,
      generators,
      graph,
      invalid
    })
    log('documented-texture-snippets', Object.fromEntries(diagnostics))
    expect(diagnostics.get('assets')).toEqual([])
    expect(diagnostics.get('generators')).toEqual([])
    expect(diagnostics.get('graph')).toEqual([])
    expect(diagnostics.get('invalid')?.join('\n')).toContain(
      "Cannot find name 'loadShapeTexture'"
    )
    const assetPaths = [
      ...assets.matchAll(/'three-clouds-webgpu\/(assets\/[^']+)\?url'/g)
    ].map(match => match[1]!)
    log('documented-package-assets', { assetPaths })
    expect(new Set(assetPaths).size).toBe(4)
    for (const path of assetPaths)
      expect(existsSync(resolve(ROOT, path)), path).toBe(true)
  })
})
