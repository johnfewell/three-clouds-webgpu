// TilesRenderer.getAttributions() reports a credit per contributing
// source, so the same provider string (and logo) can arrive several times.
// Keep every UNIQUE credit, first occurrence first, so the list is stable as
// tiles stream in; duplicates are the same type with the same (trimmed) value.
// Pure, so it is testable without React (test/storybookAttributions.test.ts).

export interface TileAttribution {
  type: string
  value: unknown
}

export function uniqueAttributions<T extends TileAttribution>(
  attributions: readonly T[]
): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const attribution of attributions) {
    const value =
      typeof attribution.value === 'string'
        ? attribution.value.trim()
        : String(attribution.value)
    if (value === '') continue
    const key = `${attribution.type}\u0000${value}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(attribution)
  }
  return unique
}
