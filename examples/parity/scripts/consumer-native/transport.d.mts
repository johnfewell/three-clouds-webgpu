export function detectDevelopmentModules(source: string): {
  react: boolean
  reconciler: boolean
}

export interface ObservedResponse {
  url(): string
  status(): number
  finished(): Promise<Error | null>
  body: () => Promise<Buffer>
  headers(): Record<string, string>
  request(): { headers(): Record<string, string> }
}

export function createResponseRecorder(
  scenario: {
    development: boolean
    build: {
      base: string
      files: { files: Record<string, { sha256: string; bytes: number }> }
    }
  },
  evidence: {
    responses: Record<string, unknown>[]
    aborted: string[]
    developmentModules: { react: boolean; reconciler: boolean }
  }
): (response: ObservedResponse) => Promise<void>
