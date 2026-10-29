export function tokenStream(text: string, fileName: string): string[]

export function firstCodeDifference(
  before: string,
  after: string,
  fileName: string
): { index: number; before?: string; after?: string } | null

export function checkCommentOnly(
  cwd: string,
  base: string,
  allow?: string[]
): { checked: number; failures: { path: string; reason: string }[] }
