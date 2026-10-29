import { getLastLines } from './log'

export default class LogReporter {
  onTaskUpdate(
    packs: Array<[string, { state?: string } | undefined, ...unknown[]]>
  ) {
    for (const [, result] of packs) {
      if (result?.state === 'fail') {
        const lines = getLastLines(50)
        if (lines.length > 0) {
          console.log('\n--- Last 50 log lines ---')
          for (const line of lines) {
            console.log(line)
          }
          console.log('--- end log lines ---\n')
        }
      }
    }
  }
}
