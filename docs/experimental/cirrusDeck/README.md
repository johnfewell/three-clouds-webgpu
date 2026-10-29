# Stills for `experimental.cirrusDeck`

All four crops are the same 1760x1120 region of a 2874x1794 frame, downscaled to
880x560: the Storybook stories `CirrusDeck`, `CirrusDeckOff`,
`CirrusDeckLowSun` and `CirrusDeckLowSunOff`, captured on a real GPU at DPR 2.
The camera stands 300 m up and looks 28 degrees above the horizon, so the frame
is mostly sky with the default fair-weather cumulus along the bottom.

- `noon-off.webp` and `noon-on.webp`: local noon at midsummer. With the deck on,
  fibrous streaks fill the sky behind the cumulus and run together towards a
  vanishing point, the perspective of a flat sheet 10 km up. The cumulus stay in
  front of them.
- `lowsun-off.webp` and `lowsun-on.webp`: the same view with the sun a few
  degrees above the horizon. The streaks take the sun's reddened colour,
  because the deck is lit by the atmosphere at its own position rather than by
  a fixed colour.

Measured over the upper 60 % of the full frames, the deck brightens the sky by
8.0/255 on average at noon and 14.9/255 at low sun, against 0.3/255 between two
renders with it off. Below the horizon it changes nothing.

These are crops at quality 48, because capture images are kept out of git.
The crop is the same pixels in every frame, so the comparison is unaffected.

## Reproducing

    pnpm --filter clouds-storybook exec storybook dev --port 6178 --no-open --ci
    # then capture clouds-webgpu-experiments--cirrus-deck and
    # clouds-webgpu-experiments--cirrus-deck-off (and the low-sun pair) at DPR 2

The cost that goes with these stills is in `docs/EXPERIMENTAL.md`.
