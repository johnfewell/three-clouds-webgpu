// three logs a notice whenever it renames a duplicate TSL declaration
// (stbn to stbn_1). It is harmless and repeats thousands of times per run,
// which buried real failures in the CI log, so the runner counts it instead
export const TSL_RENAME_NOTICE =
  /THREE\.TSL: Declaration name '[^']+' of '[^']+' already in use/

export function isTslRenameNotice(log: string): boolean {
  return TSL_RENAME_NOTICE.test(log)
}

// vitest can hand one buffered call several notices, so count each of them
export function countTslRenameNotices(log: string): number {
  return log.match(new RegExp(TSL_RENAME_NOTICE.source, 'g'))?.length ?? 0
}
