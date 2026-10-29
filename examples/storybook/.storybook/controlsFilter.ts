// Controls panel helpers the built-in panel lacks: a filter box over the
// controls, and collapsed categories that stay collapsed across stories. The
// panel is Storybook's own, so this works on its DOM: category header rows
// carry title="Hide <name> items" (expanded) or "Show <name> items"

import { main } from './theme'

const STORAGE_KEY = 'controls-filter:collapsed'
const PANEL = '[id$="tabpanel-addon-controls"]'
const HEADER = /^(Hide|Show) (.+) items$/

interface Header {
  row: HTMLTableRowElement
  name: string
  expanded: boolean
}

function readCollapsed(): Set<string> {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '[]'
    )
    return new Set(Array.isArray(stored) ? stored.map(String) : [])
  } catch {
    return new Set()
  }
}

function writeCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]))
  } catch {
    // Private windows and blocked storage keep it for this page load only
  }
}

function parseHeader(row: HTMLTableRowElement): Header | null {
  const match = HEADER.exec(row.title)
  if (match == null) return null
  return { row, name: match[2], expanded: match[1] === 'Hide' }
}

function headers(table: HTMLTableElement): Header[] {
  return [...table.querySelectorAll<HTMLTableRowElement>('tr[title]')]
    .map(parseHeader)
    .filter(header => header != null)
}

function controlsTable(): HTMLTableElement | null {
  return document.querySelector<HTMLTableElement>(`${PANEL} table`)
}

// A row's label, its arg keys and its category, lowercased for matching
function rowText(row: HTMLTableRowElement, category: string): string {
  const label = row.cells[0]?.textContent ?? ''
  const keys = [...row.querySelectorAll('[name]')]
    .map(el => el.getAttribute('name') ?? '')
    .join(' ')
  return `${label} ${keys} ${category}`.toLowerCase()
}

function styled<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  Object.assign(el.style, style)
  return el
}

const buttonStyle: Partial<CSSStyleDeclaration> = {
  font: 'inherit',
  fontSize: '12px',
  padding: '4px 8px',
  color: main.textColor,
  background: 'transparent',
  border: `1px solid ${main.appBorderColor}`,
  borderRadius: `${main.inputBorderRadius}px`,
  cursor: 'pointer'
}

class ControlsFilter {
  private readonly collapsed = readCollapsed()
  private readonly bar = styled('div', {
    position: 'sticky',
    top: '0',
    zIndex: '2',
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    padding: '8px 10px',
    background: main.appContentBg,
    borderBottom: `1px solid ${main.appBorderColor}`
  })
  private readonly input = styled('input', {
    flex: '1',
    minWidth: '0',
    font: 'inherit',
    fontSize: '13px',
    padding: '5px 8px',
    color: main.inputTextColor,
    background: main.inputBg,
    border: `1px solid ${main.inputBorder}`,
    borderRadius: `${main.inputBorderRadius}px`
  })
  private readonly count = styled('span', {
    fontSize: '12px',
    color: main.textMutedColor,
    whiteSpace: 'nowrap'
  })
  // Clicks this script makes, so they are not recorded as the user's choice
  private applying = false
  private scheduled = false

  constructor() {
    this.bar.dataset.controlsFilter = ''
    this.input.type = 'search'
    this.input.placeholder = 'Filter controls'
    this.input.setAttribute('aria-label', 'Filter controls')
    this.input.addEventListener('input', () => this.schedule())
    this.input.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      this.input.value = ''
      this.schedule()
    })
    this.bar.append(
      this.input,
      this.count,
      this.button('Collapse all', () => this.setAll(true)),
      this.button('Expand all', () => this.setAll(false))
    )
  }

  install(): void {
    document.addEventListener('click', event => this.onClick(event), true)
    // The panel re-renders on every story change and arg update
    new MutationObserver(mutations => {
      if (mutations.every(m => this.bar.contains(m.target))) return
      this.schedule()
    }).observe(document.body, { childList: true, subtree: true })
    this.schedule()
  }

  // Every word has to appear in the row's label, arg key or category, so
  // "layer 2 cov" finds coverage in cloud layer 2
  private words(): string[] {
    return this.input.value.toLowerCase().split(/\s+/).filter(Boolean)
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = styled('button', buttonStyle)
    b.type = 'button'
    b.textContent = text
    b.addEventListener('click', onClick)
    return b
  }

  private setAll(collapse: boolean): void {
    const table = controlsTable()
    if (table == null) return
    for (const { name } of headers(table)) {
      if (collapse) this.collapsed.add(name)
      else this.collapsed.delete(name)
    }
    writeCollapsed(this.collapsed)
    this.schedule()
  }

  // The user's own click on a category header, recorded before the panel
  // re-renders the row
  private onClick(event: MouseEvent): void {
    if (this.applying || this.words().length > 0) return
    const row = (event.target as Element | null)?.closest('tr[title]')
    if (!(row instanceof HTMLTableRowElement) || !row.closest(PANEL)) return
    const header = parseHeader(row)
    if (header == null) return
    if (header.expanded) this.collapsed.add(header.name)
    else this.collapsed.delete(header.name)
    writeCollapsed(this.collapsed)
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => this.apply())
  }

  private apply(): void {
    this.scheduled = false
    const table = controlsTable()
    if (table == null) return
    if (this.bar.nextElementSibling !== table) table.before(this.bar)
    // A search opens every category so it can see their rows. Clearing it
    // puts back what the user chose
    const searching = this.words().length > 0
    this.applying = true
    for (const header of headers(table)) {
      const wantExpanded = searching || !this.collapsed.has(header.name)
      if (header.expanded !== wantExpanded) {
        header.row.querySelector('button')?.click()
      }
    }
    this.applying = false
    this.filterRows(table)
  }

  private filterRows(table: HTMLTableElement): void {
    const words = this.words()
    let category = ''
    let header: HTMLTableRowElement | null = null
    let hits = 0
    let shown = 0
    let total = 0
    const closeSection = (): void => {
      if (header == null) return
      header.style.display = words.length > 0 && hits === 0 ? 'none' : ''
    }
    for (const row of table.querySelectorAll<HTMLTableRowElement>(
      'tbody > tr'
    )) {
      const parsed = parseHeader(row)
      if (parsed != null) {
        closeSection()
        header = row
        category = parsed.name
        hits = 0
        continue
      }
      total++
      const text = rowText(row, category)
      const hit = words.every(word => text.includes(word))
      row.style.display = hit ? '' : 'none'
      if (hit) {
        hits++
        shown++
      }
    }
    closeSection()
    this.count.textContent = words.length > 0 ? `${shown} of ${total}` : ''
  }
}

export function installControlsFilter(): void {
  new ControlsFilter().install()
}
