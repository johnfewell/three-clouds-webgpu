import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2]
if (!root) {
  console.error('usage: citations.mjs <dir>')
  process.exit(2)
}

const { phase } = JSON.parse(
  readFileSync(join(__dirname, 'phase.json'), 'utf8')
)
const req = JSON.parse(
  readFileSync(join(__dirname, 'required-citations.json'), 'utf8')
)

const files = []
const walk = d => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.ts$/.test(f) && !/\.test\./.test(f)) files.push(p)
  }
}
walk(root)

const contents = new Map()
for (const f of files) contents.set(f, readFileSync(f, 'utf8'))

const problems = []

const activeUrls = req.urls.filter(u => u.phase <= phase)
let urlPass = 0
for (const u of activeUrls) {
  const requiredLocations = Array.isArray(u.where) ? u.where : [u.where]
  const missingLocations = requiredLocations.filter(
    where => !contents.has(where) || !contents.get(where).includes(u.url)
  )
  if (missingLocations.length > 0) {
    problems.push(
      `MISSING url ${u.url} expected in ${missingLocations.join(', ')}`
    )
  } else {
    urlPass++
  }
  for (const [f, src] of contents) {
    if (!requiredLocations.includes(f) && src.includes(u.url)) {
      problems.push(`MISPLACED ${u.url} found in ${f}`)
    }
  }
}

const activeMarkers = req.markers.filter(m => m.phase <= phase)
let markerPass = 0
for (const m of activeMarkers) {
  const atWhere =
    contents.has(m.where) && contents.get(m.where).includes(m.text)
  if (!atWhere) {
    problems.push(
      `MISSING marker ${m.text.length > 50 ? m.text.slice(0, 47) + '...' : m.text} expected in ${m.where}`
    )
  } else {
    markerPass++
  }
}

let headersOk = true
for (const [f, src] of contents) {
  const isAllowlisted = req.attributionAllowlist.includes(f)
  if (isAllowlisted) {
    if (!src.startsWith('//')) {
      problems.push(
        `MISSING header ${f} (allowlisted glue file must start with a // comment)`
      )
      headersOk = false
    }
  } else {
    if (!src.startsWith(req.attributionHeader)) {
      problems.push(`MISSING header expected in ${f}`)
      headersOk = false
    }
  }
}

let jsdocOk = true
const LICENSE_RE =
  /Permission is hereby granted|MIT License|Apache License|BSD License/
for (const [f, src] of contents) {
  if (req.jsdocAllowlist.includes(f)) continue
  for (const m of src.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    if (LICENSE_RE.test(m[0])) continue
    problems.push(`MISPLACED jsdoc found in ${f}`)
    jsdocOk = false
    break
  }
}

for (const p of problems) console.log(p)
console.log(
  `citations: ${urlPass}/${activeUrls.length} urls, ${markerPass}/${activeMarkers.length} markers, headers ${headersOk ? 'ok' : 'FAIL'}, jsdoc ${jsdocOk ? 'ok' : 'FAIL'} — phase ${phase}`
)
process.exit(problems.length ? 1 : 0)
