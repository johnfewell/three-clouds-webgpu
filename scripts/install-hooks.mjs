#!/usr/bin/env node
// Point git at the tracked hooks folder, so every checkout and worktree runs
// scripts/hooks/pre-commit. Outside a git checkout (an exported tarball) it does nothing
import { execFileSync } from 'node:child_process'

const git = args =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()

let inside = false
try {
  inside = git(['rev-parse', '--is-inside-work-tree']) === 'true'
} catch {
  inside = false
}
if (inside) {
  let current = ''
  try {
    current = git(['config', '--get', 'core.hooksPath'])
  } catch {
    current = ''
  }
  if (current !== 'scripts/hooks') {
    git(['config', 'core.hooksPath', 'scripts/hooks'])
    console.log(
      '[hooks] core.hooksPath set to scripts/hooks (pre-commit lint and format gate)'
    )
  }
}
