export type Side = 'A' | 'B'

export function harnessLog(
  caseName: string,
  side: Side,
  step: string,
  kv: Record<string, unknown> = {}
): void {
  const parts = Object.entries(kv)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  const msg = `[parity][${caseName}][${side}] ${step}${parts ? ' ' + parts : ''}`
  console.log(msg)
}
