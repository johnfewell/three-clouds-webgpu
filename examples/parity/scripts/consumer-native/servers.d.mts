import type { Build } from './proof.mjs'

export function staticServer(build: Build): Promise<{
  origin: string
  served: { path: string; sha256: string; bytes: number }[]
  close(): Promise<void>
}>
