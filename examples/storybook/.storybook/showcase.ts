// The public demo. STORYBOOK_SURFACE=showcase builds only the stories marked
// Ship on the judging page (operator, 2026-10-20). main.ts compiles only
// SHOWCASE_FILES and drops every other story from the index

export const SHOWCASE_STORY_IDS = [
  'clouds-webgpu-minimal-setup--minimal-setup',
  'clouds-webgl-minimal-setup--minimal-setup',
  'clouds-webgpu-3d-tiles-renderer-integration--tokyo',
  'clouds-webgpu-3d-tiles-renderer-integration--fuji',
  'clouds-webgpu-3d-tiles-renderer-integration--london',
  'clouds-webgpu-3d-tiles-renderer-integration--toronto',
  'clouds-webgl-3d-tiles-renderer-integration--tokyo',
  'clouds-webgl-3d-tiles-renderer-integration--fuji',
  'clouds-webgl-3d-tiles-renderer-integration--london',
  'clouds-webgl-3d-tiles-renderer-integration--toronto',
  'clouds-webgpu-clouds--basic',
  'clouds-webgpu-clouds--vanilla',
  'clouds-webgl-clouds--basic',
  'clouds-webgpu-cloud-environment--mirror-and-gloss',
  'clouds-webgpu-cloudtypes--selector',
  'clouds-webgpu-cloudtypes--fair-weather-cumulus',
  'clouds-webgpu-cloudtypes--stratocumulus-deck',
  'clouds-webgpu-cloudtypes--overcast-sheet',
  'clouds-webgpu-cloudtypes--ground-fog',
  'clouds-webgpu-cloudtypes--mixed-sky',
  'clouds-webgpu-evolving-weather--evolve',
  'clouds-webgpu-night--twilight',
  'clouds-webgpu-experiments--cirrus-deck',
  'clouds-webgpu-experiments--cirrus-deck-low-sun'
]

// The files that hold those stories, so the showcase compiles nothing else
export const SHOWCASE_FILES = [
  '../src/clouds/MinimalSetup.stories.tsx',
  '../src/clouds-webgl/MinimalSetup.stories.tsx',
  '../src/clouds/3DTilesRenderer.stories.tsx',
  '../src/clouds-webgl/3DTilesRenderer.stories.tsx',
  '../src/clouds/Clouds.stories.tsx',
  '../src/clouds-webgl/Clouds.stories.tsx',
  '../src/clouds/Environment.stories.tsx',
  '../src/clouds/CloudTypes.stories.tsx',
  '../src/clouds/EvolvingWeather.stories.tsx',
  '../src/clouds/Clouds-Night.stories.tsx',
  '../src/clouds/Experiments.stories.tsx'
]

export const isShowcase = (surface: string | undefined): boolean =>
  surface === 'showcase'

// The controls a visitor sees: every category but the debug views, which
// look broken out of context. Hidden ones keep their defaults, so the render
// is unchanged
const SHOWCASE_HIDDEN_CATEGORIES = new Set(['clouds debug'])

interface ArgTypeLike {
  table?: { category?: string; disable?: boolean }
}

export function showcaseArgTypes<T extends Record<string, ArgTypeLike>>(
  argTypes: T
): T {
  const result: Record<string, ArgTypeLike> = {}
  for (const [key, argType] of Object.entries(argTypes)) {
    const category = argType.table?.category
    const shown = category == null || !SHOWCASE_HIDDEN_CATEGORIES.has(category)
    result[key] = shown
      ? argType
      : { ...argType, table: { ...argType.table, disable: true } }
  }
  return result as T
}
