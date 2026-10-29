import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const root = process.argv[2]
const files = []
const walk = d => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx|glsl|frag|vert)$/.test(f) && !/\.test\./.test(f))
      files.push(p)
  }
}
walk(root)
const rows = [],
  links = new Set(),
  tags = { TODO: 0, FIXME: 0, HACK: 0, NOTE: 0, XXX: 0 }
let refs = 0
for (const p of files) {
  const src = readFileSync(p, 'utf8'),
    lines = src.split('\n')
  let code = 0,
    comment = 0,
    blank = 0,
    inBlock = false,
    doc = 0
  for (const raw of lines) {
    const l = raw.trim()
    if (inBlock) {
      comment++
      if (l.includes('*/')) inBlock = false
      continue
    }
    if (!l) {
      blank++
      continue
    }
    if (l.startsWith('//')) {
      comment++
      continue
    }
    if (l.startsWith('/*')) {
      comment++
      if (l.startsWith('/**')) doc++
      if (!l.includes('*/')) inBlock = true
      continue
    }
    code++
  }
  for (const m of src.matchAll(/https?:\/\/[^\s)*'"]+/g)) links.add(m[0])
  for (const t of Object.keys(tags))
    tags[t] += (src.match(new RegExp('\\b' + t + '\\b', 'g')) || []).length
  refs += (
    src.match(
      /\b(et al\.|SIGGRAPH|GDC|GPU Gems|GPU Pro|Bruneton|Hillaire|Schneider|Wrenninge|Frostbite|Horizon|Nubis|Guerrilla|Karis|Unreal|Guerrilla Games)\b/g
    ) || []
  ).length
  rows.push({
    file: relative(root, p),
    ext: extname(p),
    total: lines.length,
    code,
    comment,
    blank,
    doc,
    ratio: comment / Math.max(1, code)
  })
}
const sum = (k, filt = () => true) =>
  rows.filter(filt).reduce((a, r) => a + r[k], 0)
const isTs = r => r.ext === '.ts' || r.ext === '.tsx',
  isGl = r => !isTs(r)
const fmt = (label, filt) =>
  console.log(
    label.padEnd(8),
    'files',
    String(rows.filter(filt).length).padStart(3),
    ' code',
    String(sum('code', filt)).padStart(5),
    ' comment',
    String(sum('comment', filt)).padStart(5),
    ' blank',
    String(sum('blank', filt)).padStart(5),
    ' comment/code',
    (sum('comment', filt) / Math.max(1, sum('code', filt))).toFixed(2),
    ' doc-blocks',
    sum('doc', filt)
  )
fmt('TS', isTs)
fmt('GLSL', isGl)
fmt('all', () => true)
console.log('\nmost commented (comment lines / code lines):')
for (const r of [...rows].sort((a, b) => b.ratio - a.ratio).slice(0, 8))
  console.log(
    r.ratio.toFixed(2).padStart(6),
    String(r.comment).padStart(4) + 'c',
    String(r.code).padStart(5) + 'l ',
    r.file
  )
console.log('\nleast commented (≥ 60 code lines):')
for (const r of [...rows]
  .filter(r => r.code >= 60)
  .sort((a, b) => a.ratio - b.ratio)
  .slice(0, 8))
  console.log(
    r.ratio.toFixed(2).padStart(6),
    String(r.comment).padStart(4) + 'c',
    String(r.code).padStart(5) + 'l ',
    r.file
  )
console.log('\ntags:', JSON.stringify(tags), ' paper/author mentions:', refs)
console.log('links cited in source (' + links.size + '):')
for (const l of [...links].sort()) console.log('  ', l)
