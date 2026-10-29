// Index grid page: 55-case ladder with thumbnails, metrics, and lightbox

import { cases } from '../cases/index'
import type { MetricsSchema } from './capture/metricsWriter'
import {
  buildGridData,
  countNumberedRows,
  type GridRow,
  type SequenceInfo
} from './gridData'
import { sitePath } from './sitePath'

const STATUS_COLORS: Record<string, string> = {
  pass: '#2d5',
  fail: '#f44',
  'expected-difference': '#fa0',
  'not-yet': '#666',
  'hardware-skip': '#888'
}

const STATUS_LABELS: Record<string, string> = {
  pass: 'pass',
  fail: 'FAIL',
  'expected-difference': 'accepted',
  'not-yet': 'not yet',
  'hardware-skip': 'hw-skip'
}

function resultsPath(phase: number, name: string, file: string): string {
  return sitePath(`results/${phase}/${name}/${file}`)
}

export function formatSequenceMetrics(seq: SequenceInfo): string {
  const parts = [
    `${seq.frameCount} frames`,
    `flicker A: mean ${seq.flickerA.mean.toFixed(2)}, max ${seq.flickerA.max.toFixed(2)}`,
    `flicker B: mean ${seq.flickerB.mean.toFixed(2)}, max ${seq.flickerB.max.toFixed(2)}`
  ]
  if (seq.ghostingA) {
    parts.push(
      `ghosting A: mean ${seq.ghostingA.mean.toFixed(2)}, p95 ${seq.ghostingA.p95.toFixed(2)}`
    )
  }
  if (seq.ghostingB) {
    parts.push(
      `ghosting B: mean ${seq.ghostingB.mean.toFixed(2)}, p95 ${seq.ghostingB.p95.toFixed(2)}`
    )
  }
  return parts.join(' · ')
}

function createThumb(phase: number, name: string, file: string): HTMLElement {
  const td = document.createElement('td')
  td.className = 'thumb-cell'
  const img = document.createElement('img')
  img.src = resultsPath(phase, name, file)
  img.alt = file
  img.loading = 'lazy'
  img.onerror = () => {
    img.style.display = 'none'
    td.textContent = '—'
    td.style.color = '#555'
    td.style.textAlign = 'center'
  }
  td.appendChild(img)
  return td
}

function createRow(
  row: GridRow,
  onClick: (row: GridRow, tab: string) => void
): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = `status-${row.status}`

  // Number
  const tdNum = document.createElement('td')
  tdNum.className = 'num-cell'
  tdNum.textContent = String(row.number)
  tr.appendChild(tdNum)

  // Name
  const tdName = document.createElement('td')
  tdName.className = 'name-cell'
  const nameLink = document.createElement('a')
  nameLink.href = `?case=${row.name}`
  nameLink.textContent = row.name
  if (row.variant) {
    const span = document.createElement('span')
    span.className = 'variant'
    span.textContent = ` (${row.variant})`
    nameLink.appendChild(span)
  }
  tdName.appendChild(nameLink)
  tr.appendChild(tdName)

  // Phase
  const tdPhase = document.createElement('td')
  tdPhase.className = 'phase-cell'
  tdPhase.textContent = `P${row.phase}`
  tr.appendChild(tdPhase)

  // Thumbnails (A, B, diff)
  if (row.hasImages) {
    const thumbA = createThumb(row.phase, row.name, 'A.png')
    thumbA.onclick = () => onClick(row, 'A')
    thumbA.style.cursor = 'pointer'
    tr.appendChild(thumbA)

    const thumbB = createThumb(row.phase, row.name, 'B.png')
    thumbB.onclick = () => onClick(row, 'B')
    thumbB.style.cursor = 'pointer'
    tr.appendChild(thumbB)

    const thumbDiff = createThumb(row.phase, row.name, 'diff.png')
    thumbDiff.onclick = () => onClick(row, 'diff')
    thumbDiff.style.cursor = 'pointer'
    tr.appendChild(thumbDiff)
  } else {
    for (let i = 0; i < 3; i++) {
      const td = document.createElement('td')
      td.className = 'thumb-cell empty'
      td.textContent = '—'
      tr.appendChild(td)
    }
  }

  // SSIM
  const tdSsim = document.createElement('td')
  tdSsim.className = 'metric-cell'
  tdSsim.textContent = row.metrics ? row.metrics.ssim.toFixed(4) : '—'
  tr.appendChild(tdSsim)

  // ΔE95
  const tdDe = document.createElement('td')
  tdDe.className = 'metric-cell'
  tdDe.textContent = row.metrics ? row.metrics.deP95.toFixed(2) : '—'
  tr.appendChild(tdDe)

  // GPU ms A
  const tdGpuA = document.createElement('td')
  tdGpuA.className = 'metric-cell'
  tdGpuA.textContent = row.gpuMs?.sideA
    ? row.gpuMs.sideA.medianMs.toFixed(1)
    : 'n/a'
  if (row.gpuMs?.sideAReason) tdGpuA.title = row.gpuMs.sideAReason
  tr.appendChild(tdGpuA)

  // GPU ms B
  const tdGpuB = document.createElement('td')
  tdGpuB.className = 'metric-cell'
  tdGpuB.textContent = row.gpuMs?.sideB
    ? row.gpuMs.sideB.medianMs.toFixed(1)
    : 'n/a'
  if (row.gpuMs?.sideBReason) tdGpuB.title = row.gpuMs.sideBReason
  tr.appendChild(tdGpuB)

  // Status
  const tdStatus = document.createElement('td')
  tdStatus.className = 'status-cell'
  const badge = document.createElement('span')
  badge.className = 'status-badge'
  badge.style.color = STATUS_COLORS[row.status] ?? '#666'
  badge.textContent = STATUS_LABELS[row.status] ?? row.status
  if (row.statusReason) {
    badge.title = row.statusReason
  }
  tdStatus.appendChild(badge)
  tr.appendChild(tdStatus)

  return tr
}

