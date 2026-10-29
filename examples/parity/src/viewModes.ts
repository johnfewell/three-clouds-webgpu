import type { ViewMode } from './routing'

export interface ViewState {
  mode: ViewMode
  wipePosition: number
  onionOpacity: number
}

export function createViewState(): ViewState {
  return { mode: 'ab', wipePosition: 0.5, onionOpacity: 0.5 }
}

export function applyViewMode(
  sideA: HTMLElement,
  sideB: HTMLElement,
  canvasA: HTMLCanvasElement,
  canvasB: HTMLCanvasElement,
  state: ViewState
): void {
  sideA.style.display = ''
  sideB.style.display = ''
  sideA.style.position = ''
  sideB.style.position = ''
  sideA.style.inset = ''
  sideB.style.inset = ''
  sideB.style.clipPath = ''
  sideB.style.opacity = ''
  sideB.style.zIndex = ''
  canvasB.style.mixBlendMode = ''

  switch (state.mode) {
    case 'ab':
      sideA.style.flex = '1'
      sideB.style.flex = '1'
      break

    case 'wipe': {
      sideA.style.position = 'absolute'
      sideA.style.inset = '0'
      sideB.style.position = 'absolute'
      sideB.style.inset = '0'
      sideB.style.zIndex = '1'
      sideA.style.flex = ''
      sideB.style.flex = ''
      const pct = (state.wipePosition * 100).toFixed(1)
      sideB.style.clipPath = `inset(0 0 0 ${pct}%)`
      break
    }

    case 'onion':
      sideA.style.position = 'absolute'
      sideA.style.inset = '0'
      sideB.style.position = 'absolute'
      sideB.style.inset = '0'
      sideB.style.zIndex = '1'
      sideA.style.flex = ''
      sideB.style.flex = ''
      sideB.style.opacity = String(state.onionOpacity)
      break

    case 'diff':
      sideA.style.position = 'absolute'
      sideA.style.inset = '0'
      sideB.style.position = 'absolute'
      sideB.style.inset = '0'
      sideB.style.zIndex = '1'
      sideA.style.flex = ''
      sideB.style.flex = ''
      canvasB.style.mixBlendMode = 'difference'
      break
  }
}

export function updateUrl(
  caseName: string | null,
  mode: ViewMode,
  params: URLSearchParams
): void {
  if (caseName != null) params.set('case', caseName)
  if (mode !== 'ab') {
    params.set('view', mode)
  } else {
    params.delete('view')
  }
  const qs = params.toString()
  const url = qs ? `?${qs}` : window.location.pathname
  window.history.replaceState(null, '', url)
}
