import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const RESULTS_DIR = join(import.meta.dirname, '..', '..', 'parity', 'results')

export function capturePlugin(): Plugin {
  return {
    name: 'parity-capture',
    configureServer(server) {
      server.middlewares.use('/api/capture', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              phase: string
              caseName: string
              side: string
              filename: string
              data: string
              log?: string[]
            }

            const dir = join(RESULTS_DIR, body.phase, body.caseName)
            if (!existsSync(dir)) {
              mkdirSync(dir, { recursive: true })
            }

            const buf = Buffer.from(body.data, 'base64')
            writeFileSync(join(dir, body.filename), buf)

            if (body.log != null) {
              writeFileSync(
                join(dir, 'capture.log'),
                body.log.join('\n') + '\n'
              )
            }

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, path: dir }))
          } catch (err) {
            res.statusCode = 400
            res.end(String(err))
          }
        })
      })
    }
  }
}
