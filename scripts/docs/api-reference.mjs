import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export const API_PATH = 'docs/API.md'

const RECOMMENDED = new Set([
  'createCloudsIntegration',
  'CloudsIntegration',
  'CloudsIntegrationOptions',
  'CloudsIntegrationTextures',
  'CloudsIntegrationUpdate',
  'clouds',
  'CloudsContext',
  'CloudsPassNode',
  'CloudsOptions',
  'CloudLayer',
  'CloudLayerLike',
  'CloudLayers',
  'DensityProfile',
  'applyQualityPreset',
  'QualityPreset',
  'qualityPresets',
  'defaults',
  'loadBakedCloudTextures',
  'LoadBakedCloudTexturesOptions',
  'BakedCloudTextures',
  'BakedCloudTextureUrls',
  'CloudTextureLoadError',
  'CloudTextureAsset',
  'createJitterTexture',
  'assertWebGPUSupported',
  'syncCelestialDirections',
  'inspectCloudsSetup',
  'CloudSetupDiagnostic',
  'CloudsSetupInspection',
  'InspectCloudsSetupOptions'
])
const GROUPS = [
  'Recommended integration and configuration',
  'Advanced composition',
  'Experiments',
  'Reference and testing support',
  'React adapter'
]
const CORE_MODULES = new Set([
  'CloudLayer',
  'CloudLayers',
  'CloudsContext',
  'CloudsPassNode',
  'DensityProfile',
  'qualityPresets',
  'QualityGovernor',
  'constants',
  'diagnostics',
  'integration'
])

