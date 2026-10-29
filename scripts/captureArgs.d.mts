// Types for captureArgs.mjs

export interface CaptureFlag {
  name: string
  aliases?: readonly string[]
  takes?: string
  kind?: 'number' | 'string'
  required?: boolean
  help: string
}

export interface CaptureValues {
  phaseFilter: number | undefined
  onlyPhaseFilter: number | undefined
  caseFilter: string | undefined
  sabotageMode: string | undefined
  allowSkip: boolean
  keepLinear: boolean
  outDirOverride: string | undefined
  /** set only with --out outside parity/results */
  atmosphereProfile: 'lookup-both' | 'raymarch-256' | undefined
}

export type CaptureArgsResult =
  | { ok: true; help: boolean; values: CaptureValues }
  | { ok: false; help: false; argument: string; error: string }

export const CAPTURE_FLAGS: readonly CaptureFlag[]

export function parseCaptureArgs(argv: readonly string[]): CaptureArgsResult

export function formatCaptureUsage(): string
