// consumers that composite through the aerial node clear the scene
// background to a plain Color, since the aerial paints the sky. That is only
// safe while the scene colour has no OTHER reader, so per consumer it is read
// once, as the aerial's input. Comments are stripped first: they name the
// `skyBackground()` call on purpose
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const CONSUMERS = [
  'examples/parity/src/sideB.ts',
  'examples/basic/src/main.ts',
  'examples/r3f/src/App.tsx'
]

function code(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1')
}

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

describe('the scene colour is read only by the aerial node', () => {
  for (const path of CONSUMERS) {
    it(path, () => {
      const src = code(path)
      const row = {
        colourReads: count(src, /getTextureNode\(\s*'output'\s*\)/g),
        asAerialInput: count(
          src,
          /aerialPerspectiveWithCloudShadow\(\s*scenePass\.getTextureNode\(\s*'output'\s*\)/g
        ),
        backgroundNodeAssigned: count(src, /\.backgroundNode\s*=/g),
        skyBackgroundCalls: count(src, /skyBackground\s*\(/g),
        colorBackground: count(src, /\.background\s*=\s*new Color\(/g)
      }
      log(`scene-colour-readers:${path}`, row)
      expect(row.colourReads, 'one reader of the scene colour').toBe(1)
      expect(row.asAerialInput, 'and it is the aerial node').toBe(1)
      expect(row.backgroundNodeAssigned).toBe(0)
      expect(row.skyBackgroundCalls).toBe(0)
      expect(row.colorBackground, 'a plain Color clear').toBe(1)
    })
  }
})
