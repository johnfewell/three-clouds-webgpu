// Reads of a WGSL var outside every block that assigns it. TSL emits a shared
// node as a var where it is FIRST USED, so a first use inside one branch leaves
// the readers in a sibling branch with a stale or zero-initialised value

/** The names of the vars whose assignment's right-hand side matches `rhs` */
export function varsAssigned(wgsl: string, rhs: RegExp): string[] {
  const names = new Set<string>()
  for (const line of wgsl.split('\n')) {
    const m =
      /^\s*(?:(?:let|var(?:<\w+>)?)\s+)?(\w+)(?:\s*:\s*[^=;]+)?\s*=\s*(.*);\s*$/.exec(
        line
      )
    if (m != null && rhs.test(m[2]!)) names.add(m[1]!)
  }
  return [...names]
}

/**
 * Lines that read `name` where no earlier assignment's block encloses them.
 * It reads the text line by line: one statement per line, blocks by braces,
 * Assignments include initialised declarations. A `+=` or call
 * argument counts as a read, and a name reused in another function is one var
 */
export function readsOutsideAssigningBlock(
  wgsl: string,
  name: string
): string[] {
  const word = new RegExp(`\\b${name}\\b`)
  const assignment = new RegExp(
    `^\\s*(?:(?:let|var(?:<\\w+>)?)\\s+)?${name}(\\.\\w+)?(?:\\s*:\\s*[^=;]+)?\\s*=(?!=)`
  )
  const declaration = new RegExp(`^\\s*(var(<\\w+>)?\\s+)${name}\\b`)
  const assigned: number[][] = []
  const orphans: string[] = []
  const path: number[] = []
  wgsl.split('\n').forEach((line, index) => {
    const inside = (outer: number[]) => outer.every((o, i) => path[i] === o)
    if (assignment.test(line)) {
      const rhs = line.slice(line.indexOf('=') + 1)
      if (word.test(rhs) && !assigned.some(inside)) orphans.push(line.trim())
      assigned.push([...path])
    } else if (word.test(line) && !declaration.test(line)) {
      if (!assigned.some(inside)) orphans.push(line.trim())
    }
    for (const ch of line) {
      if (ch === '{') path.push(index)
      else if (ch === '}') path.pop()
    }
  })
  return orphans
}
