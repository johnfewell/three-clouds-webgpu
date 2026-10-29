// Everything downstream of the clouds march for every story on the port:
// ADR-001's graph wired as examples/basic and parity side B wire it (plus the
// adaptive PCF radius and STBN jitter), then upstream's WebGPU tail: lens
// flare, tone mapping (plain AgX as the WebGL stories), TAA, dither
// Render it INSIDE <Clouds>, which owns state only (src/r3f/Clouds.tsx)

import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, type FC } from 'react'
import {
  AgXToneMapping,
  ColorManagement,
  Matrix4,
  Vector2,
  Vector3,
  type Scene
} from 'three'
import {
  aerialPerspectiveWithCloudShadow,
  createCloudShadowTransmittance,
  createGetShadowRadius,
  DEFAULT_SHADOW_RADIUS,
  getSTBN,
  type GroundShadowExtraDeps
} from 'three-clouds-webgpu'
import { useClouds } from 'three-clouds-webgpu/r3f'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import {
  context,
  directionToColor,
  float,
  Fn,
  renderOutput,
  texture3D,
  toneMapping,
  uniform,
  uv,
  vec4
} from 'three/tsl'
import {
  RenderPipeline,
  type Node,
  type PassNode,
  type Renderer,
  type TextureNode
} from 'three/webgpu'

import type {
  AtmosphereContext,
  SkyNode
} from '@takram/three-atmosphere/webgpu'
import {
  depthToColor,
  depthToViewZ,
  dithering,
  inverseProjectionMatrix,
  inverseViewMatrix,
  lensFlare,
  projectionMatrix,
  screenToPositionView,
  temporalAntialias
} from '@takram/three-geospatial/webgpu'

import type { OutputPassArgs } from '../../vendor/controls/outputPassControls'
import { useToneMappingControls } from '../../vendor/controls/toneMappingControls'
import { useControl } from '../../vendor/hooks/useControl'
import { useGuardedFrame } from '../../vendor/hooks/useGuardedFrame'
import { useResource } from '../../vendor/hooks/useResource'
import { useTransientControl } from '../../vendor/hooks/useTransientControl'
import type { CloudsArgs } from '../controls/cloudsControls'
import { matchWebGLLensFlare } from './lensFlare'

// The @takram types are built against @types/three 0.182, this repository's
// against 0.185 (generic Node). Parity side B crosses the same seam with the
// same casts. Runtime values are TSL nodes either way.
interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

export interface CloudsPostProcessingProps {
  // The scene pass with an MRT of { output, normal, velocity } and a depth
  scenePass: PassNode
  atmosphereContext: AtmosphereContext
  // Upstream's WebGPU stories end in TAA, the WebGL clouds stories in SMAA
  // The clouds resolve is already temporal (ADR-008) and a second filter
  // softens the distant decks, so it is off unless `storyTaa` is set
  temporalAntialias?: boolean
  // Wall-clock rate of `time` (ADR-003: the library takes no clock). 1 is the
  // reference's `offset += velocity * deltaTime`; 0 freezes the weather
  timeScale?: number
  // Post-lit scenes hand the aerial node unlit albedo, scaled first as
  // upstream does: the WebGL 3D Tiles story uses `albedoScale={2 / Math.PI}`
  // (Lambertian 1/π plus the reference's fudge), upstream's WebGPU one 2/3
  albedoScale?: number
  // Rendered over the composite with the renderer's own pass, as upstream's
  // tile stories draw the GlobeControls pivot
  overlayScene?: Scene | null
  // Read the scene pass's `lit` MRT channel as the aerial node's lighting
  // mask: 0 keeps a self-lit surface's own shading (the ocean ground)
  lightingMask?: boolean
  // ADR-007's two shadow consumers. 'post': the aerial node lights unlit albedo
  // and shadows its direct term (3.2a). 'lights': the registered light node
  // shadows the AtmosphereLight via `shadowConsumer` (3.2b). Never both.
  lighting?: 'post' | 'lights'
  shadowConsumer?: { current: CloudShadowConsumer | null }
  // Stars, the moon disc and lunar scattering, on the sky the aerial node
  // paints over the far plane. Off is the stock sky, so every other story is
  // untouched (docs/night-sky.md)
  nightSky?: boolean
  // The moon disc's own intensity, on the same artistic scale as
  // cloudsContext.moonGain. At 1 the disc is the physical 2.5e-6 of the sun's
  // radiance, so clouds lit at a gain of 4e5 are lit by a moon you cannot see
  moonIntensity?: number
}

