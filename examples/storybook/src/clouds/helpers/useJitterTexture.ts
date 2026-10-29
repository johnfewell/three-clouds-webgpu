// The jitter volume behind the `jitter` arg: the library's blue-noise default,
// NVIDIA's STBN from the upstream URL the WebGL stories sample (ADR-009
// Amendment 1, for a noise-matched A/B) or the old white-noise hash. STBN is
// awaited like the baked textures: a placeholder in flight renders frames
// that are not the ones that converge
import { useEffect, useMemo, useState } from 'react'
import type { Data3DTexture } from 'three'
import {
  createHashJitterTexture,
  createJitterTexture
} from 'three-clouds-webgpu'

import { DEFAULT_STBN_URL, STBNLoader } from '@takram/three-geospatial'

import { useControl } from '../../vendor/hooks/useControl'

export type JitterKind = 'blue' | 'stbn' | 'hash'

let stbnPromise: Promise<Data3DTexture> | null = null
function loadSTBN(): Promise<Data3DTexture> {
  stbnPromise ??= new STBNLoader().loadAsync(DEFAULT_STBN_URL)
  return stbnPromise
}

export function useJitterTexture(): Data3DTexture | null {
  const kind = useControl(
    ({ jitter }: { jitter?: JitterKind }) => jitter ?? 'blue'
  )
  const blue = useMemo(() => createJitterTexture(), [])
  const hash = useMemo(() => createHashJitterTexture(), [])
  const [stbn, setStbn] = useState<Data3DTexture | null>(null)
  useEffect(() => {
    if (kind !== 'stbn' || stbn != null) return
    let live = true
    void loadSTBN().then(texture => {
      if (live) setStbn(texture)
    })
    return () => {
      live = false
    }
  }, [kind, stbn])
  return kind === 'blue' ? blue : kind === 'hash' ? hash : stbn
}