function createLightbox(): {
  el: HTMLElement
  show: (row: GridRow, tab: string) => void
  hide: () => void
} {
  const overlay = document.createElement('div')
  overlay.className = 'lightbox-overlay'
  overlay.style.display = 'none'

  const content = document.createElement('div')
  content.className = 'lightbox-content'

  const header = document.createElement('div')
  header.className = 'lightbox-header'

  const titleEl = document.createElement('span')
  titleEl.className = 'lightbox-title'

  const tabs = document.createElement('div')
  tabs.className = 'lightbox-tabs'

  const closeBtn = document.createElement('button')
  closeBtn.className = 'lightbox-close'
  closeBtn.textContent = '×'

  header.appendChild(titleEl)
  header.appendChild(tabs)
  header.appendChild(closeBtn)

  const imgContainer = document.createElement('div')
  imgContainer.className = 'lightbox-img-container'

  const img = document.createElement('img')
  imgContainer.appendChild(img)

  const liveLink = document.createElement('a')
  liveLink.className = 'lightbox-live-link'
  liveLink.textContent = 'Open live →'
  liveLink.target = '_blank'

  content.appendChild(header)
  content.appendChild(imgContainer)
  content.appendChild(liveLink)
  overlay.appendChild(content)

  let currentRow: GridRow | null = null
  let currentTab = 'A'
  let currentFrame = 0

  const scrubberContainer = document.createElement('div')
  scrubberContainer.className = 'scrubber-container'
  scrubberContainer.hidden = true

  const scrubberPair = document.createElement('div')
  scrubberPair.className = 'scrubber-pair'

  const scrubberImgA = document.createElement('img')
  scrubberImgA.className = 'scrubber-img'
  const scrubberImgB = document.createElement('img')
  scrubberImgB.className = 'scrubber-img'

  const scrubberLabelA = document.createElement('span')
  scrubberLabelA.className = 'scrubber-label'
  scrubberLabelA.textContent = 'A'
  const scrubberLabelB = document.createElement('span')
  scrubberLabelB.className = 'scrubber-label'
  scrubberLabelB.textContent = 'B'

  const wrapA = document.createElement('div')
  wrapA.className = 'scrubber-side'
  wrapA.appendChild(scrubberLabelA)
  wrapA.appendChild(scrubberImgA)

  const wrapB = document.createElement('div')
  wrapB.className = 'scrubber-side'
  wrapB.appendChild(scrubberLabelB)
  wrapB.appendChild(scrubberImgB)

  scrubberPair.appendChild(wrapA)
  scrubberPair.appendChild(wrapB)

  const scrubberControls = document.createElement('div')
  scrubberControls.className = 'scrubber-controls'

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.value = '0'
  slider.className = 'scrubber-slider'

  const frameLabel = document.createElement('span')
  frameLabel.className = 'scrubber-frame-label'

  const metricsLabel = document.createElement('div')
  metricsLabel.className = 'scrubber-metrics'

  scrubberControls.appendChild(slider)
  scrubberControls.appendChild(frameLabel)

  scrubberContainer.appendChild(scrubberPair)
  scrubberContainer.appendChild(scrubberControls)
  scrubberContainer.appendChild(metricsLabel)

  imgContainer.after(scrubberContainer)

  function updateScrubber(): void {
    if (!currentRow) return
    const fPad = String(currentFrame).padStart(3, '0')
    scrubberImgA.src = resultsPath(
      currentRow.phase,
      currentRow.name,
      `frames/f${fPad}_A.png`
    )
    scrubberImgB.src = resultsPath(
      currentRow.phase,
      currentRow.name,
      `frames/f${fPad}_B.png`
    )
    scrubberImgA.alt = `${currentRow.name} A frame ${currentFrame}`
    scrubberImgB.alt = `${currentRow.name} B frame ${currentFrame}`
    frameLabel.textContent = `Frame ${currentFrame} / ${slider.max}`
  }

  slider.addEventListener('input', () => {
    currentFrame = parseInt(slider.value, 10)
    updateScrubber()
  })

  function updateImg(): void {
    if (!currentRow) return

    const isFrames = currentTab === 'Frames'
    img.hidden = isFrames
    scrubberContainer.hidden = !isFrames

    if (isFrames) {
      updateScrubber()
    } else {
      const file = currentTab === 'diff' ? 'diff.png' : `${currentTab}.png`
      img.src = resultsPath(currentRow.phase, currentRow.name, file)
      img.alt = `${currentRow.name} ${currentTab}`
    }

    for (const btn of tabs.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset['tab'] === currentTab)
    }
  }

  function show(row: GridRow, tab: string): void {
    currentRow = row
    currentTab = tab
    currentFrame = 0
    titleEl.textContent = `#${row.number} ${row.name}`
    liveLink.href = `?case=${row.name}`

    const tabOrder = ['A', 'B', 'diff']
    if (row.sequence) tabOrder.push('Frames')

    tabs.innerHTML = ''
    for (const t of tabOrder) {
      const btn = document.createElement('button')
      btn.dataset['tab'] = t
      btn.textContent = t
      btn.onclick = () => {
        currentTab = t
        updateImg()
      }
      tabs.appendChild(btn)
    }

    if (row.sequence) {
      slider.max = String(row.sequence.frameCount - 1)
      slider.value = '0'
      metricsLabel.textContent = formatSequenceMetrics(row.sequence)
    }

    updateImg()
    overlay.style.display = 'flex'
  }

  function hide(): void {
    overlay.style.display = 'none'
    currentRow = null
  }

  closeBtn.onclick = hide
  overlay.onclick = e => {
    if (e.target === overlay) hide()
  }

  document.addEventListener('keydown', e => {
    if (overlay.style.display === 'none') return
    if (e.key === 'Escape') {
      hide()
      return
    }
    const tabOrder = ['A', 'B', 'diff']
    if (currentRow?.sequence) tabOrder.push('Frames')

    if (currentTab === 'Frames') {
      if (e.key === 'ArrowLeft') {
        if (currentFrame > 0) {
          currentFrame--
          slider.value = String(currentFrame)
          updateScrubber()
        }
        return
      } else if (e.key === 'ArrowRight') {
        const max = parseInt(slider.max, 10)
        if (currentFrame < max) {
          currentFrame++
          slider.value = String(currentFrame)
          updateScrubber()
        }
        return
      }
    }

    if (e.key === 'ArrowLeft') {
      const idx = tabOrder.indexOf(currentTab)
      if (idx > 0) {
        currentTab = tabOrder[idx - 1]!
        updateImg()
      }
    } else if (e.key === 'ArrowRight') {
      const idx = tabOrder.indexOf(currentTab)
      if (idx < tabOrder.length - 1) {
        currentTab = tabOrder[idx + 1]!
        updateImg()
      }
    }
  })

  return { el: overlay, show, hide }
}

