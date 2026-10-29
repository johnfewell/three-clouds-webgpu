# 3D Tiles example

A plain TypeScript (no React) WebGPU scene with Google Photorealistic 3D Tiles, volumetric clouds, atmosphere, and cloud shadows on tiles.

## Getting started

```bash
pnpm --filter tiles dev   # http://localhost:5262
```

## Credentials

The example reads tile provider credentials from Vite environment variables:

- `VITE_ION_TOKEN`: Cesium ion personal access token for Cesium ion asset 2275207 (Google Photorealistic 3D Tiles).
- `VITE_GOOGLE_MAP_API_KEY`: Google Maps Platform API key with Map Tiles API enabled.

Credentials can be placed in a `.env.local` file under `examples/tiles/` (gitignored):

```bash
# examples/tiles/.env.local
VITE_ION_TOKEN=your_cesium_ion_token
# or
VITE_GOOGLE_MAP_API_KEY=your_google_maps_api_key
```

### Running without a key

If neither token is provided, the scene automatically falls back to rendering a dark WGS84 globe ellipsoid with an on-screen explanation. Volumetric clouds, atmosphere, and cloud shadows continue to render in full fidelity over the ellipsoid.

## What it demonstrates

- **Google Photorealistic 3D Tiles via `3d-tiles-renderer`** with `GoogleCloudAuthPlugin` / `CesiumIonAuthPlugin`, `GLTFExtensionsPlugin` (Draco compression), `TileCompressionPlugin`, `TileCreasedNormalsPlugin`, and `TilesFadePlugin`.
- **Post-lit aerial perspective with cloud shadows**: `TileMaterialReplacementPlugin` swaps tile materials to `MeshBasicNodeMaterial` while preserving `.map` textures, allowing `aerialPerspectiveWithCloudShadow` to apply aerial haze and cascaded cloud shadows onto the geometry.
- **Geospatial camera & orientation**: Camera positioned over Tokyo using `Geodetic` coordinates and `PointOfView`, with `syncCelestialDirections` matching the sun position to the authored date and location.
- **Three-clouds WebGPU pipeline**: `cloudsPass`, baked cloud textures, STBN jitter volume, and temporal accumulation.