export function classifyExport(name, path, entry) {
  if (entry === 'r3f') return GROUPS[4]
  if (RECOMMENDED.has(name)) return GROUPS[0]
  if (
    name.endsWith('CPU') ||
    name.startsWith('cpu') ||
    name === 'createHashJitterTexture' ||
    path === 'src/referenceMode.ts' ||
    [
      'src/CameraUniforms.ts',
      'src/layerUniforms.ts',
      'src/march/jitter.ts'
    ].includes(path)
  )
    return GROUPS[3]
  if (path.startsWith('src/experimental/')) return GROUPS[2]
  if (
    path.startsWith('src/shadow/') ||
    path.startsWith('src/textures/') ||
    CORE_MODULES.has(path.replace(/^src\//, '').replace(/\.ts$/, ''))
  )
    return GROUPS[1]
  throw new Error(`Unclassified public export ${entry}:${name} from ${path}`)
}

function text(parts) {
  return ts
    .displayPartsToString(parts ?? [])
    .replace(
      /\{@link(?:code)?\s+([^}]+)\}/g,
      (_, target) => `\`${target.trim()}\``
    )
}

const TYPE_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope

function portableType(value) {
  return value.replace(/import\("[^"]+"\)\./g, '')
}

function documentation(symbol, checker) {
  const description = text(symbol.getDocumentationComment(checker))
  const tags = symbol
    .getJsDocTags(checker)
    .filter(tag => !['internal', 'category'].includes(tag.name))
    .map(tag => `**${tag.name}**: ${text(tag.text)}`)
  return [description, ...tags].filter(Boolean).join('\n\n')
}

function visibleMember(member) {
  const hidden =
    ts.ModifierFlags.Private |
    ts.ModifierFlags.Protected |
    ts.ModifierFlags.Static
  return (
    member.name != null &&
    (ts.getCombinedModifierFlags(member) & hidden) === 0 &&
    !ts.getJSDocTags(member).some(tag => tag.tagName.text === 'internal') &&
    !ts.isSetAccessorDeclaration(member) &&
    !ts.isPrivateIdentifier(member.name)
  )
}

function initialExpression(member, declaration) {
  if (member.initializer != null) return member.initializer.getText()
  if (!ts.isGetAccessorDeclaration(member)) return ''
  const statements = member.body?.statements
  if (statements?.length !== 1 || !ts.isReturnStatement(statements[0]))
    return ''
  const expression = statements[0].expression
  if (
    expression == null ||
    !ts.isPropertyAccessExpression(expression) ||
    expression.expression.kind !== ts.SyntaxKind.ThisKeyword
  )
    return ''
  const backing = declaration.members.find(
    candidate => candidate.name?.getText() === expression.name.text
  )
  return backing?.initializer?.getText() ?? ''
}

function describeMembers(declaration, checker) {
  if (
    !ts.isClassDeclaration(declaration) &&
    !ts.isInterfaceDeclaration(declaration)
  )
    return []
  const describe = (member, symbol) => {
    if (symbol == null)
      throw new Error(`Missing public member symbol ${member.name.getText()}`)
    return {
      name: symbol.name,
      type: portableType(
        checker.typeToString(
          checker.getTypeOfSymbolAtLocation(symbol, member),
          member,
          TYPE_FLAGS
        )
      ),
      initialExpression: initialExpression(member, declaration),
      documentation:
        ts.getJSDocCommentsAndTags(member).length > 0
          ? documentation(symbol, checker)
          : ''
    }
  }
  if (ts.isInterfaceDeclaration(declaration))
    return checker
      .getTypeAtLocation(declaration)
      .getProperties()
      .map(symbol => {
        const member =
          symbol.valueDeclaration ?? symbol.declarations?.[0] ?? declaration
        return {
          ...describe(member, symbol),
          initialExpression: '',
          documentation: documentation(symbol, checker)
        }
      })
  return declaration.members.flatMap(member => {
    if (ts.isConstructorDeclaration(member)) {
      const call = checker.getSignatureFromDeclaration(member)
      if (call == null) throw new Error('Missing constructor signature')
      return [
        {
          name: 'constructor',
          type: portableType(
            checker.signatureToString(call, member, TYPE_FLAGS)
          ),
          initialExpression: '',
          documentation: text(call.getDocumentationComment(checker))
        },
        ...member.parameters
          .filter(parameter =>
            ts.isParameterPropertyDeclaration(parameter, member)
          )
          .filter(visibleMember)
          .map(parameter =>
            describe(parameter, checker.getSymbolAtLocation(parameter.name))
          )
      ]
    }
    return visibleMember(member)
      ? [describe(member, checker.getSymbolAtLocation(member.name))]
      : []
  })
}

function signature(symbol, declaration, checker) {
  if (ts.isClassDeclaration(declaration)) return `class ${symbol.name}`
  if (ts.isInterfaceDeclaration(declaration)) return `interface ${symbol.name}`
  if (ts.isTypeAliasDeclaration(declaration))
    return declaration.getText().replace(/^export\s+/, '')
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const signatures = type.getCallSignatures()
  if (signatures.length > 0)
    return signatures
      .map(call =>
        portableType(
          `${symbol.name}${checker.signatureToString(call, declaration, TYPE_FLAGS)}`
        )
      )
      .join('\n')
  return `${symbol.name}: ${portableType(checker.typeToString(type, declaration, TYPE_FLAGS))}`
}

export function collectApi(root) {
  const config = ts.readConfigFile(
    resolve(root, 'tsconfig.json'),
    ts.sys.readFile
  )
  if (config.error != null)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n')
    )
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const entries = {
    root: 'src/index.ts',
    webgpu: 'src/webgpu/index.ts',
    r3f: 'src/r3f/index.ts'
  }
  const program = ts.createProgram(
    Object.values(entries).map(path => resolve(root, path)),
    parsed.options
  )
  const checker = program.getTypeChecker()
  const result = []
  const names = {}
  for (const [entry, path] of Object.entries(entries)) {
    const source = program.getSourceFile(resolve(root, path))
    const module =
      source != null ? checker.getSymbolAtLocation(source) : undefined
    if (module == null) throw new Error(`Missing entrypoint ${path}`)
    const exports = checker
      .getExportsOfModule(module)
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    if (exports.length === 0)
      throw new Error(`Entrypoint ${path} exports nothing`)
    names[entry] = exports.map(symbol => symbol.name)
    if (entry === 'webgpu') continue
    for (const exported of exports) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (declaration == null)
        throw new Error(`Missing declaration for ${exported.name}`)
      const sourceFile = declaration.getSourceFile()
      const sourcePath = relative(root, sourceFile.fileName).replaceAll(
        '\\',
        '/'
      )
      const line =
        sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line +
        1
      result.push({
        name: exported.name,
        entry,
        group: classifyExport(exported.name, sourcePath, entry),
        source: `${sourcePath}#L${line}`,
        signature: signature(symbol, declaration, checker),
        documentation: documentation(symbol, checker),
        members: describeMembers(declaration, checker)
      })
    }
  }
  if (JSON.stringify(names.root) !== JSON.stringify(names.webgpu))
    throw new Error('Root and /webgpu export surfaces differ')
  return result
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function table(headers, rows) {
  if (rows.length === 0)
    throw new Error(`Cannot render empty ${headers[0]} table`)
  return [headers, headers.map(() => '---'), ...rows]
    .map(row => `| ${row.map(cell).join(' | ')} |`)
    .join('\n')
}

function valueText(value) {
  if (value != null && typeof value.toArray === 'function')
    return JSON.stringify(value.toArray())
  return JSON.stringify(value)
}

function flatten(value, prefix = '') {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return entry != null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.toArray !== 'function'
      ? flatten(entry, path)
      : [[path, valueText(entry)]]
  })
}

