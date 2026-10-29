import ts from 'typescript'

import { EVENT_PREFIX } from './observer.mjs'
import { hash, insist } from './proof.mjs'

function developmentMetadata(node) {
  if (!ts.isObjectLiteralExpression(node)) return false
  const properties = new Map(
    node.properties
      .filter(ts.isPropertyAssignment)
      .map(property => [property.name.getText(), property.initializer])
  )
  const bundle = properties.get('bundleType')
  const version = properties.get('reconcilerVersion')
  return (
    bundle != null &&
    ts.isNumericLiteral(bundle) &&
    bundle.text === '1' &&
    version != null &&
    ts.isStringLiteral(version) &&
    version.text === '19.2.0'
  )
}

export function detectDevelopmentModules(source) {
  const file = ts.createSourceFile(
    'served.js',
    source,
    ts.ScriptTarget.Latest,
    true
  )
  let react = false
  let reconcilerDiagnostic = false
  let reconcilerMetadata = false
  function visit(node) {
    reconcilerMetadata ||= developmentMetadata(node)
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === 'console.error'
    ) {
      const message = node.arguments.find(ts.isStringLiteralLike)?.text ?? ''
      react ||= message.startsWith(
        'You called act(async () => ...) without await.'
      )
      reconcilerDiagnostic ||= message.startsWith(
        'Expected to find a StrictMode component in a strict mode tree.'
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { react, reconciler: reconcilerDiagnostic && reconcilerMetadata }
}

export function createResponseRecorder(scenario, evidence) {
  let previous = Promise.resolve()
  return response => {
    const current = previous.then(() =>
      recordResponse(response, scenario, evidence)
    )
    previous = current.catch(() => {})
    return current
  }
}

export async function observeTransport(context, page, scenario, origin) {
  const evidence = {
    responses: [],
    failures: [],
    console: [],
    devices: [],
    aborted: [],
    developmentModules: { react: false, reconciler: false }
  }
  const pending = []
  const record = createResponseRecorder(scenario, evidence)
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (new URL(url).origin !== origin) {
      evidence.failures.push(`External request: ${url}`)
      await route.abort()
    } else await route.continue()
  })
  page.on('websocket', socket => {
    const url = new URL(socket.url())
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    if (url.origin !== origin)
      evidence.failures.push(`External websocket: ${socket.url()}`)
  })
  page.on('pageerror', error => evidence.failures.push(String(error)))
  page.on('console', message => {
    const text = message.text()
    if (text.startsWith(EVENT_PREFIX)) {
      evidence.devices.push(JSON.parse(text.slice(EVENT_PREFIX.length)))
      return
    }
    evidence.console.push({ type: message.type(), text })
    if (
      message.type() === 'error' ||
      (message.type() === 'warning' &&
        /shader|wgsl|validation|webgpu|three\.tsl/i.test(text))
    )
      evidence.failures.push(text)
  })
  page.on('requestfailed', request => {
    const failure = `${request.url()}: ${request.failure()?.errorText}`
    if (request.failure()?.errorText === 'net::ERR_ABORTED')
      evidence.aborted.push(failure)
    else evidence.failures.push(failure)
  })
  page.on('response', response => {
    pending.push(
      record(response).catch(error => {
        evidence.failures.push(String(error))
      })
    )
  })
  return {
    evidence,
    async finish() {
      await Promise.all(pending)
      insist(evidence.failures.length === 0, evidence.failures.join('\n'))
      insist(
        evidence.responses.some(item => item.javascript && item.bytes > 0),
        'no executed JavaScript response bytes'
      )
      for (const asset of scenario.build.assets) {
        insist(
          evidence.responses.some(
            item => item.sha256 === asset.sha256 && item.bytes === asset.bytes
          ),
          `asset payload was not observed: ${asset.exportPath}`
        )
      }
      if (scenario.development) {
        insist(
          evidence.developmentModules.react &&
            evidence.developmentModules.reconciler,
          'development React/reconciler modules were not observed'
        )
        insist(
          evidence.responses.some(
            item => new URL(item.url).pathname === '/src/main.tsx'
          ),
          'archived development entry was not served'
        )
      }
      return evidence
    }
  }
}

function recordRevalidation(response, evidence) {
  const url = response.url()
  const etag = response.headers().etag
  const requested = response.request().headers()['if-none-match']
  const previous = evidence.responses.findLastIndex(
    item => item.url === url && item.status === 200
  )
  const previousEtag = evidence.responses[previous]?.etag
  insist(
    previous !== -1 &&
      typeof previousEtag === 'string' &&
      previousEtag.length > 0 &&
      (etag == null || etag === previousEtag) &&
      requested?.split(',').some(value => value.trim() === previousEtag),
    `unproven HTTP 304 revalidation: ${url}`
  )
  evidence.responses.push({
    url,
    status: 304,
    etag: etag ?? null,
    conditional: requested,
    revalidatedFrom: previous
  })
}

async function recordResponse(response, scenario, evidence) {
  const url = new URL(response.url())
  const status = response.status()
  if (url.pathname === '/favicon.ico' && status === 204) return
  insist(status === 200 || status === 304, `HTTP ${status}: ${url.href}`)
  const failed = await response.finished()
  if (failed != null) {
    insist(String(failed).includes('ERR_ABORTED'), `response failed: ${failed}`)
    evidence.aborted.push(url.href)
    return
  }
  if (status === 304) {
    recordRevalidation(response, evidence)
    return
  }
  const bytes = await response.body()
  const sha256 = hash(bytes)
  const javascript = /javascript/.test(response.headers()['content-type'] ?? '')
  if (!scenario.development) {
    const path = url.pathname.slice(scenario.build.base.length) || 'index.html'
    const expected = scenario.build.files.files[path]
    insist(
      url.pathname.startsWith(scenario.build.base) &&
        expected?.sha256 === sha256 &&
        expected.bytes === bytes.length,
      `browser response differs from build: ${url.href}`
    )
  } else if (javascript) {
    const development = detectDevelopmentModules(bytes.toString('utf8'))
    evidence.developmentModules.react ||= development.react
    evidence.developmentModules.reconciler ||= development.reconciler
  }
  evidence.responses.push({
    url: url.href,
    status,
    sha256,
    bytes: bytes.length,
    javascript,
    etag: response.headers().etag ?? null
  })
}
