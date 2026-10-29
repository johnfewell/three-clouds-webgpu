# Stills for `experimental.cloudTypeMap`

Both crops are the same 880x560 region of one frame: the Storybook stories
`CloudTypeMapFromAbove` and `CloudTypeMapFromAboveBaseline`, captured on a real
GPU at DPR 2, 2874x1794, from 60 km over the WebGL story's four cloud layers.

- `above-off.webp` is `experimental.cloudTypeMap = false`. One vocabulary over
  the whole globe: a fine, uniform speckle with no large-scale structure.
- `above-on.webp` is the flag on with a two-region map authored. The same deck,
  broken into regions of visibly different texture, some smooth and washed and
  some mottled and lumpy.

These are crops, downscaled and at quality 48, because full capture images
are not distributed with the package. The full
2874x1794 originals are the ones the timing ran against and are not committed;
the crop is the same pixels in both frames, so the comparison is unaffected.

A single frame at eye level cannot show this well, because a type region is
about 200 km and an eye-level view holds a few of them inside one blend. The
horizon pair, captured at the same time, shows the change but reads as "the
deck got smoother" rather than "the deck got regional".

## Reproducing

    pnpm --filter clouds-storybook exec storybook dev --port 6118 --no-open --ci
    # then drive clouds-webgpu-experiments--cloud-type-map-from-above and
    # clouds-webgpu-experiments--cloud-type-map-from-above-baseline at DPR 2

The timing numbers that go with these stills are in `docs/EXPERIMENTAL.md`.
## Seam and boundary check

Captured again after the `ProceduralWeather` duplicate-export fix, at DPR 2,
2874x1794, four arms: the from-above pair and the horizon pair, flag off and on.

Reading the frames rather than just measuring them:

- **No hard region boundaries.** Every transition is gradual. That is by
  construction, not luck: the blend is a convex combination through a
  `saturate`d tent over a smoothly rank-equalised field, and the middle anchor
  exists precisely so a boundary reads as a third genus instead of a step.
- **No seams.** The `on` minus `off` difference image isolates exactly what the
  flag added, and it is a smooth large-scale field with no straight line, no
  repeating tile edge and no grid in it. A wrap artifact at the map's tiling
  boundary would appear there as a hard line, so the map is continuous across
  wherever these two cameras can see.
- **The difference grows toward the camera** and is zero in the sky, which is
  what a per-sample parameter blend should do.
- **Limit worth stating:** one weather tiling is about 400 km at the story's
  `localWeatherRepeat`, and these frames cover a few hundred km. So this shows
  no seam *in this region*, not no seam anywhere on the globe; a cube-sphere
  face boundary is not exercised by either camera.
