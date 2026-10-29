/** Resolve a public file against Vite's configured deployment base */
export function sitePath(
  path: string,
  base = import.meta.env.BASE_URL
): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return `${normalizedBase}${path.replace(/^\/+/, '')}`
}
