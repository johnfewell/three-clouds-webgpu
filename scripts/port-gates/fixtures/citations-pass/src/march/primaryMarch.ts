// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
// NOTE(port): Not exactly the original 0.25 mipLevelScale
// TODO(port): Remove it. Fudge factor 0.5 when iterationCount==0
// TODO(port): This produces banding artifacts. Possible improvement: Binary search refinement
export const primaryMarch = 'placeholder'
