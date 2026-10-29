// Names a GPU pass for the meter. three r185 leaves render pass descriptors
// unlabelled but names each pipeline renderPipeline_<material name>_<id>, so a
// pass takes the stem of the first pipeline set on it, as the perf map did

const PIPELINE_PREFIX = /^(?:renderPipeline|computePipeline)_/
const ID_SUFFIX = /_\d+$/

export function passLabel(pipelineLabel: string): string {
  return pipelineLabel.replace(PIPELINE_PREFIX, '').replace(ID_SUFFIX, '')
}

// What each clouds pass is, for the row tooltips
export const PASS_NOTES: Readonly<Record<string, string>> = {
  CloudsPass:
    'The cloud march, plus the light-shaft (shadow-length) march when shafts are on',
  CloudsResolve: 'Temporal resolve of the clouds at full resolution',
  ShadowPass: 'Cloud shadow map march, one call per cascade',
  ShadowResolve: 'Temporal resolve of the cloud shadow map',
  RenderPipeline:
    'The composite: aerial perspective, clouds, tone mapping, one full-screen pass',
  Stars: 'Star field',
  RTT: 'Part of the post chain rendered to a texture (three RTTNode)',
  ground: 'The scene geometry'
}

// Rows of known passes in pipeline order, so a pass that skips the first
// sample (a shadow update interval) still sits in its place
export const PASS_ORDER: readonly string[] = [
  'ShadowPass',
  'ShadowResolve',
  'CloudsPass',
  'CloudsResolve',
  'Stars',
  'ground',
  'RTT',
  'RenderPipeline'
]

export function byPassOrder<T extends { label: string }>(
  rows: readonly T[]
): T[] {
  const rank = (label: string): number => {
    const i = PASS_ORDER.indexOf(label)
    return i < 0 ? PASS_ORDER.length : i
  }
  // Array.prototype.sort is stable, so unknown passes keep first-seen order
  return [...rows].sort((a, b) => rank(a.label) - rank(b.label))
}