export async function renderGridPage(container: HTMLElement): Promise<void> {
  container.innerHTML = ''

  // Add styles
  const style = document.createElement('style')
  style.textContent = GRID_STYLES
  container.appendChild(style)

  // Fetch data
  const res = await fetch(sitePath('api/grid-data.json'))
  const raw = (await res.json()) as {
    metrics: MetricsSchema[]
    currentPhase: number
  }

  const metricsMap = new Map<string, MetricsSchema>()
  for (const m of raw.metrics) {
    metricsMap.set(m.case, m)
  }

  const data = buildGridData(cases, metricsMap, raw.currentPhase)

  // Header
  const header = document.createElement('div')
  header.className = 'grid-header'
  header.innerHTML = `
    <h1>Parity Ladder</h1>
    <span class="grid-summary">
      ${countNumberedRows(data.rows)} cases · Phase ${data.currentPhase}
      · ${data.rows.filter(r => r.status === 'pass').length} pass
      · ${data.rows.filter(r => r.status === 'expected-difference').length} accepted
      · ${data.rows.filter(r => r.status === 'fail').length} fail
    </span>
  `
  container.appendChild(header)

  // Table
  const table = document.createElement('table')
  table.className = 'grid-table'

  const thead = document.createElement('thead')
  thead.innerHTML = `
    <tr>
      <th>#</th>
      <th>Case</th>
      <th>Ph</th>
      <th>A</th>
      <th>B</th>
      <th>Diff</th>
      <th>SSIM</th>
      <th>ΔE95</th>
      <th>GPU A</th>
      <th>GPU B</th>
      <th>Status</th>
    </tr>
  `
  table.appendChild(thead)

  const tbody = document.createElement('tbody')

  // Lightbox
  const lightbox = createLightbox()
  container.appendChild(lightbox.el)

  for (const row of data.rows) {
    tbody.appendChild(createRow(row, (r, tab) => lightbox.show(r, tab)))
  }

  table.appendChild(tbody)
  container.appendChild(table)
}

