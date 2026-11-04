# Film mode

Frame-locked beauty shots of the demo for video. `?film=<shot id>` renders a
shot from `shots.ts` with no UI and the canvas on `frameloop: 'never'`; every
channel (camera, sun, cloud clock, ocean, exposure) is a function of shot
time, and 3D tiles settle before each frame renders.

```sh
pnpm --filter demo dev        # tiles shots need VITE_ION_API_TOKEN
node scripts/film.mjs --shot ocean-sunset-skim --video          # 4K60 MP4
node scripts/film.mjs --shot fuji-above-the-clouds --stills 0,10,19.9 --dpr 1
```

`--query 'tod=0.78&exp=12&cov=0.4&fh=30&cts=20'` overrides time of day,
exposure, coverage, frame heading and cloud time scale for scouting;
`cfg={"lightShafts":false}` writes context properties.

The scene preset is re-applied after mount: `<CloudLayers>` resets unclaimed
layer slots in a parent layout effect that runs after the demo's own preset
effect, so the page-load preset otherwise renders with default layers.

## Live flight steering

Live shots (`?live=…` or `VITE_LIVE_SHOT`) keep the sun-facing meander.
Hold A/D to gently steer left/right, W to gradually increase speed, and S to
slow down. Arrow keys work too. Turns are limited to 22 degrees either side,
speed to 80–130% of the shot's pace. Releasing the keys eases back toward the
original heading and speed, with a little momentum before the return begins.
The same heading steers both the camera and the passing cloud field.

Typing, browser shortcuts and film recording keep their existing behavior.
Losing focus clears the keys, and returning from a hidden tab resumes without
catching up the flight clock. Steering constants live in `steering.ts`.
