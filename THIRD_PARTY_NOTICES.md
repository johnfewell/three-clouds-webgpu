# Third-party notices

`three-clouds-webgpu` is MIT licensed (see [LICENSE](LICENSE)) and is itself a
port of MIT-licensed work. It also contains code and data from the projects
below. This file is the single place every one of them is named, with the
licence it carries, where it lives in this tree, and what the licence obliges
us to do. Where a licence requires its text to travel with the code, the text
is reproduced at the site as well as here.

Anything not listed here is ours, or is reached as a declared peer dependency
rather than copied. If you add third-party code, add it here: `test/package.test.ts`
fails if a component from this register loses its entry.

## Read this first: what is a copy and what is a reference

Three categories, and the distinction matters for what we are allowed to do:

- **Copied.** Code or data from another project is in this repository. The
  upstream licence applies to that code, its notice travels with it, and in two
  cases (Apache-2.0) we must also carry the licence text.
- **Ported through the original.** `@takram/three-clouds` itself derived from
  some of these projects, so our files carry a "Ported from
  @takram/three-clouds" header and then this project's notice beneath it. The
  MIT terms mean our port may be relicensed under our MIT, and the notices are
  kept because upstream's terms ask for attribution, not because they constrain
  ours.
- **Referenced, never redistributed.** Something this repository points at but
  does not ship. There is exactly one of these, and it is a licence with a use
  restriction.

## The base work

### @takram/three-clouds and @takram/three-geospatial — MIT

Copyright (c) 2024 Shota Matsuda.
<https://github.com/takram-design-engineering/three-geospatial>

The WebGL original this project ports, and the source of the render graph, the
maths and the baked textures. Every non-test file under `src/` carries

```text
// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
```

enforced by `test/package.test.ts` and by `scripts/port-gates/citations.mjs`.
Those packages are also declared peer dependencies, so a consumer installs them
from npm rather than receiving a second copy.

The MIT text is the `LICENSE` file at the root.

### Baked cloud textures — MIT

Copyright (c) 2024 Shota Matsuda, from `@takram/three-clouds`.

`assets/local_weather.png`, `assets/shape.bin`, `assets/shape_detail.bin`,
`assets/turbulence.png`. Four baked textures the library loads when the
procedural generators are not used. They ship in the npm package and are
covered by the root `LICENSE`. Unmodified.

## Copied code under `src/`

Each of these files carries the notice in full, in a comment block marked
`eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license,
verbatim`, which is the house pattern for an embedded licence.

### three-csm — MIT, Copyright (c) 2019 vtHawk

`src/shadow/CascadedShadowMaps.ts` is a TSL port of the cascaded shadow map
frustum splitter. Near-verbatim: the type names, the split modes, the scratch
objects and the corner diagram all survive. <https://github.com/StrandedKitty/three-csm/>

### three.js — MIT, Copyright © 2010-2026 three.js authors

`src/shadow/CascadedShadowMaps.ts` also descends from `examples/jsm/csm` at
r169, which three-csm was itself derived from; both notices are carried.
`src/shadow/fadedCascadeIndex.ts` and `examples/storybook/src/vendor/helpers/AgxToneMapping.ts`
each cite a specific three.js file.
<https://github.com/mrdoob/three.js>

### OpenGL Mathematics (GLM) — dual MIT and Happy Bunny, Copyright (c) 2005 - G-Truc Creation

`src/textures/perlin.ts` is GLM's `gtc/noise.inl` moved to TSL. The
`1.79284291400159` and `0.85373472095314` constants, the `1 / 289` modulus and
the tetrahedron correction are GLM's, and the port deliberately preserves them.
Both licence variants are reproduced in the file, as GLM ships them.

GLM's dual licence lets you choose; we use the MIT variant for this port, so the
Happy Bunny restriction does not apply to us. The block is kept intact because
that is how the file is distributed upstream.

<https://github.com/g-truc/glm/blob/master/glm/gtc/noise.inl>

### TileableVolumeNoise — MIT, Copyright (c) 2017 Sébastien Hillaire

