// The reference <Clouds> loads its four baked textures from the GitHub CDN by
// default. This storybook serves the same bytes locally (setup-assets.mjs into
// public/assets), so the comparison has no network and identical
// inputs on both sides

export const cloudTextureUrls = {
  localWeatherTexture: 'assets/local_weather.png',
  shapeTexture: 'assets/shape.bin',
  shapeDetailTexture: 'assets/shape_detail.bin',
  turbulenceTexture: 'assets/turbulence.png'
} as const
