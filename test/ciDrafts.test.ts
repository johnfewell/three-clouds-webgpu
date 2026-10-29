import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const active = '../.github/workflows/ci.yml'
const workflow = readFileSync(new URL(active, import.meta.url), 'utf8')
const workflows = workflow.includes('# workflow: private')
  ? [active, '../.github/public-workflows/ci.yml']
  : [active]

describe('CI skips draft pull requests', () => {
  for (const path of workflows) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8')

    it(`${path} runs again when a draft is marked ready`, () => {
      expect(text).toMatch(
        /types: \[opened, synchronize, reopened, ready_for_review\]/
      )
    })

    it(`${path} skips the build job on a draft`, () => {
      expect(text).toContain(
        "if: github.event_name != 'pull_request' || !github.event.pull_request.draft"
      )
    })
  }
})
