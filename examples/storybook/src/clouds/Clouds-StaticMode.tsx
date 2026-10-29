import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import {
  useLayoutEffect,
  useMemo,
  useRef,
  type FC,
  type MutableRefObject
} from 'react'
import { AgXToneMapping } from 'three'
import { CloudsContext } from 'three-clouds-webgpu'
import { CloudLayer, Clouds, useClouds } from 'three-clouds-webgpu/r3f'
import { context, mrt, normalView, output, pass } from 'three/tsl'
import type { Renderer, Node as ThreeNode } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { highpVelocity } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../vendor/components/createStory'
import { Description } from '../vendor/components/Description'
import { WebGPUCanvas } from '../vendor/components/WebGPUCanvas'
import {
  localDateArgs,
  localDateArgTypes,
  useLocalDateControls,
  type LocalDateArgs
} from '../vendor/controls/localDateControls'
import {
  outputPassArgs,
  outputPassArgTypes,
  type OutputPassArgs
} from '../vendor/controls/outputPassControls'
import {
  rendererArgs,
  rendererArgTypes
} from '../vendor/controls/rendererControls'
import {
  toneMappingArgs,
  toneMappingArgTypes,
  type ToneMappingArgs
} from '../vendor/controls/toneMappingControls'
import { type PointOfViewProps } from '../vendor/hooks/usePointOfView'
import { useResource } from '../vendor/hooks/useResource'
import {
  cloudsArgs,
  cloudsArgTypes,
  useCloudsControls,
  type CloudsArgs
} from './controls/cloudsControls'
import {
  staticModeArgs,
  staticModeArgTypes,
  useStaticModeControls,
  type StaticModeArgs
} from './controls/staticModeControls'
import { createAtmosphereContext } from './helpers/atmosphereContext'
import { CloudsPostProcessing } from './helpers/CloudsPostProcessing'
import { FlyControls } from './helpers/FlyControls'
import {
  groundMRT,
  GroundTiles,
  useGround,
  useGroundCamera
} from './helpers/ground'
import { GroundOcean } from './helpers/oceanGround'
import {
  STATIC_MODE_STORY_TIME_SCALE,
  staticFrameSkipped
} from './helpers/staticModeStory'
import { useBakedCloudTextures } from './helpers/useBakedCloudTextures'
import { useJitterTexture } from './helpers/useJitterTexture'

const cumulusLayers = [
  {
    channel: 'r' as const,
    altitude: 1000,
    height: 1400,
    densityScale: 0.3,
    shapeAmount: 0.9,
    shadow: true
  },
  {
    channel: 'g' as const,
    altitude: 1800,
    height: 2200,
    densityScale: 0.35,
    shapeAmount: 0.95,
    shadow: true
  },
  {
    channel: 'b' as const,
    altitude: 4000,
    height: 3500,
    densityScale: 0.2,
    shapeAmount: 0.8
  },
  {
    channel: 'a' as const,
    altitude: 1200,
    height: 6000,
    densityScale: 0.4,
    shapeAmount: 1
  }
]

const referenceContext = /*#__PURE__*/ (() => {
  const ctx = new CloudsContext()
  ctx.coverage = 0.55
  ctx.experimental = { staticMode: true }
  return ctx
})()

interface StatusState {
  enabled: boolean
  motion: boolean
}

