// Fails a showcase build whose index is not exactly the picked stories: a
// renamed export would otherwise drop a story without a word, and a filter
// that stopped running would ship every lab story
import { readFile } from 'node:fs/promises'

import { SHOWCASE_STORY_IDS } from '../.storybook/showcase.ts'

const dir = process.argv[2] ?? 'dist'
const index = JSON.parse(await readFile(`${dir}/index.json`, 'utf8'))
const built = Object.values(index.entries)
  .filter(entry => entry.type === 'story')
  .map(entry => entry.id)
if (built.length === 0) {
  console.error(`check-showcase: REFUSING, ${dir}/index.json lists no stories`)
  process.exit(1)
}
const picked = new Set(SHOWCASE_STORY_IDS)
const missing = SHOWCASE_STORY_IDS.filter(id => !built.includes(id))
const extra = built.filter(id => !picked.has(id))
console.log(
  `check-showcase: ${built.length} stories built, ${picked.size} picked, ` +
    `${missing.length} missing, ${extra.length} extra`
)
for (const id of missing) console.error(`  missing: ${id}`)
for (const id of extra) console.error(`  extra: ${id}`)
process.exit(missing.length + extra.length === 0 ? 0 : 1)
