# Night skies: the moon, the stars, and moonlit clouds

The clouds march has one light and it is the sun's, so an hour after sunset the
clouds go black. This page is the two halves of fixing that:

1. **the sky behind the clouds.** takram's `SkyNode` already draws a moon and a
   real star catalogue, and the port's aerial node already paints a sky over
   every far-plane pixel. Putting one behind the other is three lines, and the
   occlusion is free.
2. **the light on the clouds.** `experimental.moonlight` retargets the march's
   one light onto the moon. See
   [EXPERIMENTAL.md](EXPERIMENTAL.md#moonlight) for the option itself.

Cloud moonlight is opt-in. Sky defaults belong to the pinned atmosphere package,
not to the clouds experiment flags. In atmosphere 0.19.1, stars are enabled by
default and can fetch a remote catalogue on first render. Set `showStars = false`
explicitly for an offline daytime scene, as the complete recipes do.

## 1. Why the moon and the stars are not in the scene background

The obvious wiring is wrong, and the repository already says so: *"No sky on the
scene background: the aerial node paints its own sky over every far-plane pixel,
so a background sky would be overwritten"* (`examples/storybook/src/clouds/Clouds-Basic.tsx`).
A `scene.backgroundNode = sky()` therefore costs a full sky evaluation and
contributes nothing.

The sky that survives is the aerial node's own. `AerialPerspectiveNode` builds a
`SkyNode` in its constructor and paints it wherever the depth buffer is at the
far plane, so the sky you see is `aerial.skyNode`, and the only question is what
you switch on inside it.

## 2. The wiring

`SkyNode` has four graph-shape flags, all of them read in `customCacheKey()`, so
flip them before the first render:

| Flag | Default | What it adds |
| --- | --- | --- |
| `showSun` | `true` | The sun disc, lit by the atmosphere LUT |
| `showMoon` | `true` | The moon disc, phase-lit by the sun's direction |
| `showStars` | `true` | The star catalogue, as a screen-space point cloud |
| `moonScattering` | `false` | Lunar inscattering in the sky, at 2.5e-6 of the solar |

```ts
import type { SkyNode } from '@takram/three-atmosphere/webgpu'
import { aerialPerspectiveWithCloudShadow } from 'three-clouds-webgpu'

const aerial = aerialPerspectiveWithCloudShadow(
  scenePass.getTextureNode('output'),
  scenePass.getTextureNode('depth'),
  cloudsPass.cloudShadowLength,
  aerialShadowNode,
  scenePass.getTextureNode('normal')
)
aerial.normalNode = scenePass.getTextureNode('normal')

// The sky the aerial node paints, which is the one behind the clouds
const sky = aerial.skyNode as SkyNode | null
if (sky != null) {
  sky.showStars = true
  sky.showMoon = true
  sky.moonScattering = true
}

// Lunar inscattering on the ground and on any surface in the frame
aerial.moonScattering = true

// ADR-001: the clouds composite over the aerial result, so the clouds occlude
// the stars and the moon for free
const composite = cloudsPass.composite(aerial)
```

**That is the whole occlusion argument.** `cloudsPass.composite(dst)` blends the
cloud layer over `dst` as `dst * (1 - alpha) + cloud`
(`src/CloudsPassNode.ts:553`), so any pixel the march covers hides the sky
behind it, and a pixel it does not cover shows the stars. There is no depth
write from the clouds and no second sky pass, so there is nothing to keep in
sync.

Two flags are worth separating. `sky.moonScattering` adds lunar light to the
*sky*; `aerial.moonScattering` adds it to the *illuminance of surfaces*, and it
is a different switch on a different object. Turning on only the first gives a
moonlit sky over an unlit ground.

### The moon's direction is already there

`AtmosphereContext` carries `moonDirectionECEF` as a uniform, and takram's
`getMoonDirectionECI(date)` fills it. The storybook stories already drive it from
their date control (`Clouds-Basic.tsx:152`), which is why the phase of the disc
is right in those stories without any extra work: `MoonNode` shades the disc with
Oren-Nayar against `sunDirectionECEF`, so the lit limb points at the sun and the
phase falls out of the two directions.

`MoonNode.colorNode` and `MoonNode.displacementNode` are optional. Without them
the moon is a white sphere lit by the sun's direction, which is the phase you
want; with them you can paste NASA Moon Kit colour and displacement maps for a
surface.

### Stars cost one fetch and one pass

`StarsNode` loads `stars.bin` from a version-pinned GitHub media URL the first
time it renders, builds point buffers from it, and rasterises the catalogue into
its own half-float render target at the drawing-buffer size each frame. Two
consequences worth knowing before you switch it on:

- **By default it is a network fetch.** `new Stars(data)` takes a URL or an
  `ArrayBufferLike`, and `SkyNode` constructs it with no argument, so the
  default is `DEFAULT_STARS_DATA_URL`: a version-pinned GitHub media URL. Pass
  your own `ArrayBuffer` and the fetch never happens. Offline, the load is
  caught and logged (`console.error`, `Stars.ts`) and the node renders no stars,
  so a missing catalogue reads as an empty sky rather than as a crash. That is
  also why no parity case turns it on: a capture that fetched from the network
  would be a capture whose result depends on the wire.
- **It is a real point cloud**, so `starsNode.intensity`, `pointSize` and
  `magnitudeRange` (a `Vector2` of faintest and brightest magnitude) are the
  three knobs. `starsNode.setSize(w, h)` is for tests; `updateBefore` sizes it
  from the renderer every frame.
- The catalogue is fixed, so stars do not twinkle and do not move. The sky node
  rotates them with the camera, which is all a star field needs.

## 3. Moonlit clouds

The sky half and the cloud half are separate switches, and a frame can have
either. With both, the moon's light on the clouds comes from the same sun disc
radiance the moon disc is drawn from, so the clouds are lit from the direction
the disc is in.

```ts
const ctx = cloudsPass.cloudsContext
ctx.experimental = { moonlight: true }
ctx.moonDirection.copy(atmosphereContext.moonDirectionECEF.value)
// The physical ratio is 2.5e-6, four orders below a fixed exposure
ctx.moonGain = 4e5
ctx.moonColor.set(0.75, 0.82, 1)
```

`moonGain` at `4e5` sounds absurd next to a documented physical value of `1`,
and that gap is the honest state of the art: moonlight is genuinely four orders
of magnitude below sunlight, and a camera exposed for a moonlit scene does not
change the ratio, it changes everything. If you expose for night, `moonGain` 1
is correct. The option's own documentation carries the same note.

Turning `moonlight` on moves three things and nothing else: the light direction
the phase function and the Beer-shadow march use, the direct share of the
irradiance the march reads, and the direction the shadow cascades are fitted to.
`applyReferenceMode` pins it off with every other experiment, and the option
defaults to `false`.

## 4. A whole night sky, in order

1. An `AtmosphereContext` on `renderer.contextNode` (`getAtmosphere`), before
   anything that reads it builds.
2. `getECIToECEFRotationMatrix(date, ...)`, `getSunDirectionECI` and
   `getMoonDirectionECI` into the atmosphere context's uniforms. Nothing else
   knows what time it is; the library reads no clock.
3. The MRT scene pass, then `CloudsPassNode`, then the aerial node.
4. On the aerial node's `skyNode`: `showStars`, `showMoon`, `moonScattering`.
   On the aerial node: `moonScattering`.
5. `cloudsPass.composite(aerial)`, then tone mapping and TAA.
6. `cloudsContext.experimental = { moonlight: true }`, `moonDirection`,
   `moonGain`.

`examples/storybook/src/clouds/Clouds-Night.tsx` is exactly this, and
`Clouds-Night.stories.tsx` puts `timeOfDay` and `moonGain` on the panel.

## 5. What is not here

- **No lunar phase model.** The phase is the sun-moon elongation, which is right
  to within the difference between the moon's phase angle and its ecliptic
  longitude. A real phase for a given date needs an ephemeris.
- **No stars in the clouds' own shadow or in the aerial perspective.** Stars are
  drawn by the sky node into the sky; cloud shadows fall on surfaces and on the
  aerial perspective's own inscattering, as they do by day.
- **No sun-and-moon cross-fade in the sky's inscattering.** The sky's lunar term
  is takram's flat 2.5e-6, with the same `TODO: Consider moon phase` upstream
  carries.