const StaticModeHUD: FC<{
  statusRef: MutableRefObject<StatusState>
}> = ({ statusRef }) => {
  const gl = useThree(({ gl }) => gl)
  const target = (gl.domElement.parentNode as HTMLElement | null) ?? null

  const hudContainer = useMemo(() => {
    const div = document.createElement('div')
    div.style.cssText = `
      position: absolute;
      top: 24px;
      right: 24px;
      background-color: rgba(15, 23, 42, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      padding: 16px 20px;
      color: #f8fafc;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.6;
      min-width: 290px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
      pointer-events: none;
      z-index: 10;
    `
    div.innerHTML = `
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #94a3b8; letter-spacing: 0.05em;">
        STATIC MODE GPU MONITOR
      </div>
      <div id="hud-badge" style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-weight: 700; font-size: 11px; margin-bottom: 12px; background-color: #10b981; color: #000;">
        IDLE (MARCH &amp; RESOLVE SKIPPED)
      </div>
      <div style="display: grid; grid-template-columns: 120px 1fr; gap: 4px;">
        <span style="color: #94a3b8;">Frame Time:</span>
        <span id="hud-frametime" style="color: #38bdf8; font-weight: 600;">0.0 ms</span>
        <span style="color: #94a3b8;">Frame Rate:</span>
        <span id="hud-fps" style="color: #38bdf8; font-weight: 600;">0 FPS</span>
        <span style="color: #94a3b8;">Cloud Motion:</span>
        <span id="hud-motion" style="color: #f1f5f9;">Paused (Still)</span>
        <span style="color: #94a3b8;">Static Mode:</span>
        <span id="hud-staticmode" style="color: #f1f5f9;">Enabled</span>
      </div>
      <div style="margin-top: 10px; font-size: 11px; color: #64748b; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 8px;">
        Skips raymarch, shadow and resolve passes when scene inputs are still.
      </div>
    `
    return div
  }, [])

  useLayoutEffect(() => {
    if (target != null) {
      target.appendChild(hudContainer)
    }
    return () => {
      hudContainer.remove()
    }
  }, [target, hudContainer])

  const lastTimeRef = useRef(performance.now())
  const samplesRef = useRef<number[]>([])
  const frameCountRef = useRef(0)
  const { pass: cloudsPass } = useClouds()
  const lastRenderedFrames = useRef(0)

  useFrame(() => {
    const now = performance.now()
    const delta = now - lastTimeRef.current
    lastTimeRef.current = now

    if (delta > 0 && delta < 500) {
      samplesRef.current.push(delta)
      if (samplesRef.current.length > 30) samplesRef.current.shift()
    }

    // What the pass did, not a guess from the camera: it only skips once
    // every input matches and the temporal histories have converged
    const { enabled, motion } = statusRef.current
    const renderedFrames = cloudsPass.staticTracker.renderedFrames
    const isSkipping = staticFrameSkipped(
      lastRenderedFrames.current,
      renderedFrames,
      enabled
    )
    lastRenderedFrames.current = renderedFrames

    frameCountRef.current++
    if (frameCountRef.current % 8 === 0) {
      const avg =
        samplesRef.current.reduce((a, b) => a + b, 0) /
        (samplesRef.current.length || 1)
      const frameTimeEl = hudContainer.querySelector('#hud-frametime')
      const fpsEl = hudContainer.querySelector('#hud-fps')
      const badgeEl = hudContainer.querySelector<HTMLElement>('#hud-badge')
      const motionEl = hudContainer.querySelector('#hud-motion')
      const staticModeEl = hudContainer.querySelector('#hud-staticmode')

      if (frameTimeEl) frameTimeEl.textContent = `${avg.toFixed(1)} ms`
      if (fpsEl) fpsEl.textContent = `${(1000 / avg).toFixed(0)} FPS`
      if (badgeEl) {
        if (isSkipping) {
          badgeEl.textContent = 'IDLE (MARCH & RESOLVE SKIPPED)'
          badgeEl.style.backgroundColor = '#10b981'
          badgeEl.style.color = '#000'
        } else {
          badgeEl.textContent = 'ACTIVE (MARCH & RESOLVE RUNNING)'
          badgeEl.style.backgroundColor = '#f59e0b'
          badgeEl.style.color = '#000'
        }
      }
      if (motionEl) {
        motionEl.textContent = motion ? 'Simulating Drift' : 'Paused (Still)'
      }
      if (staticModeEl) {
        staticModeEl.textContent = enabled ? 'Enabled' : 'Disabled'
      }
    }
  })

  return null
}