const GRID_STYLES = `
  .grid-header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    padding: 16px 20px 8px;
  }
  .grid-header h1 {
    font-size: 18px;
    color: #eee;
    font-weight: 600;
  }
  .grid-summary {
    font-size: 12px;
    color: #888;
  }
  .grid-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .grid-table th {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid #333;
    color: #999;
    font-weight: 500;
    position: sticky;
    top: 0;
    background: #111;
    z-index: 1;
  }
  .grid-table td {
    padding: 4px 8px;
    border-bottom: 1px solid #222;
    vertical-align: middle;
  }
  .grid-table tr:hover {
    background: #1a1a2a;
  }
  .num-cell {
    color: #666;
    width: 32px;
    text-align: right;
  }
  .name-cell a {
    color: #8cf;
    text-decoration: none;
  }
  .name-cell a:hover {
    text-decoration: underline;
  }
  .name-cell .variant {
    color: #666;
    font-size: 11px;
  }
  .phase-cell {
    color: #666;
    width: 32px;
  }
  .thumb-cell {
    width: 80px;
    height: 45px;
    padding: 2px 4px;
  }
  .thumb-cell img {
    width: 80px;
    height: 45px;
    object-fit: cover;
    border-radius: 2px;
    border: 1px solid #333;
  }
  .thumb-cell.empty {
    color: #444;
    text-align: center;
    line-height: 45px;
  }
  .metric-cell {
    color: #aaa;
    font-variant-numeric: tabular-nums;
    text-align: right;
    width: 64px;
  }
  .status-badge {
    font-weight: 600;
    font-size: 11px;
  }
  .status-badge[title] {
    cursor: help;
    text-decoration: underline dotted;
  }
  tr.status-fail {
    background: rgba(255, 68, 68, 0.05);
  }
  tr.status-not-yet td,
  tr.status-hardware-skip td {
    opacity: 0.5;
  }

  /* Lightbox */
  .lightbox-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .lightbox-content {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 8px;
    max-width: 90vw;
    max-height: 90vh;
    overflow: auto;
    min-width: 400px;
  }
  .lightbox-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid #333;
  }
  .lightbox-title {
    font-size: 14px;
    color: #eee;
    font-weight: 600;
    flex: 1;
  }
  .lightbox-tabs {
    display: flex;
    gap: 4px;
  }
  .lightbox-tabs button {
    background: #333;
    color: #ccc;
    border: 1px solid #555;
    padding: 2px 12px;
    font: 12px monospace;
    cursor: pointer;
    border-radius: 2px;
  }
  .lightbox-tabs button.active {
    background: #4a9eff;
    color: #fff;
    border-color: #4a9eff;
  }
  .lightbox-close {
    background: none;
    border: none;
    color: #888;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
  }
  .lightbox-close:hover {
    color: #fff;
  }
  .lightbox-img-container {
    display: flex;
    justify-content: center;
    padding: 8px;
  }
  .lightbox-img-container img {
    max-width: 100%;
    max-height: 70vh;
    border-radius: 4px;
  }
  .lightbox-live-link {
    display: block;
    padding: 8px 16px;
    color: #4a9eff;
    font-size: 12px;
    text-decoration: none;
    text-align: center;
    border-top: 1px solid #333;
  }
  .lightbox-live-link:hover {
    text-decoration: underline;
  }

  /* Sequence scrubber */
  .scrubber-container {
    padding: 8px 16px 12px;
  }
  .scrubber-pair {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .scrubber-side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }
  .scrubber-label {
    font-size: 11px;
    color: #888;
    font-weight: 600;
  }
  .scrubber-img {
    max-width: 100%;
    max-height: 50vh;
    border-radius: 4px;
    border: 1px solid #333;
  }
  .scrubber-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
  .scrubber-slider {
    flex: 1;
    accent-color: #4a9eff;
  }
  .scrubber-frame-label {
    font-size: 12px;
    color: #aaa;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    min-width: 100px;
  }
  .scrubber-metrics {
    font-size: 11px;
    color: #888;
    margin-top: 4px;
    text-align: center;
  }
`
