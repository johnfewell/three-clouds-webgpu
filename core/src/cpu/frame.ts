// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// The default graph's CPU frame in CloudsPassNode.renderFrame's order. Not
// covered: early shadows, experimental options (static mode too), debug views

import type { CameraState } from './camera'
import type { CascadedShadowMaps } from './cascades'
import { moonlight } from './celestial'
import type { CloudsInputs } from './inputs'
import { Vec3, type Mat4 } from './math'
import {
  composeShadowFromECEF,
  createCameraUniformValues,
  createCloudShadowValues,
  createFrameOfReference,
  createLayerUniformValues,
  createMarchUniformValues,
  createParameterUniformValues,
  createResolveUniformValues,
  createShadowMaps,
  createShadowPassUniformValues,
  frameSize,
  resetCameraHistory,
  shadowCascadeDraws,
  storeCameraHistory,
  storeShadowHistory,
  syncShadowMaps,
  updateCameraUniformValues,
  updateCloudShadowValues,
  updateFrameOfReference,
  updateLayerUniformValues,
  updateMarchUniformValues,
  updateParameterUniformValues,
  updateResolveUniformValues,
  updateShadowMaps,
  updateShadowPassUniformValues,
  type FrameSize,
  type ShadowCascadeDraw
} from './uniforms'

export interface ShadowFrame {
  // Whether the shadow map renders this frame, under shadow.updateInterval
  rendered: boolean
  // Clear both shadow histories before the resolve (a reset)
  clearHistory: boolean
  // One entry per cascade draw, empty on a frame that skips the map
  draws: ShadowCascadeDraw[]
}

interface StructureKey {
  cascadeCount: number
  temporalJitter: boolean
  temporalPass: boolean
  castsShadow: boolean
}

function structureKey(inputs: CloudsInputs): StructureKey {
  return {
    cascadeCount: inputs.shadow.cascadeCount,
    temporalJitter: inputs.shadow.temporalJitter,
    temporalPass: inputs.shadow.temporalPass,
    castsShadow: inputs.cloudLayers.some(l => l.shadow)
  }
}

export class CloudsFrameState {
  readonly reference = createFrameOfReference()
  readonly camera = createCameraUniformValues()
  readonly march = createMarchUniformValues()
  readonly layer = createLayerUniformValues()
  readonly parameter = createParameterUniformValues()
  readonly shadowPass = createShadowPassUniformValues()
  readonly resolve = createResolveUniformValues()
  readonly cloudShadow = createCloudShadowValues()
  readonly shadowMaps: CascadedShadowMaps
  size: FrameSize = { fullW: 0, fullH: 0, marchW: 0, marchH: 0 }
  shadow: ShadowFrame = { rendered: false, clearHistory: false, draws: [] }
  // Set on a reset, read by the runtime: clear the colour history this frame
  historyInvalid = true

  private readonly previousShadowMatrices: Mat4[] = []
  private shadowFramesSinceUpdate = Number.MAX_SAFE_INTEGER
  private shadowHistoryInvalid = true
  private structure: StructureKey
  private readonly shadowLight = new Vec3()
  // The shadow resolve targets' size, whose change clears the shadow history
  private resolveTargetKey: string | null = null

  constructor(readonly inputs: CloudsInputs) {
    this.shadowMaps = createShadowMaps(inputs)
    this.structure = structureKey(inputs)
  }

  // CloudsContext.resetHistory
  resetHistory(): void {
    this.historyInvalid = true
    this.shadowHistoryInvalid = true
    resetCameraHistory(this.camera)
  }

  // One frame up to the march, in the port's order. Call afterRender() once
  // the frame's passes are submitted
  update(camera: CameraState, width: number, height: number): this {
    const inputs = this.inputs
    const structureChanged = this.checkShadowStructure()
    this.size = frameSize(inputs, width, height)

    syncShadowMaps(this.shadowMaps, inputs)
    updateFrameOfReference(this.reference, inputs, camera)
    const due = this.isShadowUpdateDue(structureChanged)
    if (due) this.fitShadowMaps(camera)

    updateCameraUniformValues(this.camera, inputs, camera, this.size)
    updateMarchUniformValues(
      this.march,
      inputs,
      this.reference,
      this.camera.cameraPositionECEF
    )
    updateLayerUniformValues(this.layer, inputs)
    updateResolveUniformValues(this.resolve, inputs, this.size)
    updateParameterUniformValues(
      this.parameter,
      inputs,
      this.size,
      this.camera.jitter
    )

    if (due) {
      this.renderShadow()
      this.shadowFramesSinceUpdate = 1
    } else {
      this.shadow = { rendered: false, clearHistory: false, draws: [] }
      composeShadowFromECEF(
        this.cloudShadow,
        this.reference,
        this.camera.viewMatrix
      )
      this.shadowFramesSinceUpdate++
    }
    return this
  }

  afterRender(camera: CameraState): void {
    this.historyInvalid = false
    storeCameraHistory(this.camera, camera)
  }

  private checkShadowStructure(): boolean {
    const next = structureKey(this.inputs)
    const prev = this.structure
    const changed =
      next.cascadeCount !== prev.cascadeCount ||
      next.temporalJitter !== prev.temporalJitter ||
      next.temporalPass !== prev.temporalPass ||
      next.castsShadow !== prev.castsShadow
    this.structure = next
    if (changed) this.resetHistory()
    return changed
  }

  private isShadowUpdateDue(structureChanged: boolean): boolean {
    const interval = Math.max(1, Math.floor(this.inputs.shadow.updateInterval))
    return (
      interval === 1 ||
      structureChanged ||
      this.shadowHistoryInvalid ||
      this.shadowFramesSinceUpdate >= interval
    )
  }

  private fitShadowMaps(camera: CameraState): void {
    const inputs = this.inputs
    const light = {
      lightDirection: this.shadowLight,
      irradianceRatio: new Vec3()
    }
    // The port fits before this frame's camera uniforms are written, so the
    // twilight blend reads the previous frame's camera, the origin on frame 0
    moonlight(
      inputs.sunDirection,
      inputs.moonDirection,
      this.camera.cameraPositionECEF,
      inputs.moonlight ? inputs.moonGain : 0,
      inputs.moonColor,
      light
    )
    updateShadowMaps(
      this.shadowMaps,
      inputs,
      this.reference,
      this.shadowLight,
      camera
    )
  }

  private renderShadow(): void {
    const inputs = this.inputs
    updateShadowPassUniformValues(this.shadowPass, inputs)
    const temporal = inputs.shadow.temporalPass
    const draws = shadowCascadeDraws(
      this.shadowMaps,
      this.previousShadowMatrices
    )
    if (temporal) {
      const { mapSize, cascadeCount } = inputs.shadow
      const key = `${mapSize.x}x${mapSize.y}x${cascadeCount}`
      if (key !== this.resolveTargetKey) this.shadowHistoryInvalid = true
      this.resolveTargetKey = key
    }
    const clearHistory = temporal && this.shadowHistoryInvalid
    if (temporal)
      storeShadowHistory(this.shadowMaps, this.previousShadowMatrices)
    this.shadowHistoryInvalid = false
    this.shadow = { rendered: true, clearHistory, draws }
    updateCloudShadowValues(
      this.cloudShadow,
      this.shadowMaps,
      inputs,
      this.layer.shadowTopHeight
    )
    composeShadowFromECEF(
      this.cloudShadow,
      this.reference,
      this.camera.viewMatrix
    )
  }
}
