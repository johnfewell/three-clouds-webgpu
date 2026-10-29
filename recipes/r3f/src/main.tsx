import {
  createRoot,
  events,
  extend,
  unmountComponentAtNode
} from '@react-three/fiber'
import { StrictMode } from 'react'
import {
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  SphereGeometry
} from 'three'
import { assertWebGPUSupported } from 'three-clouds-webgpu'
import { WebGPURenderer } from 'three/webgpu'

import { CloudScene, type Controls } from './Scene'

extend({ Mesh, MeshBasicMaterial, SphereGeometry })

const canvas = document.querySelector('canvas')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
const controller = new AbortController()
const renderer = new WebGPURenderer({ canvas, antialias: false })
const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 100, 1e8)
camera.position.set(0, 6378137 + 2500, 0)
camera.lookAt(6378137 * 0.35, 6378137 + 4000, 0)
camera.updateMatrixWorld()
const controls: Controls = { paused: false, seek: 0, enabled: true }
const cloudsToggle =
  document.querySelector<HTMLButtonElement>('#clouds-toggle')!
let root: ReturnType<typeof createRoot> | null = null
let stopped = false
let rendererReleased = false
let mount = 0

function report(state: string, message: string): void {
  status.dataset.state = state
  status.textContent = message
}

function reportFrame(frame: number): void {
  status.dataset.frames = String(frame)
}

function releaseRenderer(): void {
  if (rendererReleased) return
  rendererReleased = true
  void renderer.dispose()
}

function stop(): void {
  if (stopped) return
  stopped = true
  controller.abort()
  if (root != null) {
    unmountComponentAtNode(canvas, releaseRenderer)
  } else if (renderer.initialized) {
    releaseRenderer()
  }
  if (status.dataset.state !== 'error')
    report('stopped', 'Disposed; Fiber finishes root cleanup asynchronously')
}

function renderScene(): void {
  root!.render(
    <StrictMode>
      <CloudScene
        key={mount}
        renderer={renderer}
        controls={controls}
        report={report}
        reportFrame={reportFrame}
      />
    </StrictMode>
  )
}

async function start(): Promise<void> {
  await renderer.init()
  controller.signal.throwIfAborted()
  assertWebGPUSupported(renderer)
  renderer.toneMapping = NeutralToneMapping
  renderer.toneMappingExposure = 1
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  root = createRoot(canvas)
  await root.configure({
    gl: renderer,
    camera,
    shadows: { enabled: false, type: PCFShadowMap },
    events,
    dpr: Math.min(devicePixelRatio, 2),
    size: { width: innerWidth, height: innerHeight, top: 0, left: 0 },
    frameloop: 'always'
  })
  controller.signal.throwIfAborted()
  renderScene()
  cloudsToggle.disabled = false
  window.addEventListener(
    'resize',
    () => {
      camera.aspect = innerWidth / innerHeight
      camera.updateProjectionMatrix()
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
      renderer.setSize(innerWidth, innerHeight)
      void root!
        .configure({
          camera,
          shadows: { enabled: false, type: PCFShadowMap },
          dpr: Math.min(devicePixelRatio, 2),
          size: { width: innerWidth, height: innerHeight, top: 0, left: 0 }
        })
        .catch((error: unknown) => {
          report(
            'error',
            error instanceof Error ? error.message : String(error)
          )
          stop()
        })
    },
    { signal: controller.signal }
  )
}

cloudsToggle.addEventListener(
  'click',
  () => {
    controls.enabled = !controls.enabled
    cloudsToggle.setAttribute('aria-pressed', String(controls.enabled))
    cloudsToggle.textContent = controls.enabled ? 'Clouds: on' : 'Clouds: off'
    if (root != null && !stopped) renderScene()
  },
  { signal: controller.signal }
)
document.querySelector('#pause')!.addEventListener(
  'click',
  event => {
    controls.paused = !controls.paused
    ;(event.currentTarget as HTMLButtonElement).textContent = controls.paused
      ? 'Resume'
      : 'Pause'
  },
  { signal: controller.signal }
)
document.querySelector('#seek')!.addEventListener(
  'click',
  () => {
    controls.seek++
  },
  { signal: controller.signal }
)
document.querySelector('#remount')!.addEventListener(
  'click',
  () => {
    if (root == null || stopped) return
    mount++
    renderScene()
  },
  { signal: controller.signal }
)
document
  .querySelector('#stop')!
  .addEventListener('click', stop, { signal: controller.signal })
window.addEventListener('pagehide', stop, { signal: controller.signal })
import.meta.hot?.dispose(stop)
void start().catch((error: unknown) => {
  if (!stopped) {
    report('error', error instanceof Error ? error.message : String(error))
    stop()
  }
  if (root == null) releaseRenderer()
})
