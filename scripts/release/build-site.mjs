// Assemble the public site artifact, the demo at the root and the showcase
// Storybook under /storybook, then scan it with the publication scanner
// against exact approvals. Nothing here deploys: site/ holds the Worker config
//   node scripts/release/build-site.mjs [--out dist/site] [--approvals <json>]
//     [--skip-build]
import { execFileSync, execFileSync as git } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { publicationFiles, scanPublicFiles } from './public-scan.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
export const DEMO_DIST = 'examples/demo/dist'
export const SHOWCASE_DIST = 'examples/storybook/dist'
// The scanner's name for the published-site surface, shared with export-verify
export const SITE_SURFACE = 'pages'
export const RECEIPT_PROTOCOL = 'clouds-site-v1'

class SiteRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'SiteRefusal'
  }
}
const refuse = message => {
  throw new SiteRefusal(message)
}

// One token serves both builds: the site is one origin, so one
// domain-restricted client token covers the demo and the showcase tiles
export function buildInputs(token) {
  const client = token ?? ''
  return {
    showcase: {
      NODE_ENV: 'production',
      STORYBOOK_SURFACE: 'showcase',
      STORYBOOK_ION_API_TOKEN: client
    },
    demo: { NODE_ENV: 'production', VITE_ION_API_TOKEN: client }
  }
}

// In order: the library the bundlers resolve, the showcase cut and its index
// check, then the demo. A failed step stops the build before any assembly
export const BUILD_STEPS = [
  { name: 'library', command: 'pnpm', args: ['build'], env: null },
  {
    name: 'showcase',
    command: 'pnpm',
    args: ['--filter', 'clouds-storybook', 'build'],
    env: 'showcase'
  },
  {
    name: 'showcase-check',
    command: 'node',
    args: ['examples/storybook/scripts/check-showcase.mjs', SHOWCASE_DIST],
    env: null
  },
  {
    name: 'demo',
    command: 'pnpm',
    args: ['--filter', 'demo', 'build'],
    env: 'demo'
  }
]

export function buildSources(token, run = runStep) {
  const inputs = buildInputs(token)
  for (const step of BUILD_STEPS)
    run(step.command, step.args, step.env ? inputs[step.env] : {})
}

function runStep(command, args, env) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
}

export function countFiles(dir) {
  let count = 0
  const visit = path => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) refuse(`symlink in site input: ${path}`)
    if (stat.isDirectory())
      for (const name of readdirSync(path)) visit(join(path, name))
    else count++
  }
  if (existsSync(dir)) visit(dir)
  return count
}

// Only this script's own previous output is replaced: the receipt beside it
// is the proof. Anything else at that path is refused
function clearOwnOutput(out) {
  if (!existsSync(out)) return
  const receipt = join(dirname(out), 'site-receipt.json')
  let previous = null
  try {
    previous = JSON.parse(readFileSync(receipt, 'utf8'))
  } catch {
    previous = null
  }
  if (previous?.protocol !== RECEIPT_PROTOCOL || previous.out !== out)
    refuse(`site output exists and is not this script's: ${out}`)
  rmSync(out, { recursive: true })
}

// The demo owns the root and the showcase owns /storybook. A demo file at
// that name would be shadowed, so it is refused rather than merged
export function assembleSite(demoDist, showcaseDist, out) {
  const demoFiles = countFiles(demoDist)
  const showcaseFiles = countFiles(showcaseDist)
  if (demoFiles === 0)
    refuse(`demo build output is missing or empty: ${demoDist}`)
  if (showcaseFiles === 0)
    refuse(`showcase build output is missing or empty: ${showcaseDist}`)
  if (existsSync(join(demoDist, 'storybook')))
    refuse('demo output already has a storybook entry')
  clearOwnOutput(out)
  mkdirSync(out, { recursive: true })
  const copy = {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false
  }
  cpSync(demoDist, out, copy)
  cpSync(showcaseDist, join(out, 'storybook'), copy)
  const files = countFiles(out)
  if (files !== demoFiles + showcaseFiles)
    refuse(
      `assembled ${files} files from ${demoFiles} + ${showcaseFiles} inputs`
    )
  return { files, demoFiles, showcaseFiles }
}

export function readApprovals(path) {
  if (!path) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    refuse(`approvals file is not JSON: ${path}`)
  }
  if (!Array.isArray(parsed)) refuse('approvals must be a JSON array')
  return parsed
}

export function scanSite(out, approvals, token) {
  const result = scanPublicFiles(
    publicationFiles(out, SITE_SURFACE),
    approvals,
    {
      publicToken: token || undefined
    }
  )
  const ok =
    result.unapproved.length === 0 && result.allowlistErrors.length === 0
  return { ok, result }
}

function gitValue(args) {
  return git('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()
}

export function siteReceipt(out, assembled, scan, extra) {
  const { result } = scan
  return {
    protocol: RECEIPT_PROTOCOL,
    createdAt: new Date().toISOString(),
    out,
    commit: gitValue(['rev-parse', 'HEAD']),
    dirty: gitValue(['status', '--porcelain']) !== '',
    files: result.files,
    bytes: result.bytes,
    demoFiles: assembled.demoFiles,
    showcaseFiles: assembled.showcaseFiles,
    manifestSha256: result.manifestSha256,
    surfaceManifests: result.surfaceManifests,
    unapproved: result.unapproved.length,
    allowlistErrors: result.allowlistErrors.length,
    publicClientTokenSha256: result.publicClientTokenSha256,
    ...extra
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2)
  const valued = flag => {
    const at = args.indexOf(flag)
    return at === -1 ? undefined : args[at + 1]
  }
  const out = resolve(ROOT, valued('--out') ?? 'dist/site')
  const approvalsPath = valued('--approvals')
  const token = process.env.SITE_ION_API_TOKEN
  try {
    if (!args.includes('--skip-build')) buildSources(token)
    const assembled = assembleSite(
      resolve(ROOT, DEMO_DIST),
      resolve(ROOT, SHOWCASE_DIST),
      out
    )
    const approvals = readApprovals(approvalsPath && resolve(approvalsPath))
    const scan = scanSite(out, approvals, token)
    const receipt = siteReceipt(out, assembled, scan, {
      tokenPresent: Boolean(token),
      approvals: approvalsPath ? resolve(approvalsPath) : null
    })
    writeFileSync(
      join(dirname(out), 'site-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n'
    )
    console.log(
      JSON.stringify(
        {
          out,
          files: assembled.files,
          manifestSha256: scan.result.manifestSha256,
          unapproved: scan.result.unapproved,
          allowlistErrors: scan.result.allowlistErrors
        },
        null,
        2
      )
    )
    if (!scan.ok) {
      console.error('Site scan refused: unapproved findings, nothing to deploy')
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`Site build refused: ${error.message}`)
    process.exitCode = 1
  }
}
