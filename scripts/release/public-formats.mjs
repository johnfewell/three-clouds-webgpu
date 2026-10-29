export const BINARY =
  /\.(?:bin|png|jpe?g|gif|webp|avif|svgz|gz|zip|tgz|br|woff2?|ttf|otf|eot|mp4|webm|mov|wasm|ico|ktx2?|basis|glb|exr|hdr|bin\.json)$/i
export const TEXT =
  /\.(?:[cm]?[jt]sx?|json|jsonl|map|snap|mdx?|txt|log|html|xml|css|s[ac]ss|ya?ml|sh|env|glsl|frag|vert|wgsl|csv|patch|upstream|svg|webmanifest)$/i
export const DOTFILES = new Set([
  '.upstream-date',
  '.upstream-sha',
  '.gitignore',
  '.prettierignore',
  '.prettierrc',
  '.npmrc',
  '.npmignore',
  '.editorconfig',
  '.nojekyll'
])