// What a cloud-shadowed light node needs from the clouds pass: the ground
// shadow transmittance, the adaptive PCF radius and the STBN jitter (side B's
// ParityShadowedLightNode wiring, examples/parity/src/sideB.ts)
export interface CloudShadowConsumer {
  transmittance: (
    position: Node<'vec3'>,
    radius: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'float'>
  shadowRadius: (worldPosition: Node<'vec3'>) => Node<'float'>
  stbn: Node<'float'>
}

export const CloudsPostProcessing: FC<CloudsPostProcessingProps> = ({
  scenePass,
  atmosphereContext,
  temporalAntialias: taaProp = false,
  timeScale = 1,
  albedoScale,
  overlayScene = null,
  lightingMask = false,
  lighting = 'post',
  shadowConsumer,
  nightSky = false,
  moonIntensity = 1
}) => {
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const camera = useThree(({ camera }) => camera)
  const { pass: cloudsPass, context: cloudsContext } = useClouds()

  // The story-level TAA toggle (the `storyTaa` arg, see cloudsControls): the
  // prop is the story's default, the arg overrides it at runtime so the
  // temporal antialias over the composite can be taken out of an A/B
  const taaArg = useControl(({ storyTaa }: { storyTaa?: boolean }) => storyTaa)
  const taa = taaArg ?? taaProp
  // The same shape for the two tail filters the WebGL chain has and this one
  // defaults off, so an A/B can turn each on without a prop per story
  const storySmaa = useControl(
    ({ storySmaa }: { storySmaa?: boolean }) => storySmaa ?? false
  )
  const storyDithering = useControl(
    ({ storyDithering }: { storyDithering?: boolean }) => storyDithering ?? true
  )

  // Both contexts on the renderer, before anything builds. Lazy getters, so
  // this can run in an effect after the scene's backgroundNode was assigned:
  // graphs build on the first render, not at assignment
  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext,
      getClouds: () => cloudsContext
    })
  }, [renderer, atmosphereContext, cloudsContext])

  // The ground-shadow consumer's uniforms mirror the march's own (they cannot
  // be shared: the march's are private to the pass). Synced every frame below.
  const u = useMemo(
    () => ({
      viewMatrix: uniform(new Matrix4()),
      cameraNear: uniform(camera.near),
      sunDirection: uniform(new Vector3()),
      ecefToWorldMatrix: uniform(new Matrix4()),
      worldToECEFMatrix: uniform(new Matrix4()),
      altitudeCorrection: uniform(new Vector3()),
      worldToUnit: uniform(1 / cloudsContext.bottomRadius),
      temporalJitter: uniform(new Vector2()),
      resolution: uniform(new Vector2().copy(cloudsContext.shadow.mapSize)),
      // getShadowRadius measures a shadow texel's footprint in SCREEN pixels,
      // so it needs the render size, a different quantity from the shadow map
      // size above
      screenResolution: uniform(new Vector2()),
      shadowFrame: uniform(0),
      // The jitter volume as a node, .value re-synced every frame: a swap
      // (the `jitter` knob) reaches this consumer without a rebuild
      stbn: texture3D(cloudsContext.stbnTexture)
    }),
    [camera, cloudsContext]
  )

  const sceneColorNode = scenePass.getTextureNode('output')
  const colorNode = useMemo(
    () =>
      albedoScale != null ? sceneColorNode.mul(albedoScale) : sceneColorNode,
    [sceneColorNode, albedoScale]
  )
  const depthNode = scenePass.getTextureNode('depth')
  const normalNode = scenePass.getTextureNode('normal')
  const velocityNode = scenePass.getTextureNode('velocity')
  // Explicit LOD: the aerial node reads the mask inside its surface branch,
  // where an implicit-LOD sample has undefined derivatives
  const lightingMaskNode = useMemo(
    () =>
      lightingMask ? scenePass.getTextureNode('lit').level(float(0)).r : null,
    [scenePass, lightingMask]
  )

  const aerialNode = useResource(() => {
    const deps: GroundShadowExtraDeps = {
      viewMatrix: u.viewMatrix,
      cameraNear: u.cameraNear,
      sunDirection: u.sunDirection,
      bottomRadius: float(cloudsContext.bottomRadius),
      ecefToWorldMatrix: u.ecefToWorldMatrix,
      altitudeCorrection: u.altitudeCorrection,
      worldToUnit: u.worldToUnit,
      temporalJitter: u.temporalJitter,
      resolution: u.resolution
    }
    const transmittance = createCloudShadowTransmittance(
      cloudsPass.cloudShadow,
      deps,
      { enabled: true }
    )
    // The reference's aerial/light shadow consumer computes a per-pixel
    // adaptive PCF radius and an STBN jitter (@takram/three-atmosphere
    // shared.js:445-446); zero for both point-samples every shadow
    const shadowRadius = createGetShadowRadius({
      shadowMatrices: cloudsPass.cloudShadow.matrices,
      inverseShadowMatrices: cloudsPass.cloudShadow.inverseMatrices,
      shadowMapSize: u.resolution,
      projectionMatrix: projectionMatrix(camera) as unknown as Node<'mat4'>,
      viewMatrix: u.viewMatrix,
      resolution: u.screenResolution,
      shadowRadius: float(DEFAULT_SHADOW_RADIUS)
    })
    // Through a TextureNode kept in sync each frame (below), so the `jitter`
    // knob reaches this consumer too, not only the pass
    const stbn = getSTBN(u.stbn, u.shadowFrame)

    if (shadowConsumer != null) {
      shadowConsumer.current = { transmittance, shadowRadius, stbn }
    }

    // Reconstruct the receiver from the scene depth, in ECEF, altitude
    // corrected: the same reconstruction the aerial node makes for its own
    // in-scatter (uv() as-is, ADR-013 Amendment 5)
    const aerialShadowNode = Fn(() => {
      const d = depthNode.r.toConst()
      const viewZ = depthToViewZ(d, camera) as unknown as Node<'float'>
      const posView = screenToPositionView(
        uv(),
        d,
        viewZ,
        projectionMatrix(camera),
        inverseProjectionMatrix(camera)
      ) as unknown as Node<'vec3'>
      const posWorld = (
        inverseViewMatrix(camera) as unknown as Mat4NodeLike
      ).mul(vec4(posView, 1)).xyz
      const posECEF = u.worldToECEFMatrix.mul(vec4(posWorld, 1)).xyz
      const corrected = posECEF.add(u.altitudeCorrection)
      return transmittance(corrected, shadowRadius(posWorld), stbn)
    })()

    // Both modes take the live shadow-length node (light shafts). Only 'post'
    // applies the surface-shadow multiplier here, 'lights' applies it through
    // the light node (side B, ADR-007)
    const aerial = aerialPerspectiveWithCloudShadow(
      colorNode,
      depthNode,
      cloudsPass.cloudShadowLength,
      lighting === 'post' ? aerialShadowNode : null,
      normalNode,
      lightingMaskNode
    )
    aerial.normalNode = normalNode
    aerial.lighting = lighting === 'post'
    // The sky is the aerial node's own, and it is what the clouds composite
    // over, so a star is occluded by any cloud the march covered
    if (nightSky) {
      const sky = aerial.skyNode as SkyNode | null
      if (sky != null) {
        sky.showStars = true
        sky.showMoon = true
        sky.moonScattering = true
        sky.moonNode.intensity.value = moonIntensity
      }
      aerial.moonScattering = true
    }
    return aerial
  }, [
    cloudsPass,
    cloudsContext,
    camera,
    colorNode,
    depthNode,
    normalNode,
    lightingMaskNode,
    u,
    lighting,
    shadowConsumer,
    nightSky,
    moonIntensity
  ])

  // NOTE: the port's aerial node
  // returns the background sky on far-plane pixels, not its own shaft-aware
  // sky, so light shafts do not reach the sky rays on the port until that lands

  // Clouds over the aerial result, then upstream's tail
  const compositeNode = useResource(
    () => cloudsPass.composite(aerialNode),
    [cloudsPass, aerialNode]
  )

  const lensFlareNode = useResource(
    () =>
      matchWebGLLensFlare(
        lensFlare(compositeNode as unknown as Parameters<typeof lensFlare>[0])
      ),
    [compositeNode]
  )

  const toneMappingNode = useResource(
    () =>
      // The initial operator only: useToneMappingControls below applies the
      // story's toneMappingMode arg on the first render. Plain AgX, as the
      // WebGL stories default to
      toneMapping(
        AgXToneMapping,
        uniform(0),
        lensFlareNode as unknown as Node<'vec4'>
      ),
    [lensFlareNode]
  )

  const taaNode = useResource(
    () => temporalAntialias(toneMappingNode, depthNode, velocityNode, camera),
    [camera, depthNode, velocityNode, toneMappingNode]
  )

  // SMAA, where the WebGL chain has it: after the temporal tail and tone
  // mapping, before renderOutput's output transform. It is spatial, so TAA's
  // -25% deck softening does not carry over: SMAA measures -2% edge energy
  const smaaNode = useResource(
    () => smaa((taa ? taaNode : toneMappingNode) as unknown as TextureNode),
    [taa, taaNode, toneMappingNode]
  )

  // Dither in DISPLAY space: ±0.5/255 added before the pipeline's linear→sRGB
  // transform gets amplified in the darks (6.4/255 vs the reference's 0.95/255
  // on Basic, 2026-09-03). So renderOutput() runs here, the dither on top
  const finalNode = useResource(() => {
    const output = renderOutput(
      (storySmaa
        ? smaaNode
        : taa
          ? taaNode
          : toneMappingNode) as unknown as Node<'vec4'>
    ) as unknown as Node<'vec4'>
    return storyDithering
      ? output.add(dithering as unknown as Node<'vec3'>)
      : output
  }, [storyDithering, storySmaa, smaaNode, taa, taaNode, toneMappingNode])

  const renderPipeline = useResource(
    () => new RenderPipeline(renderer, finalNode),
    [renderer, finalNode]
  )

  // What reaches the screen, decided in ONE place: the output-pass views and
  // the clouds debug views. A debug view is data, not radiance (the WebGL panel
  // drops tone mapping for it too), so the composite goes straight out
  useTransientControl(
    ({
      outputDepth,
      outputNormal,
      outputVelocity,
      debug
    }: OutputPassArgs & CloudsArgs) => ({
      outputDepth,
      outputNormal,
      outputVelocity,
      // A story without the clouds panel (Minimal Setup) has no `debug` arg
      debug: debug != null && debug !== 'none'
    }),
    ({ outputDepth, outputNormal, outputVelocity, debug }) => {
      // Node<'vec4'> is the pipeline's type. The two conversions carry no
      // vec4 in the @types/three seam this file already notes
      let outputNode: Node = finalNode
      // finalNode is already display-encoded (see its definition)
      let outputColorTransform = false
      // In reverse order, as upstream:
      if (outputNormal) {
        outputNode = directionToColor(normalNode.xyz)
        outputColorTransform = false
      } else if (outputDepth) {
        outputNode = depthToColor(depthNode, scenePass.camera)
        outputColorTransform = false
      } else if (outputVelocity) {
        outputNode = vec4(velocityNode.xyz.mul(20).add(0.5), 1)
        outputColorTransform = true
      } else if (debug) {
        outputNode = compositeNode
        outputColorTransform = false
      }
      renderPipeline.outputNode = outputNode
      renderPipeline.outputColorTransform = outputColorTransform
      renderPipeline.needsUpdate = true
    }
  )

  // Priority 1 takes over the frame loop from r3f (which would otherwise
  // render the scene bare and bypass the composite entirely)
  useGuardedFrame((_, delta) => {
    // time/frame are plain numbers owned by the app (ADR-003). `frame` must
    // advance every render: temporalUpscale fills the full-res grid over a
    // 16-frame Bayer cycle and the pass warns if it stalls
    cloudsContext.time += delta * timeScale
    cloudsContext.frame += 1

    // One source for every consumer of the sun and the world frame: the
    // atmosphere context is what the date/location controls write
    cloudsContext.sunDirection.copy(atmosphereContext.sunDirectionECEF.value)
    cloudsContext.worldToECEFMatrix.copy(
      atmosphereContext.matrixWorldToECEF.value
    )
    cloudsContext.correctAltitude = atmosphereContext.correctAltitude
    cloudsContext.updateCamera(camera)

    u.viewMatrix.value.copy(camera.matrixWorldInverse)
    u.cameraNear.value = camera.near
    renderer.getSize(u.screenResolution.value)
    u.shadowFrame.value = cloudsContext.frame
    u.stbn.value = cloudsContext.stbnTexture
    u.sunDirection.value.copy(cloudsContext.sunDirection)
    u.ecefToWorldMatrix.value.copy(cloudsContext.ecefToWorldMatrix)
    u.worldToECEFMatrix.value.copy(cloudsContext.worldToECEFMatrix)
    u.altitudeCorrection.value.copy(cloudsContext.altitudeCorrection)
    u.worldToUnit.value = 1 / cloudsContext.bottomRadius
    u.resolution.value.copy(cloudsContext.shadow.mapSize)

    renderPipeline.render()

    if (overlayScene != null) {
      const { autoClearColor, outputColorSpace } = renderer
      renderer.autoClearColor = false
      renderer.outputColorSpace = ColorManagement.workingColorSpace
      renderer.render(overlayScene, camera)
      renderer.autoClearColor = autoClearColor
      renderer.outputColorSpace = outputColorSpace
    }
  }, 1)

  // Dev-only page handle for scripted measurements (scripts/ydz3.mjs reads the
  // pose, the sun and the clouds state). A frame is only comparable to one
  // from the same pose, which a screenshot cannot state
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __cloudsStory?: unknown }
    w.__cloudsStory = {
      camera,
      renderer,
      cloudsContext,
      atmosphereContext,
      // The tail filters, so a scripted A/B can assert the arm it asked for is
      // the arm that ran rather than trusting the args string
      tail: { taa, smaa: storySmaa, dithering: storyDithering }
    }
    return () => {
      delete w.__cloudsStory
    }
  }, [
    camera,
    renderer,
    cloudsContext,
    atmosphereContext,
    taa,
    storySmaa,
    storyDithering
  ])

  // Tone mapping controls:
  useToneMappingControls(toneMappingNode, () => {
    renderPipeline.needsUpdate = true
  })

  return null
}