`src/textures/tileableNoise.ts` and `src/textures/cloudShape.ts`. The
`fract(sin(n + 1.951) * 43758.5453)` hash and the `p.x + p.y * 57 + p.z * 113`
lattice packing are Hillaire's, kept bit-for-bit because the baked textures were
produced with them.
<https://github.com/sebh/TileableVolumeNoise>

### Structured Volume Sampling — MIT, Copyright (c) 2015-2016 Huw Bowles, Daniel Zimmermann, Beibei Wang

`src/march/structuredSampling.ts`. The golden-ratio sort key, the three-pass
swap network and the plane-intersection routine are theirs.
<https://github.com/huwb/volsample>

### Temporal reprojection — MIT, Copyright (c) [2015] [Playdead]

`src/resolve/varianceClipping.ts`. `clipAABB` is transliterated from
Playdead's `TemporalReprojection.shader`, variable name for variable name
(`p_clip`, `e_clip`, `v_clip`, `v_unit`, `a_unit`, `ma_unit`).
<https://github.com/playdeadgames/temporal>

### Catmull-Rom texture sampling — MIT, Copyright (c) 2019 MJP

`src/resolve/catmullRom.ts` carries the notice but no code: the nine-tap
implementation is re-exported from `@takram/three-geospatial/webgpu`, where it
is attributed. Keeping the notice costs nothing and documents the lineage.
<https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1>

## Copied code under `examples/` and `perf/`

### NASA-AMMOS/3DTilesRendererJS — Apache-2.0, Copyright (c) 2020 NASA/JPL-Caltech

`examples/storybook/src/vendor/plugins/fade/wrapFadeNodeMaterial.ts` is a manual
port of the fade material's GLSL to TSL node functions. Upstream ships no NOTICE
file at v0.4.14, so there is none to retain. Apache-2.0 §4(b) asks us to state
the changes, which the file's header does, and §4(a) to carry the licence text,
which this file does. The full text is at the end of this document.
<https://github.com/NASA-AMMOS/3DTilesRendererJS> at tag `v0.4.14`.

`3d-tiles-renderer` is also a normal npm dependency of the Storybook, deep-imported
at its raw source level by two vendored files. No Cesium source is copied: every
Cesium integration is an import from that package.

Tag pinned: `v0.4.14`.
<https://github.com/NASA-AMMOS/3DTilesRendererJS>

### Google Turbo colormap — Apache-2.0, Copyright 2019 Google LLC, SPDX-License-Identifier: Apache-2.0

`examples/parity/src/capture/turbo.ts` inlines the 256-entry lookup table for
diff images. Unchanged from the published `lut_256`. The notice identifies the
licence and the file points here for the text.

The library itself does not do this: `src/` imports `turbo` from
`@takram/three-geospatial/webgpu` rather than copying it.

### three-geospatial Storybook sources — MIT, Copyright (c) 2024 Shota Matsuda

Roughly sixty files under `examples/storybook/` are verbatim or lightly edited
copies of `storybook-webgpu/src/**` and `storybook/src/**` at commit `b012ad06`
(`reference/.upstream-sha`). Each carries a header naming the upstream path, the
commit, the licence and whether it is verbatim or edited. `.storybook/main.ts`,
`manager.ts`, `preview.tsx` and `theme.ts`, the two `typings/*.d.ts` shims, the
38 files under `src/vendor/`, the 15 under `src/clouds-webgl/vendor/` and the
six WebGL story files are the audited set.

Copied values that are not code are attributed too: the story parameter tables
in `src/clouds/3DTilesRenderer.stories.tsx` and `src/clouds/Clouds.stories.tsx`,
and the control panels in `src/clouds/controls/`.

`examples/r3f/src/Globe.tsx` is a port of the same upstream `helpers/Globe.tsx`.

### threejs-fire-pro GPU profiler — MIT, Copyright (c) 2026 Daniel Greenheck

