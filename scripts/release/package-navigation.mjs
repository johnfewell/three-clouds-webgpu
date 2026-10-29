import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

function markdownFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })
}

function withoutFences(markdown) {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
}

function destinations(markdown) {
  return [
    ...markdown.matchAll(
      /!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+["'][^\n]*?["'])?\)/g
    ),
    ...markdown.matchAll(/^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)
  ].map(match => match[1])
}

function headingIds(markdown) {
  const counts = new Map()
  const ids = new Set()
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1]
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-')
    const count = counts.get(slug) ?? 0
    ids.add(count === 0 ? slug : `${slug}-${count}`)
    counts.set(slug, count + 1)
  }
  for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/g)) {
    ids.add(match[1])
  }
  return ids
}

function inspectLink(root, source, destination) {
  if (/^(?:https?:|mailto:|\/\/)/i.test(destination)) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(destination)) return 'unsupported URL scheme'
  const [location, fragment] = destination.split('#')
  const path = decodeURIComponent(location.split('?')[0])
  const target = path === '' ? source : resolve(dirname(source), path)
  const local = relative(root, target)
  if (local === '..' || local.startsWith('../') || path.startsWith('/')) {
    return 'escapes the package root'
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return 'target is not a shipped file'
  }
  if (fragment && target.endsWith('.md')) {
    const markdown = withoutFences(readFileSync(target, 'utf8'))
    if (!headingIds(markdown).has(decodeURIComponent(fragment))) {
      return 'heading does not exist'
    }
  }
  return undefined
}

export function verifyPackageNavigation(directory) {
  const root = resolve(directory)
  const documents = markdownFiles(root)
  if (documents.length === 0) throw new Error('Package has zero Markdown files')
  let localLinks = 0
  const failures = []
  for (const source of documents) {
    const markdown = withoutFences(readFileSync(source, 'utf8'))
    for (const destination of destinations(markdown)) {
      let problem
      try {
        problem = inspectLink(root, source, destination)
      } catch {
        problem = 'malformed destination'
      }
      if (problem === null) continue
      localLinks += 1
      if (problem !== undefined) {
        failures.push(`${relative(root, source)} -> ${destination}: ${problem}`)
      }
    }
  }
  if (localLinks === 0)
    throw new Error('Package has zero local navigation links')
  if (failures.length !== 0) {
    throw new Error(`Broken package navigation:\n${failures.join('\n')}`)
  }
  return { documents: documents.length, localLinks }
}
