// clouds/Clouds/Fallback, Lab only: the WebGL fallback recipe's decision
// (recipes/webgl-fallback) in Storybook. navigator.gpu plus a granted adapter
// mounts the WebGPU Basic story, anything else the WebGL reference's Basic
// story, at the same pose. The backend arg forces a branch, which the
// hardware proof uses

import { useEffect, useState } from 'react'

import { Basic as WebGLBasic } from '../clouds-webgl/Clouds-Basic'
import type { StoryFC } from '../vendor/components/createStory'
import { useControl } from '../vendor/hooks/useControl'
import type { PointOfViewProps } from '../vendor/hooks/usePointOfView'
import { Story as WebGPUBasic } from './Clouds-Basic'

type Backend = 'webgpu' | 'webgl'
type Choice = 'auto' | Backend
type BasicArgs = NonNullable<typeof WebGPUBasic.args>
interface FallbackArgs extends BasicArgs {
  backend: Choice
}

// The recipe's detect.ts: decided once, before any renderer, never revisited
async function detectBackend(): Promise<Backend> {
  const gpu = (
    navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } }
  ).gpu
  if (gpu?.requestAdapter == null) return 'webgl'
  try {
    return (await gpu.requestAdapter()) == null ? 'webgl' : 'webgpu'
  } catch {
    return 'webgl'
  }
}

const badgeStyle = {
  position: 'absolute',
  top: 8,
  left: 8,
  zIndex: 10,
  padding: '6px 10px',
  background: 'rgba(0, 0, 0, 0.6)',
  color: '#fff',
  font: '13px/1.4 system-ui, sans-serif',
  borderRadius: 4,
  pointerEvents: 'none'
} as const

const labels: Record<Backend | 'pending', string> = {
  pending: 'Backend: deciding',
  webgpu: 'Backend: WebGPU (three-clouds-webgpu)',
  webgl: 'Backend: WebGL (@takram/three-clouds, the original)'
}

export const Story: StoryFC<PointOfViewProps, FallbackArgs> = props => {
  const backend = useControl(({ backend }: FallbackArgs) => backend)
  const [chosen, setChosen] = useState<Backend | 'pending'>('pending')

  useEffect(() => {
    let live = true
    setChosen('pending')
    if (backend !== 'auto') {
      setChosen(backend)
      return
    }
    void detectBackend().then(picked => {
      if (live) setChosen(picked)
    })
    return () => {
      live = false
    }
  }, [backend])

  return (
    <>
      {chosen === 'webgpu' && <WebGPUBasic {...props} />}
      {chosen === 'webgl' && <WebGLBasic />}
      <div data-backend={chosen} style={badgeStyle}>
        {labels[chosen]}
      </div>
    </>
  )
}

Story.args = {
  ...WebGPUBasic.args,
  backend: 'auto'
}

Story.argTypes = {
  ...WebGPUBasic.argTypes,
  backend: {
    control: 'select',
    options: ['auto', 'webgpu', 'webgl'],
    description:
      'auto decides from navigator.gpu and an adapter, the others force a branch'
  }
}
