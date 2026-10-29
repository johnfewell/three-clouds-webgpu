// Vite plugin surfacing the port-gate results in the footer: the build defines
// VITE_GATES and writes api/gates.json, dev serves the same file on demand
// A dead dev footer made site.spec.ts pass in CI and fail locally)
// Collected LAZILY on first request, not at startup, then cached

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')
const SRC_DIR = join(PROJECT_ROOT, 'src')

interface GateResult {
  name: string
  summary: string
  ok: boolean
}

function runGate(script: string, args: string[] = []): GateResult {
  const cmd = `node ${script} ${args.join(' ')}`
  try {
    const output = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const lines = output.trim().split('\n')
    const summary =
      lines.findLast(l => !/^\s*https?:\/\//.test(l) && !/:\s*$/.test(l)) ??
      lines[lines.length - 1] ??
      ''
    return { name: script, summary, ok: true }
  } catch (err) {
    const stderr =
      err instanceof Error && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : ''
    const stdout =
      err instanceof Error && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout)
        : ''
    const combined = (stdout + '\n' + stderr).trim()
    const lines = combined.split('\n')
    const summary = lines[lines.length - 1] ?? 'failed'
    return { name: script, summary, ok: false }
  }
}

function collectGates(): {
  summary: string
  gates: GateResult[]
} {
  const scripts = [
    {
      path: 'scripts/port-gates/decision-points.mjs',
      args: [SRC_DIR, '--max', '12']
    },
    { path: 'scripts/port-gates/comment-audit.mjs', args: [SRC_DIR] },
    { path: 'scripts/port-gates/citations.mjs', args: [SRC_DIR] }
  ]

  const gates = scripts.map(s => runGate(s.path, s.args))
  const summary = gates.map(g => g.summary).join(' · ')
  return { summary, gates }
}

export function gatesPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig
  let gatesData: { summary: string; gates: GateResult[] } | null = null

  return {
    name: 'parity-gates',

    config(_, env) {
      if (env.command === 'build') {
        gatesData = collectGates()
        return {
          define: {
            'import.meta.env.VITE_GATES': JSON.stringify(gatesData.summary)
          }
        }
      }
    },

    configResolved(resolved) {
      resolvedConfig = resolved
    },

    configureServer(server) {
      server.middlewares.use('/api/gates.json', (_req, res) => {
        gatesData ??= collectGates()
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            summary: gatesData.summary,
            gates: gatesData.gates.map(g => ({
              name: g.name,
              summary: g.summary,
              ok: g.ok
            }))
          })
        )
      })
    },

    writeBundle() {
      if (resolvedConfig.command !== 'build' || !gatesData) return

      const outDir = resolve(resolvedConfig.root, resolvedConfig.build.outDir)
      const apiDir = join(outDir, 'api')
      mkdirSync(apiDir, { recursive: true })

      writeFileSync(
        join(apiDir, 'gates.json'),
        JSON.stringify(
          {
            summary: gatesData.summary,
            gates: gatesData.gates.map(g => ({
              name: g.name,
              summary: g.summary,
              ok: g.ok
            }))
          },
          null,
          2
        )
      )
    }
  }
}
