/// <reference types="vite/client" />

// Credentials for Google Photorealistic 3D Tiles, declared so import.meta.env
// is typed. Values live in examples/tiles/.env.local (gitignored) and must
// never be committed or inlined into source
interface ImportMetaEnv {
  readonly VITE_ION_TOKEN?: string
  readonly VITE_GOOGLE_MAP_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