function defaultsMarkdown(runtime) {
  const options = Object.entries(runtime.experimentalDefaults)
  const presets = Object.entries(runtime.qualityPresets)
  const fields = flatten(runtime.defaults).map(([path]) => path)
  const layers = Array.from(runtime.CloudLayers.DEFAULT)
  const presetValues = presets.map(([, preset]) =>
    Object.fromEntries(flatten(preset))
  )
  if (options.length === 0 || presets.length === 0 || layers.length === 0)
    throw new Error('Runtime default sets must not be empty')
  // A preset may add optional knobs the defaults never write (lowEnd sets
  // temporalUpscale and lightShaftsHalfResolution); it may not drop a field
  for (const values of presetValues) {
    if (fields.some(path => !(path in values)))
      throw new Error('Preset fields differ from defaults')
  }
  const presetFields = [
    ...new Set([...fields, ...presetValues.flatMap(v => Object.keys(v))])
  ]
  return [
    '## Current defaults',
    'These tables are read from the built package, not transcribed from prose. Values are initial defaults, not runtime range validation.',
    '### Experimental options',
    'Source: `experimentalDefaults`. Changing an option rebuilds the graph and invalidates temporal history. A partial assignment preserves other options.',
    table(
      ['Option', 'Default', 'Details'],
      options.map(([name, value]) => [
        `\`${name}\``,
        `\`${valueText(value)}\``,
        `[Behavior and cost](EXPERIMENTAL.md#${name.toLowerCase()})`
      ])
    ),
    '### Quality presets',
    'Source: `defaults` and `qualityPresets`. A new context starts at `high`. Apply a preset before local overrides; reapplying it restores the preset fields. Preset objects are shared definitions, not mutable per-instance state.',
    table(
      ['Field', ...presets.map(([name]) => name)],
      presetFields.map(path => [
        `\`${path}\``,
        ...presetValues.map(values =>
          path in values ? `\`${values[path]}\`` : 'not set'
        )
      ])
    ),
    '### Layer defaults',
    'Source: `CloudLayer.DEFAULT` (standalone empty layer) and `CloudLayers.DEFAULT` (the context’s fixed slots). Altitude and height are metres. A zero height disables a slot without changing the slot count.',
    table(
      ['Field', 'Standalone', ...layers.map((_, index) => `Slot ${index}`)],
      flatten(runtime.CloudLayer.DEFAULT).map(([path, value]) => [
        `\`${path}\``,
        `\`${value}\``,
        ...layers.map(
          layer => `\`${Object.fromEntries(flatten(layer))[path]}\``
        )
      ])
    )
  ].join('\n\n')
}

