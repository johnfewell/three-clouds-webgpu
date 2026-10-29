import { detectBackend } from './detect'
import type { Clock, CloudsHandle } from './handle'
import { startWebGL } from './webgl'
import { startWebGPU } from './webgpu'

const canvas = document.querySelector('canvas')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
const badge = document.querySelector<HTMLParagraphElement>('#backend')!
const controller = new AbortController()
let stopped = false
let active: CloudsHandle | null = null

function report(state: string, message: string): void {
  status.dataset.state = state
  status.textContent = message
}

function stop(): void {
  if (stopped) return
  stopped = true
  controller.abort()
  active?.dispose()
  active = null
  if (status.dataset.state !== 'error') report('stopped', 'Disposed')
}

async function start(): Promise<CloudsHandle> {
  // One decision, before any renderer exists, then one branch only
  const backend = await detectBackend()
  badge.dataset.backend = backend
  badge.textContent =
    backend === 'webgpu'
      ? 'Backend: WebGPU (three-clouds-webgpu)'
      : 'Backend: WebGL (@takram/three-clouds, the original)'
  report('loading', `Starting the ${backend} branch…`)
  const clock: Clock = { timeSeconds: 0, frame: 0, paused: false }
  const options = { canvas, signal: controller.signal, clock, report }
  const handle =
    backend === 'webgpu'
      ? await startWebGPU(options)
      : await startWebGL(options)
  controller.signal.throwIfAborted()

  // The same settings object reaches either branch
  handle.update({ coverage: 0.35, localWeatherVelocity: { x: 0.001, y: 0 } })

  const cloudsToggle =
    document.querySelector<HTMLButtonElement>('#clouds-toggle')!
  let enabled = true
  cloudsToggle.addEventListener(
    'click',
    () => {
      enabled = !enabled
      handle.setEnabled(enabled)
      cloudsToggle.setAttribute('aria-pressed', String(enabled))
      cloudsToggle.textContent = enabled ? 'Clouds: on' : 'Clouds: off'
    },
    { signal: controller.signal }
  )
  cloudsToggle.disabled = false
  const pause = document.querySelector<HTMLButtonElement>('#pause')!
  pause.addEventListener(
    'click',
    () => {
      handle.setPaused(!clock.paused)
      pause.textContent = clock.paused ? 'Resume' : 'Pause'
    },
    { signal: controller.signal }
  )
  document.querySelector('#seek')!.addEventListener(
    'click',
    () => {
      handle.seek(0)
    },
    { signal: controller.signal }
  )
  window.addEventListener('resize', () => handle.resize(), {
    signal: controller.signal
  })
  const frames = setInterval(() => {
    status.dataset.frames = String(clock.frame)
  }, 250)
  controller.signal.addEventListener('abort', () => clearInterval(frames))
  report(
    'rendering',
    `Rendering clouds on ${backend}. Time is in seconds; pause keeps temporal samples advancing.`
  )
  return handle
}

document.querySelector('#stop')!.addEventListener('click', stop, {
  signal: controller.signal
})
window.addEventListener('pagehide', stop, { signal: controller.signal })
import.meta.hot?.dispose(stop)
void start().then(
  handle => {
    active = handle
    if (stopped) handle.dispose()
  },
  (error: unknown) => {
    if (!stopped) {
      report('error', error instanceof Error ? error.message : String(error))
      stop()
    }
  }
)
