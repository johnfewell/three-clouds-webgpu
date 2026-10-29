import {
  parseAtmosphereProfile,
  type AtmosphereProfileMode
} from './atmosphereProfile'

export type ViewMode = 'ab' | 'wipe' | 'onion' | 'diff'
export type LightingOverride = 'post' | 'lights'

export interface HarnessParams {
  caseName: string | null
  capture: boolean
  view: ViewMode
  e2e: boolean
  backend: 'webgpu' | 'webgl2'
  reversedDepthBuffer: boolean
  lighting: LightingOverride | null
  atmosphereProfile: AtmosphereProfileMode
  // `w` / `h`: render-size override for the case, both sides. All
  // registry heights are ≡ 0 mod 4, which hid a Bayer-phase bug. The
  // height-residue e2e renders 717-719 rows through this, capture never does
  size: { width: number; height: number } | null
}

const VALID_VIEWS = new Set<ViewMode>(['ab', 'wipe', 'onion', 'diff'])

export function parseHarnessParams(search: string): HarnessParams {
  const p = new URLSearchParams(search)

  const caseName = p.get('case') || null
  const capture = p.get('capture') === '1'
  const e2e = p.get('e2e') === '1'

  const rawView = p.get('view') as ViewMode | null
  const view: ViewMode =
    rawView != null && VALID_VIEWS.has(rawView) ? rawView : 'ab'

  const rawBackend = p.get('backend')
  const reversedDepthBuffer = p.get('reversedDepth') === '1'
  const backend: 'webgpu' | 'webgl2' =
    rawBackend === 'webgl2' ? 'webgl2' : 'webgpu'

  const rawLighting = p.get('lighting')
  const lighting: LightingOverride | null =
    rawLighting === 'post' || rawLighting === 'lights' ? rawLighting : null

  // The budget-closure lanes left with the interim aerial subclass. A request
  // for one must fail, not render the normal plate under a lane's name
  if (p.has('bcLane')) {
    throw new Error(
      `bcLane=${p.get('bcLane')} is no longer supported: the aerial node has no budget-closure lanes`
    )
  }

  const size = parseSize(p.get('w'), p.get('h'))
  const atmosphereProfile = parseAtmosphereProfile(
    p.get('atmosphereProfile'),
    e2e,
    capture
  )
  return {
    caseName,
    capture,
    view,
    e2e,
    backend,
    reversedDepthBuffer,
    lighting,
    atmosphereProfile,
    size
  }
}

// Both must be present and positive integers. Anything else is no override,
// so a typo cannot silently render a different size than the case declares
export function parseSize(
  w: string | null,
  h: string | null
): { width: number; height: number } | null {
  if (w == null || h == null) return null
  const width = Number(w)
  const height = Number(h)
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    return null
  }
  return { width, height }
}