const Content: FC<StoryProps> = storyPov => {
  // The ground global swaps the story's pose for a tiled location's
  const ground = useGround(storyPov)
  const { longitude } = ground.pov
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)

  const statusRef = useRef<StatusState>({
    enabled: true,
    motion: false
  })

  const atmosphereContext = useResource(() => createAtmosphereContext(), [])
  atmosphereContext.camera = camera

  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  const scenePass = useResource(
    () =>
      pass(scene, camera, { samples: 0 }).setMRT(
        mrt({
          output,
          normal: normalView,
          velocity: highpVelocity as unknown as ThreeNode,
          ...groundMRT(ground.ocean)
        })
      ),
    [scene, camera, ground.ocean]
  )

  const jitterTexture = useJitterTexture()
  const textures = useBakedCloudTextures()

  // Pose and world frame: ECEF, or rebased to the location for the ocean
  const target = useGroundCamera(
    ground,
    atmosphereContext.matrixWorldToECEF.value
  )

  useLocalDateControls(longitude, date => {
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } =
      atmosphereContext
    getECIToECEFRotationMatrix(date, matrixECIToECEF.value)
    getSunDirectionECI(date, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(date, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  })

  const StaticControls: FC = () => {
    const { context: cloudsContext } = useClouds()
    useCloudsControls(cloudsContext, { shadowMaxFar: 1e5 })
    useStaticModeControls(cloudsContext, nextState => {
      statusRef.current = nextState
    })
    return null
  }

  if (textures == null || jitterTexture == null) return null

  return (
    <>
      <GroundTiles ground={ground} />
      <OrbitControls makeDefault target={target} minDistance={100} />
      <FlyControls
        key={ground.value}
        worldToECEF={atmosphereContext.matrixWorldToECEF.value}
      />
      <Clouds
        sceneDepth={scenePass.getTextureNode('depth')}
        localWeatherTexture={textures.localWeatherTexture}
        shapeTexture={textures.shapeTexture}
        shapeDetailTexture={textures.shapeDetailTexture}
        turbulenceTexture={textures.turbulenceTexture}
        stbnTexture={jitterTexture}
      >
        {cumulusLayers.map(layer => (
          <CloudLayer key={layer.channel} {...layer} />
        ))}
        <StaticControls />
        {ground.ocean && <GroundOcean />}
        <CloudsPostProcessing
          albedoScale={ground.albedoScale}
          lightingMask={ground.ocean}
          scenePass={scenePass}
          atmosphereContext={atmosphereContext}
          timeScale={STATIC_MODE_STORY_TIME_SCALE}
        />
        <StaticModeHUD statusRef={statusRef} />
      </Clouds>
    </>
  )
}

interface StoryProps extends PointOfViewProps {}

interface StoryArgs
  extends
    CloudsArgs,
    LocalDateArgs,
    ToneMappingArgs,
    OutputPassArgs,
    StaticModeArgs {}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas camera={{ near: 1, far: 4e5 }}>
    <Content {...props} />
    <Description>
      <p>
        <strong>Static mode</strong> (<em>experimental.staticMode</em>): GPU
        idles when nothing changes.
      </p>
      <p>
        Skips the raymarch, shadow pass, and resolve pass when camera pose, sun,
        time, and knobs are unchanged and history has converged. Output
        re-renders seamlessly whenever the camera moves or inputs change.
      </p>
    </Description>
  </WebGPUCanvas>
)

Story.args = {
  ...cloudsArgs(referenceContext),
  ...localDateArgs({
    dayOfYear: 0,
    timeOfDay: 15
  }),
  ...toneMappingArgs({
    toneMappingMode: AgXToneMapping,
    toneMappingExposure: 10
  }),
  ...outputPassArgs(),
  ...rendererArgs(),
  ...staticModeArgs()
}

Story.argTypes = {
  ...cloudsArgTypes(),
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...outputPassArgTypes({ hasNormal: true, hasVelocity: true }),
  ...rendererArgTypes(),
  ...staticModeArgTypes()
}
