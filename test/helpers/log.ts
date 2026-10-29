import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(import.meta.dirname, '../../test-results/unit')

let currentSpec = 'unknown'
const logBuffer = new Map<string, string[]>()

export function setCurrentSpec(name: string): void {
  currentSpec = name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function log(
  scope: string,
  kvOrTable: Record<string, unknown> | unknown[]
): void {
  const lines: string[] = []
  const prefix = `[test][${currentSpec}][${scope}]`

  if (Array.isArray(kvOrTable)) {
    for (const row of kvOrTable) {
      lines.push(`${prefix} ${JSON.stringify(row)}`)
    }
  } else {
    const parts = Object.entries(kvOrTable)
      .map(
        ([k, v]) =>
          `${k}=${typeof v === 'number' ? v.toPrecision(8) : String(v)}`
      )
      .join(' ')
    lines.push(`${prefix} ${parts}`)
  }

  if (!logBuffer.has(currentSpec)) {
    logBuffer.set(currentSpec, [])
  }
  logBuffer.get(currentSpec)!.push(...lines)

  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
  appendFileSync(join(LOG_DIR, `${currentSpec}.log`), lines.join('\n') + '\n')

  if (process.env.TEST_LOG === '1') {
    for (const line of lines) {
      console.log(line)
    }
  }
}

export function getLogLines(spec?: string): string[] {
  if (spec) {
    return logBuffer.get(spec) ?? []
  }
  return Array.from(logBuffer.values()).flat()
}

export function getLastLines(n: number, spec?: string): string[] {
  const lines = getLogLines(spec)
  return lines.slice(-n)
}

export function clearLogBuffer(): void {
  logBuffer.clear()
}
