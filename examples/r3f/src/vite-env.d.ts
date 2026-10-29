/// <reference types="vite/client" />

// The Cesium Ion token used by Globe.tsx, declared so `import.meta.env` is
// typed. The VALUE lives in examples/r3f/.env.local (gitignored) and must
// never be committed or inlined into source
interface ImportMetaEnv {
  readonly VITE_ION_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
