# The pass graph variant digest matrix

`src/pass/graphVariantDigest.test.ts` compiles the pass under a matrix of graph
configurations and hashes the WGSL of each. This is why that matrix looks the
way it does, how to add to it, and how to re-record it.

## The guarantee

Every variant in the matrix must compile to exactly the WGSL it compiled to on
main. That is what makes it a refactor proof: change a graph and the digest
moves, and the change cannot be waved through as "only a refactor".

The load-bearing row is `experimental/off`, the graph with every experimental
option off. It is the one that must equal main, and it does by construction:
when the matrix was the full cross product, main recorded all 8192
combinations, so every digest in the reduced matrix is a value main had already
recorded for the same settings. The reduced baseline is a **subset** of main's,
copied rather than re-recorded, and its diff against main's is a pure deletion.

## Why not the cross product

The matrix used to enumerate `1 << Object.keys(experimentalDefaults).length`, so
every new option doubled it:

| options | experimental rows | variants | baseline bytes |
| --- | --- | --- | --- |
| 11 | 2048 | 2086 | |
| 12 (lightning) | 4096 | 4134 | |
| 13 (moonlight) | 8192 | 8230 | 2,135,748 |

The cost was not only the serial compile time. `graphVariantDigest.baseline.json`
doubled too, so every option PR re-recorded a multi-megabyte file, and two
concurrent option PRs conflicted on the same lines.

What the proof needs is linear: the off graph, each option's own graph, and the
pairs where one option reads another's output. That is 1 + 13 + 7 = 21
experimental variants, 59 with the non-experimental switches, and a new option
adds two lines instead of doubling the file.

## What was given up

Interactions of three or more options are no longer enumerated. A triple that
behaves differently from its pairs is invisible to this matrix. That is the
price of not multiplying, and it is a deliberate one: the graph is a sum of
independent terms, and the pairs that do interact are listed below with the code
that couples them.

`experimental/only/computeResolve` digests the same as `experimental/off`. Its
graph is a COMPUTE pass and `digestOf()` hashes the five fragment programs the
pass owns, so this matrix cannot see that option. The row is kept anyway, so the
day a compute program joins the digest the row stops agreeing with the off row
and says so.

## The interacting pairs, and the code that couples them

A pair's digest equals neither single's whenever the two options read each
other's output. Every other pair records a graph one of its singles already
records, which is why the list is short.

| pair | what couples them |
| --- | --- |
| `convectiveProfile` x `rainShafts` | the shafts hang under the cells `convectiveProfile` places, from the SAME cell mask (`src/experimental/rainShafts.ts`), so `rainShafts` alone marches cells no option placed |
| `moonlight` x `distantCloudShadows` | `moonlight` retargets the march's one light and the cascades follow it (`src/pass/shadowGraph.ts`), and the distant shadows read that light's cascades |
| `windReprojection` x `moonlight` | both replace the march's light term, the first through `windDisplacement`, the second through the direct member |
| `cloudTypeMap` x `evolvingWeather` | the regional map rides the weather channel's uv (`src/pass/marchGraph.ts`), which `evolvingWeather` displaces per frame |
| `proceduralWeather` x `cloudTypeMap` | the same uv, and the procedural map is the one being displaced |
| `lightning` x `rainShafts` | both add to the march's in-scatter, the flash from inside the volume and the shafts from below the deck |
| `cloudFrontRefinement` x `distantShapeDetailFade` | both change the same two extra samples of the empty-space step (`src/pass/marchGraph.ts`), so the pair is where they could double-count |

A new option that reads another option's output adds a row here and in
`INTERACTING_PAIRS`. A new option that does not adds only its `only/<key>` row.

## Adding an option

1. Add the key to `experimentalDefaults` in `src/experimental/options.ts`.
2. `experimental/only/<key>` appears by itself: the key list is read off that
   object, never written out, and a test fails if an option has no alone-on row.
3. If it reads another option's output, add the pair (table above plus the
   `INTERACTING_PAIRS` entry).
4. Its docs row goes in `docs/EXPERIMENTAL.md`, or
   `test/experimentalDocs.test.ts` fails.
5. Record: see below. Expect exactly one new line, or two with a pair.

## Recording

Only when a digest really moved:

```sh
CLOUDS_WGSL_DIGEST_RECORD=1 pnpm test -- src/pass/graphVariantDigest.test.ts
```

Then read the diff of `src/pass/graphVariantDigest.baseline.json` **line by
line**. Every changed line is a graph that moved, and the pull request says why
it moved. A recorded change that nobody can explain is a defect, not a
re-record.

If the matrix and the baseline disagree about which variants exist, the file
wrote itself. Check `the baseline covers exactly the variants this file
enumerates`, which is the test that catches a half-recorded run.

## The other consumers of the baseline

* `src/experimental/rainShafts.digest.test.ts` reads the `default` entry as
  main's default digest, so `default` must keep its name and its value.
* `scripts/digest-parity.mjs` runs the digest tests against a ref and against
  the merged tree; see [digest-gate.md](digest-gate.md) for the four outcomes
  when it fires.

## Cost

The file is in vitest's `serial` project, which runs it alone. At 59 variants
that is about 5 s and no longer needs the machine to itself, but the project
assignment is left alone here: moving it is a separate change with its own
measurement.