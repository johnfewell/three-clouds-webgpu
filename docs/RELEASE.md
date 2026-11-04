# Release procedure: three-clouds-webgpu

A release is an exact source tree, package archive and set of verification
receipts. The working version is `0.1.0-alpha.8`. Check `package.json` and the
matching changelog entry before preparing a candidate; an older tag does not
establish the version or verification state of the current tree.

Distribution uses a GitHub Release archive. npm publication is not part of this
procedure. Repository changes, publication and announcement are separate from
building and testing a candidate.

## Build and verify the package

Use Node 24 and the pnpm version pinned by `packageManager`, in a clean checkout
with its own dependencies:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm build
pnpm pack --pack-destination <output-directory>
pnpm pack:verify <output-directory>/three-clouds-webgpu-0.1.0-alpha.8.tgz
```

The final build occurs after the test suite, so the archive is made from the
intended production output. Library builds explicitly select production JSX,
including when a test runner supplies `NODE_ENV=test`.

`pnpm build` clears stale declarations, builds the library, rewrites declaration
imports and writes `build/package-provenance.json`. Generated-directory symlinks
are refused before cleaning. Relative declaration imports receive `.js`
extensions so NodeNext resolution can locate the corresponding `.d.ts` files.
Missing targets and an empty declaration set fail verification.

The normal pack lifecycle checks source, generated output, documentation and
build-input digests, then verifies the API reference. A changed or missing input
requires another build. Do not bypass these checks with `--ignore-scripts`.

`pack:verify` inspects the actual archive, its file list, digests, source maps and
export targets. It writes `<archive>.receipt.json` beside the archive. The
receipt binds the archive hash without placing a self-referential hash inside
it. It proves integrity and export presence, not rendering or test execution.

The archive includes the built entrypoints, declarations, source, baked assets,
licenses, integration guides, generated API reference and complete vanilla and
React recipes. The exact list comes from `package.json` and archive verification;
file counts from an earlier release are not acceptance criteria. Tests and
private development material must not enter the package.

## Qualify real consumers

Use the verified archive to create independent consumer projects for the
supported Three.js version and retain the receipt and projects:

```sh
pnpm pack:qualify <archive> --three 0.187.0 --keep-projects --receipt <cpu-r187.json>
```

These checks cover complete recipes, real installed dependencies, asset paths,
strict application typechecks and production builds. A CPU receipt explicitly
leaves graph execution and visible frames unobserved.

Run the native harness against the retained CPU receipt on an available real
GPU:

```sh
node examples/parity/scripts/consumer-native/run.mjs <cpu-r187.json> <native-r187-directory>
```

The harness checks actual cloud contribution, updates, resize, remount and
teardown, and binds the executed assets and JavaScript to the installed archive.
Failures and partial runs remain failures or partial runs. Also build and inspect
the public demo without an optional sibling checkout, and run the source gates
on Linux. All receipts must identify the same candidate archive.

Package-health checks use pinned `publint` and `@arethetypeswrong` tools. The
latter's tool-only workspace is `scripts/release/attw`; its frozen dependency
lock avoids an incompatible `fflate` update. Keep that tool lock separate from
the shipping archive and record its digest with the result. Do not suppress a
package diagnostic or rewrite an archive to make it pass.

## Compatibility and release notes

Restate the supported configuration and limitations from
[the consumer contract](CONSUMER_CONTRACT.md), [integration guide](../INTEGRATION.md)
and [experimental reference](EXPERIMENTAL.md):

- The supported consumer uses stock Three.js 0.187.0 and the pinned fork
  atmosphere/geospatial packages, release 8. The recipes
  provide the exact dependency overrides; two atmosphere copies break context
  identity checks. Ordinary npm builds of the upstream packages are not a
  substitute for the qualified fork builds.
- The development pin is 0.187.0. Compatibility claims for another version
  require its own installed-consumer evidence, not only a permissive peer range.
- `skipLibCheck: true` is the documented safe default. Application typechecking
  still runs; upstream declaration compatibility is a separate limitation.
- `three/src/nodes/core/NodeUtils.js` is an internal import. Test it again when
  changing Three.js versions.
- The WebGL2 renderer backend is intentionally refused. Rendering requires
  hardware WebGPU; a successful import alone does not prove support.
- Preserve Shota Matsuda's MIT copyright notices, the baked-texture attribution
  and `THIRD_PARTY_NOTICES.md`.

## Review, publish and verify the released bytes

Review the source tree, documentation, images, archive, decoded source maps and
the built site artifact (`dist/site`, assembled and scanned by
`pnpm site:build`). Resolve private material and credentials before publication.
Retained provenance and intentional test fixtures require explicit, exact review;
a broad pattern exemption is not an approval of their contents.

Approve a specific candidate identified by its source/exported-tree hashes,
archive SHA-256 and qualification receipts. Publish only its standalone public
history. Do not merge development ancestry into the public repository or
replace an existing tag or asset.

Require successful public CI. Attach the exact qualified archive, `SHA256SUMS`
and a reviewed public provenance record to the approved public commit's release.
Keep raw logs and diagnostic receipts private unless separately reviewed for
publication.

Finally, download the release asset anonymously, compare its SHA-256 and repeat
native verification using the downloaded archive. Check the live site URL
in a clean browser before announcing the release. A build or upload alone is
not evidence that a new consumer can install and render it.
