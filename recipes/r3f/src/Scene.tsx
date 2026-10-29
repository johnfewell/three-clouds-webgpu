import { useFrame, useThree } from '@react-three/fiber'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react'
import { Color, Vector3 } from 'three'
import {
  createCloudsIntegration,
  type CloudsIntegration
} from 'three-clouds-webgpu'
import { Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { mrt, normalView, output, pass } from 'three/tsl'
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu'

import { AtmosphereContext, SkyNode } from '@takram/three-atmosphere/webgpu'

import { assetUrls } from './assets'

export interface Controls {
  paused: boolean
  seek: number
  enabled: boolean
}

interface SceneProps {
  renderer: WebGPURenderer
  controls: Controls
  report: (state: string, message: string) => void
  reportFrame: (frame: number) => void
}

interface Resources {
  atmosphere: AtmosphereContext
  scenePass: ReturnType<typeof pass>
}

const ANIMATION_SPEED = 1
const sunDirection = new Vector3(1, 1, 0.3).normalize()
const urls = assetUrls()

export function CloudScene(props: SceneProps) {
  const scene = useThree(state => state.scene)
  const camera = useThree(state => state.camera)
  const size = useThree(state => state.size)
  const [resources, setResources] = useState<Resources | null>(null)
  const renderFrame = useRef<((deltaSeconds: number) => void) | null>(null)
  const resetHistory = useRef<(() => void) | null>(null)
  useFrame((_, deltaSeconds) => {
    renderFrame.current?.(deltaSeconds)
  }, 1)

  useLayoutEffect(() => {
    const previousBackground = scene.background
    const background = new Color(0)
    scene.background = background
    const atmosphere = new AtmosphereContext()
    atmosphere.camera = camera
    atmosphere.raymarchScattering = false
    const scenePass = pass(scene, camera, { samples: 0 })
    scenePass.setMRT(mrt({ output, normal: normalView }))
    setResources({ atmosphere, scenePass })
    return () => {
      renderFrame.current = null
      resetHistory.current = null
      scenePass.dispose()
      atmosphere.dispose()
      if (scene.background === background) scene.background = previousBackground
    }
  }, [scene, camera])

  useEffect(() => {
    resetHistory.current?.()
  }, [size.width, size.height, props.controls.enabled])

  return (
    <>
      <mesh>
        <sphereGeometry args={[6378137, 64, 32]} />
        <meshBasicMaterial color='#667c74' />
      </mesh>
      {resources != null && (
        <Clouds
          enabled={props.controls.enabled}
          sceneDepth={resources.scenePass.getTextureNode('depth')}
          localWeatherTexture={urls.localWeather}
          turbulenceTexture={urls.turbulence}
          shapeTexture={urls.shape}
          shapeDetailTexture={urls.shapeDetail}
          sunDirection={sunDirection}
        >
          <Composite
            {...props}
            {...resources}
            renderFrame={renderFrame}
            resetHistory={resetHistory}
          />
        </Clouds>
      )}
    </>
  )
}

function Composite({
  renderer,
  controls,
  report,
  reportFrame,
  atmosphere,
  scenePass,
  renderFrame,
  resetHistory
}: SceneProps &
  Resources & {
    renderFrame: RefObject<((deltaSeconds: number) => void) | null>
    resetHistory: RefObject<(() => void) | null>
  }) {
  const { pass: cloudsPass, context, assets } = useClouds()
  const camera = useThree(state => state.camera)
  const clock = useRef({ timeSeconds: 0, frame: 0, seek: controls.seek })

  useLayoutEffect(() => {
    if (assets.status !== 'ready') {
      report(
        assets.status,
        assets.error?.message ?? 'Loading four cloud assets…'
      )
      return
    }
    let integration: CloudsIntegration | undefined
    let pipeline: RenderPipeline | undefined
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      renderFrame.current = null
      resetHistory.current = null
      pipeline?.dispose()
      integration?.dispose()
    }
    try {
      if (
        !('isPerspectiveCamera' in camera) ||
        camera.isPerspectiveCamera !== true
      )
        throw new Error(
          'Cloud composition requires a PerspectiveCamera. Orthographic cameras are not supported.'
        )
      integration = createCloudsIntegration({
        renderer,
        camera,
        atmosphere,
        scenePass,
        lighting: 'post',
        cloudsPass,
        textures: {
          localWeatherTexture: context.localWeatherTexture,
          shapeTexture: context.shapeTexture,
          shapeDetailTexture: context.shapeDetailTexture,
          turbulenceTexture: context.turbulenceTexture,
          stbnTexture: context.resolvedStbnTexture
        }
      })
      const sky = integration.aerial.skyNode
      if (!(sky instanceof SkyNode))
        throw new Error('Expected a daytime SkyNode')
      sky.showStars = false
      sky.showMoon = false
      console.table(integration.diagnostics().diagnostics)
      pipeline = new RenderPipeline(renderer)
      pipeline.outputNode = integration.output
      const active = integration
      const outputPipeline = pipeline
      resetHistory.current = () => active.resetHistory()
      renderFrame.current = deltaSeconds => {
        try {
          if (clock.current.seek !== controls.seek) {
            clock.current = { timeSeconds: 0, frame: 0, seek: controls.seek }
            active.resetHistory()
          }
          if (!controls.paused)
            clock.current.timeSeconds += deltaSeconds * ANIMATION_SPEED
          active.update({
            time: clock.current.timeSeconds,
            frame: clock.current.frame++
          })
          outputPipeline.render()
          reportFrame(clock.current.frame)
        } catch (error) {
          report(
            'error',
            error instanceof Error ? error.message : String(error)
          )
          dispose()
        }
      }
      report(
        'rendering',
        'Rendering clouds under StrictMode. Pause, seek, remount, or dispose.'
      )
    } catch (error) {
      dispose()
      report('error', error instanceof Error ? error.message : String(error))
    }
    return dispose
  }, [
    renderer,
    camera,
    atmosphere,
    scenePass,
    cloudsPass,
    context,
    assets.status,
    assets.error,
    controls,
    report,
    reportFrame,
    renderFrame,
    resetHistory
  ])
  return null
}
