// Types for merge-check.mjs, in the shape receipt-key.d.mts uses: the module is
// plain .mjs so node runs it as a CLI with no transpile step, and this
// declares the pure helpers for its TypeScript test
import type { execFileSync } from 'node:child_process'

/** Injected so a test can drive the helpers without shelling out */
export type Exec = typeof execFileSync

/** Extensions `node --check` parses and tsc never reads */
export const PARSED_EXTENSIONS: readonly string[]

/** Whether a changed path is one the parse gate covers */
export function isPlainScript(file: string): boolean

/** Plain scripts differing between two commits, deletions excluded */
export function changedScripts(
  root: string,
  base: string,
  head: string,
  deps?: { exec?: Exec }
): string[]

/** Parse each file, reporting syntax errors without executing */
export function parseCheck(
  root: string,
  files: readonly string[],
  deps?: { exec?: Exec }
): { checked: number; failures: { file: string; output: string }[] }

/** 0 when every listed script parses, 1 on any failure, and says so over zero */
export function reportParse(
  root: string,
  files: readonly string[],
  deps?: { exec?: Exec }
): number
