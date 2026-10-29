import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { hash, insist } from './proof.mjs'

const CONTENT_TYPES = {
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  png: 'image/png',
  bin: 'application/octet-stream',
  json: 'application/json'
}

async function closeDevelopment(server) {
  let timer
  try {
    await Promise.race([
      server.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Consumer native: development server shutdown timed out'
              )
            ),
          10000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function staticServer(build) {
  const served = []
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, 'http://localhost').pathname
      )
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end()
        return
      }
      const name = pathname.slice(build.base.length) || 'index.html'
      if (
        !pathname.startsWith(build.base) ||
        name.split(/[\\/]/).includes('..') ||
        !Object.hasOwn(build.files.files, name)
      ) {
        response.writeHead(404).end('Not found')
        return
      }
      const bytes = readFileSync(join(build.root, name))
      const digest = hash(bytes)
      insist(
        digest === build.files.files[name].sha256,
        `served file changed: ${name}`
      )
      served.push({ path: pathname, sha256: digest, bytes: bytes.length })
      response
        .writeHead(200, {
          'Content-Type':
            CONTENT_TYPES[name.split('.').at(-1)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store'
        })
        .end(bytes)
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    served,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
  }
}

export async function developmentServer(recipe) {
  const require = createRequire(join(recipe.root, 'package.json'))
  const { createServer } = await import(
    pathToFileURL(require.resolve('vite')).href
  )
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  let server
  try {
    server = await createServer({
      root: recipe.root,
      configFile: join(recipe.root, 'vite.config.ts'),
      mode: 'development',
      server: { host: '127.0.0.1', port: 0, strictPort: true }
    })
    await server.listen()
    return {
      origin: server.resolvedUrls.local[0].replace(/\/$/, ''),
      served: [],
      async close() {
        try {
          await closeDevelopment(server)
        } finally {
          if (previous === undefined) delete process.env.NODE_ENV
          else process.env.NODE_ENV = previous
        }
      }
    }
  } catch (error) {
    if (server != null) await closeDevelopment(server)
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
    throw error
  }
}