The Storybook's dev GPU meter, `examples/storybook/src/devtools/gpuMeter/`,
adapts the GPU profiler and performance overlay of
[dgreenheck/threejs-fire-pro](https://github.com/dgreenheck/threejs-fire-pro)
at commit `c284f0b`: `src/engine/GpuProfiler.ts` (per-pass timestamp writes
added by wrapping `device.createCommandEncoder` for a sampled frame, the
overlap-aware exclusive attribution, the bounded readback) into
`GpuProfiler.ts`, `attribution.ts` and `meter.ts`, and
`editor/components/PerformanceStats.tsx` into `GpuMeterOverlay.tsx`. Each of
those four files names its upstream file in its header, states what changed,
and carries the MIT licence text. The meter is Storybook tooling and is not in
the published package.

### Inter typeface — SIL Open Font License 1.1

`examples/storybook/.storybook/preview-head.html` loads Inter from Google Fonts
at runtime. Nothing is bundled, so nothing is redistributed, and the OFL permits
this use. Removing the line would change the Storybook's appearance; it is a
runtime dependency of one example, not of the library.

## Referenced, never redistributed

### NVIDIA spatiotemporal blue-noise textures — NVIDIA Non-Commercial Use License

Copyright (c) NVIDIA Corporation.
<https://github.com/NVIDIA-RTX/STBN>

NVIDIA does not publish these under an open-source licence. The
[Non-Commercial Use License](https://github.com/NVIDIA-RTX/STBN/blob/main/License.txt)
it ships with restricts use to "research or evaluation purposes only" (§3.3) and
requires redistribution under that same licence with a complete copy of it (§3.1).
It is therefore not compatible with this repository's MIT licence and
**no NVIDIA data is committed here.**

Concretely:

- The library's default jitter volume is our own void-and-cluster blue noise,
  generated from seed `0x5eed2026` by `scripts/generate-blue-noise.mjs` and
  embedded as a 16 KB rank map in `src/textures/blueNoiseRankMap.ts`. See
  [ADR-009](docs/adr/009-stbn-jitter-volume.md).
- `scripts/jitterFixture.mjs` generates the same volume for the test harnesses,
  which answer the peer package's `**/stbn.bin` route from it so a run never
  reaches the network. Generated, gitignored, never committed.
- The Storybook's `jitter: 'stbn'` knob fetches NVIDIA's volume from its upstream
  URL **at runtime, in your browser**, exactly as the WebGL reference does. That
  is the consumer's licensing decision, made in the consumer's browser against
  NVIDIA's terms. It is not redistribution, and nothing is committed.

`test/jitterFixture.test.ts` fails if NVIDIA's volume reappears in the git index
or on disk.

## Not in this repository

- **NVIDIA's GDC 2016 temporal supersampling sample** and **Intel's Outdoor
  Light Scattering sample** are cited as formula and algorithm references at
  `src/resolve/varianceClipping.ts` and in the `@takram/three-geospatial` core
  we reach through. No code is copied, so no licence travels.
- **`reference/`** is a vendored copy of the three-geospatial sources at
  `b012ad06` (3.7 MB) used as the port's line-by-line source map. It is MIT and
  carries `reference/LICENSE.upstream`. The public source export retains it
  for source comparisons and gate checks; the consumer tarball excludes it.
- **`parity/results/`** holds measurement evidence, not third-party content.

## Our own work, recorded because it looks borrowed

- **The blue-noise generator.** `scripts/generate-blue-noise.mjs` is our
  implementation of Ulichney's void-and-cluster (1993) and the spatiotemporal
  kernel of Wolfe et al. (2022), both published methods. The `mulberry32` PRNG
  and the `lowbias32` constants in it are folklore snippets rather than a
  dependency, and are named in the file. Nothing third-party.
- **Bayer ordered dither** (`src/resolve/bayer.ts`) is a published 4×4 integer
  threshold table, credited to the original at the file.
- **Phase functions, multiple-scattering octaves, cube-to-sphere UVs, the haze
  march and the Vogel disk** in `src/` are implementations of published methods,
  each citing the paper or article it follows.

## Adding an entry

Three things must all be true before a dependency is listed here:

1. The file carries a header naming the upstream project, the licence, and the
   copyright holder.
2. If the upstream licence requires its text to travel with the code, the text
   is in the file, wrapped in an `eslint-disable no-comment-slop/max-comment-lines
   -- vendored MIT license, verbatim` guard.
3. An entry appears above with the component, the licence and the path.

## Apache License 2.0, full text

Required by §4(a) for the two Apache-2.0 components above. Reproduced from
<https://www.apache.org/licenses/LICENSE-2.0.txt>.


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
