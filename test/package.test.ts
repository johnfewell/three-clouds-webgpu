import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const ROOT = join(import.meta.dirname, '..')

function readText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectTs(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push(relative(ROOT, full))
    }
  }
  return out
}

describe('package attribution', () => {
  it('LICENSE contains the original copyright', () => {
    const license = readText('LICENSE')
    expect(license).toContain('Copyright (c) 2024 Shota Matsuda')
  })

  it('LICENSE names the port author beside the original', () => {
    // MIT asks for every copyright notice to travel. The original's covers
    // the ported work, ours covers everything added after it
    expect(readText('LICENSE')).toContain('Copyright (c) 2026 John Fewell')
  })

  it('package.json files array includes LICENSE', () => {
    const pkg = JSON.parse(readText('package.json'))
    expect(pkg.files).toContain('LICENSE')
  })

  it('package.json files array includes the third-party notices', () => {
    // Apache-2.0 components oblige us to carry the licence text, so a
    // consumer who installs the package has to receive it
    const pkg = JSON.parse(readText('package.json'))
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md')
  })

  it('README.md credits the upstream repo', () => {
    const readme = readText('README.md')
    expect(readme).toContain('@takram/three-clouds')
    expect(readme).toContain(
      'https://github.com/takram-design-engineering/three-geospatial'
    )
  })

  it('every non-test src/*.ts file has the attribution header', () => {
    const HEADER = 'Ported from @takram/three-clouds'
    // Not ports. Original generated data, reference mode, which is glue over
    // the port's own defaults, the cloud-type preset table and the time-of-day
    // helpers (the citations allowlist names them too)
    const NOT_PORTED = [
      'src/diagnostics.ts',
      'src/integration.ts',
      'src/experimental/cloudTypePresets.ts',
      'src/experimental/scenePresets.ts',
      'src/experimental/timeOfDay.ts',
      'src/experimental/waterProSky.ts',
      'src/referenceMode.ts',
      'src/textures/blueNoiseRankMap.ts'
    ]
    const files = collectTs(join(ROOT, 'src')).filter(
      f =>
        !f.endsWith('.test.ts') &&
        !f.endsWith('.spec.ts') &&
        !NOT_PORTED.includes(f)
    )
    const missing = files.filter(
      f => !readFileSync(join(ROOT, f), 'utf8').includes(HEADER)
    )
    expect(missing).toEqual([])
  })
})

// Every component whose code is in this tree, and the licence it obliges us to
// name. Dropping an entry fails here rather than in a release review
const NOTICES_REGISTER: [string, string][] = [
  ['@takram/three-clouds', 'MIT'],
  ['three-csm', 'MIT'],
  ['three.js', 'MIT'],
  ['OpenGL Mathematics (GLM)', 'Happy Bunny'],
  ['TileableVolumeNoise', 'MIT'],
  ['Structured Volume Sampling', 'MIT'],
  ['Huw Bowles, Daniel Zimmermann, Beibei Wang', 'MIT'],
  ['Temporal reprojection', 'MIT'],
  ['Catmull-Rom texture sampling', 'MIT'],
  ['NASA-AMMOS/3DTilesRendererJS', 'Apache-2.0'],
  ['Google Turbo colormap', 'Apache-2.0'],
  ['threejs-fire-pro GPU profiler', 'MIT'],
  ['NVIDIA spatiotemporal blue-noise textures', 'Non-Commercial Use License']
]

describe('third-party notices register', () => {
  const notices = () => readText('THIRD_PARTY_NOTICES.md')

  it.each(NOTICES_REGISTER)(
    'names %s and its licence',
    (component, licence) => {
      log('notices-register', {
        component,
        licence,
        present: notices().includes(component) && notices().includes(licence)
      })
      expect(notices()).toContain(component)
      expect(notices()).toContain(licence)
    }
  )

  it('reproduces the Apache-2.0 text its components require', () => {
    // §4(a). A pointer to apache.org is not a copy of the licence
    expect(notices()).toContain('Apache License')
    expect(notices()).toContain('Version 2.0, January 2004')
    expect(notices()).toContain('END OF TERMS AND CONDITIONS')
  })

  it('records NVIDIA as referenced, never redistributed', () => {
    // The load-bearing sentence of the whole file: if this changes, the
    // licence posture of the repository changes with it
    expect(notices()).toContain('Referenced, never redistributed')
    expect(notices()).toContain('no NVIDIA data is committed here')
  })
})
