// Post-processing pipeline combining scene pass, aerial perspective with cloud
// shadow length, volumetric clouds composite, lens flare, AgX tone mapping,
// and display-space dithering

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, type FC } from 'react'
import { AgXToneMapping, Matrix4, NoToneMapping, Vector2, Vector3 } from 'three'
import {
  aerialPerspectiveWithCloudShadow,
  createCloudShadowTransmittance,
  createGetShadowRadius,
  DEFAULT_SHADOW_RADIUS,
  getSTBN,
  type GroundShadowExtraDeps
} from 'three-clouds-webgpu'
import { useClouds } from 'three-clouds-webgpu/r3f'
import {
  context,
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
  type Renderer
} from 'three/webgpu'

import type {
  AtmosphereContext,
  SkyNode
} from '@takram/three-atmosphere/webgpu'
import {
  depthToViewZ,
  dithering,
  inverseProjectionMatrix,
  inverseViewMatrix,
  lensFlare,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

import { matchWebGLLensFlare } from './lensFlare'

interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

export interface FrameStats {
  fps: number
  frameMs: number
  frame: number
}

export interface CloudsPostProcessingProps {
  scenePass: PassNode
  atmosphereContext: AtmosphereContext
  albedoScale?: number
  lightingMask?: boolean
  nightSky?: boolean
  exposure: number
  weatherTime: number
  onFrameStats?: (stats: FrameStats) => void
}

export const CloudsPostProcessing: FC<CloudsPostProcessingProps> = ({
  scenePass,
  atmosphereContext,
  albedoScale,
  lightingMask = false,
  nightSky = true,
  exposure,
  weatherTime,
  onFrameStats
}) => {
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const camera = useThree(({ camera }) => camera)
  const { pass: cloudsPass, context: cloudsContext } = useClouds()

  useLayoutEffect(() => {
    renderer.toneMapping = NoToneMapping
    renderer.contextNode = context({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getAtmosphere: () => atmosphereContext,
      getClouds: () => cloudsContext
    })
  }, [renderer, atmosphereContext, cloudsContext])

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
      screenResolution: uniform(new Vector2()),
      shadowFrame: uniform(0),
      exposure: uniform(10),
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
  // Explicit LOD: the aerial node reads the mask inside its surface branch,
  // where an implicit-LOD sample has undefined derivatives
  const lightingMaskNode = useMemo(
    () =>
      lightingMask ? scenePass.getTextureNode('lit').level(float(0)).r : null,
    [scenePass, lightingMask]
  )

  const aerialNode = useMemo(() => {
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
    const shadowRadius = createGetShadowRadius({
      shadowMatrices: cloudsPass.cloudShadow.matrices,
      inverseShadowMatrices: cloudsPass.cloudShadow.inverseMatrices,
      shadowMapSize: u.resolution,
      projectionMatrix: projectionMatrix(camera) as unknown as Node<'mat4'>,
      viewMatrix: u.viewMatrix,
      resolution: u.screenResolution,
      shadowRadius: float(DEFAULT_SHADOW_RADIUS)
    })
    const stbn = getSTBN(u.stbn, u.shadowFrame)

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

    const aerial = aerialPerspectiveWithCloudShadow(
      colorNode,
      depthNode,
      cloudsPass.cloudShadowLength,
      aerialShadowNode,
      normalNode,
      lightingMaskNode
    )
    aerial.normalNode = normalNode
    aerial.lighting = true
    if (nightSky) {
      const sky = aerial.skyNode as SkyNode | null
      if (sky != null) {
        sky.showStars = true
        sky.showMoon = true
        sky.moonScattering = true
        sky.moonNode.intensity.value = 1
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
    nightSky
  ])

  useEffect(() => {
    return () => {
      aerialNode.dispose()
    }
  }, [aerialNode])

  const finalNode = useMemo(() => {
    const compositeNode = cloudsPass.composite(aerialNode)
    const lensFlareNode = matchWebGLLensFlare(lensFlare(compositeNode))
    const toneMappingNode = toneMapping(
      AgXToneMapping,
      u.exposure,
      lensFlareNode as unknown as Node<'vec4'>
    )
    const displayOutput = renderOutput(
      toneMappingNode
    ) as unknown as Node<'vec4'>
    return displayOutput.add(dithering as unknown as Node<'vec3'>)
  }, [cloudsPass, aerialNode, u.exposure])

  const renderPipeline = useMemo(() => {
    const pipeline = new RenderPipeline(renderer, finalNode)
    pipeline.outputColorTransform = false
    return pipeline
  }, [renderer, finalNode])

  useEffect(() => {
    return () => {
      renderPipeline.dispose()
    }
  }, [renderPipeline])

  const weatherTimeRef = useRef(weatherTime)
  weatherTimeRef.current = weatherTime
  const exposureRef = useRef(exposure)
  exposureRef.current = exposure

  const statsRef = useRef({
    lastNow: 0,
    emaFrameMs: 16.67,
    lastReportNow: 0
  })

  useFrame(() => {
    const now = performance.now()
    const st = statsRef.current
    if (st.lastNow > 0) {
      const dtMs = now - st.lastNow
      if (dtMs > 0.5 && dtMs < 500) {
        st.emaFrameMs = st.emaFrameMs * 0.88 + dtMs * 0.12
      }
    }
    st.lastNow = now

    atmosphereContext.camera = camera
    cloudsContext.time = weatherTimeRef.current
    cloudsContext.frame += 1

    cloudsContext.sunDirection.copy(atmosphereContext.sunDirectionECEF.value)
    cloudsContext.worldToECEFMatrix.copy(
      atmosphereContext.matrixWorldToECEF.value
    )
    cloudsContext.correctAltitude = atmosphereContext.correctAltitude
    cloudsContext.updateCamera(camera)

    if (nightSky) {
      const sky = aerialNode.skyNode as SkyNode | null
      if (sky != null) {
        sky.moonNode.intensity.value = cloudsContext.moonGain
      }
    }

    u.viewMatrix.value.copy(camera.matrixWorldInverse)
    u.cameraNear.value = camera.near
    renderer.getSize(u.screenResolution.value)
    u.shadowFrame.value = cloudsContext.frame
    u.exposure.value = exposureRef.current
    u.stbn.value = cloudsContext.stbnTexture
    u.sunDirection.value.copy(cloudsContext.sunDirection)
    u.ecefToWorldMatrix.value.copy(cloudsContext.ecefToWorldMatrix)
    u.worldToECEFMatrix.value.copy(cloudsContext.worldToECEFMatrix)
    u.altitudeCorrection.value.copy(cloudsContext.altitudeCorrection)
    u.worldToUnit.value = 1 / cloudsContext.bottomRadius
    u.resolution.value.copy(cloudsContext.shadow.mapSize)

    void renderPipeline.render()

    if (onFrameStats != null && now - st.lastReportNow > 250) {
      st.lastReportNow = now
      onFrameStats({
        fps: Math.round(1000 / Math.max(1, st.emaFrameMs)),
        frameMs: st.emaFrameMs,
        frame: cloudsContext.frame
      })
    }
  }, 1)

  return null
}
