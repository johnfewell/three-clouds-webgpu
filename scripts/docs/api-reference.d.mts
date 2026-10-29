export const API_PATH: string
export interface ApiMember {
  name: string
  type: string
  initialExpression: string
  documentation: string
}
export interface ApiEntry {
  name: string
  entry: string
  group: string
  source: string
  signature: string
  documentation: string
  members: ApiMember[]
}
export interface RuntimeDefaults {
  experimentalDefaults: object
  qualityPresets: object
  defaults: object
  CloudLayer: { DEFAULT: object }
  CloudLayers: { DEFAULT: ArrayLike<object> }
}
export function classifyExport(
  name: string,
  path: string,
  entry: string
): string
export function collectApi(root: string): ApiEntry[]
export function renderApiReference(
  root: string,
  runtime: RuntimeDefaults,
  api?: ApiEntry[]
): string
export function checkApiReference(root: string, markdown: string): void