function exportMarkdown(entry) {
  const lines = [
    `### ${entry.entry === 'r3f' ? '/r3f: ' : ''}${entry.name}`,
    `[Source](../${entry.source})`,
    `\`\`\`ts\n${entry.signature}\n\`\`\``
  ]
  if (entry.documentation !== '') lines.push(entry.documentation)
  if (entry.members.length > 0)
    lines.push(
      table(
        ['Member', 'Type', 'Initial expression (source)', 'Contract'],
        entry.members.map(member => [
          `\`${member.name}\``,
          `\`${member.type}\``,
          member.initialExpression === ''
            ? ''
            : `\`${member.initialExpression}\``,
          member.documentation ||
            'No additional contract documented; see source'
        ])
      )
    )
  return lines.join('\n\n')
}

export function renderApiReference(root, runtime, api = collectApi(root)) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const sections = [
    `# API reference: ${pkg.name} ${pkg.version}`,
    'Generated from this version’s public TypeScript surface, JSDoc and runtime defaults. Start with recommended integration; the advanced and reference groups remain exported for compatibility, not as required setup steps.',
    'Signatures show full type names without machine-local module qualifiers. Source links preserve the complete declarations and imports.',
    'Initial expressions come from source fields, constructor parameter defaults or a getter’s backing field. They are not evaluated and may be overridden by construction or options. Blank cells mean there is no single initializer; the current-default tables resolve the preset and layer definitions.',
    'Import the vanilla surface from `three-clouds-webgpu` or `three-clouds-webgpu/webgpu`. Import React bindings only from `three-clouds-webgpu/r3f`; React is not required by the vanilla entrypoint.',
    '[Integration guide](../INTEGRATION.md) · [Advanced WebGPU wiring](../WEBGPU.md) · [Migration](MIGRATION.md) · [Experimental options](EXPERIMENTAL.md)',
    ...GROUPS.map(
      group => `- [${group}](#${group.toLowerCase().replaceAll(' ', '-')})`
    ),
    '- [Current defaults](#current-defaults)'
  ]
  for (const group of GROUPS) {
    const entries = api.filter(entry => entry.group === group)
    if (entries.length === 0)
      throw new Error(`Public API group is empty: ${group}`)
    sections.push(`## ${group}`)
    if (group === GROUPS[0]) {
      const order = [...RECOMMENDED]
      entries.sort(
        (left, right) => order.indexOf(left.name) - order.indexOf(right.name)
      )
      sections.push(...entries.map(exportMarkdown))
    } else if (group === GROUPS[4]) {
      sections.push(
        'These bindings own React lifecycle, not the renderer or final render pipeline. Their props and hook contracts are separate from the vanilla entrypoint.',
        ...entries.map(exportMarkdown)
      )
    } else
      sections.push(
        table(
          ['Export', 'Signature', 'Description'],
          entries.map(entry => [
            `[\`${entry.name}\`](../${entry.source})`,
            `\`${entry.signature}\``,
            entry.documentation.split('\n\n')[0] || 'See source declaration'
          ])
        )
      )
  }
  sections.push(defaultsMarkdown(runtime))
  return `${sections.join('\n\n')}\n`
}

export function checkApiReference(root, markdown) {
  const path = resolve(root, API_PATH)
  if (!existsSync(path) || readFileSync(path, 'utf8') !== markdown)
    throw new Error(
      `Stale ${API_PATH}; run pnpm docs:api and commit the result`
    )
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const runtime = await import(
    pathToFileURL(resolve(root, 'build/index.js')).href
  )
  const markdown = renderApiReference(root, runtime)
  if (process.argv.includes('--check')) checkApiReference(root, markdown)
  else {
    for (const path of ['docs', API_PATH]) {
      if (
        lstatSync(resolve(root, path), {
          throwIfNoEntry: false
        })?.isSymbolicLink()
      )
        throw new Error(`Refusing generated documentation symlink: ${path}`)
    }
    mkdirSync(resolve(root, 'docs'), { recursive: true })
    writeFileSync(resolve(root, API_PATH), markdown)
  }
  console.log(
    `[api-reference] ${process.argv.includes('--check') ? 'verified' : 'generated'} ${API_PATH} (${Buffer.byteLength(markdown)} bytes)`
  )
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main()
