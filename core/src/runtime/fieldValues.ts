// Resolves a uniform field's value BY NAME from the CPU state. The names are
// the TSL names in the description's field maps (core/CPU-STATE.md tables)

import type {
  AtmosphereInputs,
  AtmosphereUniformValues
} from '../cpu/atmosphere'
import type { BuiltinUniformValues } from '../cpu/builtins'
import type { CameraState } from '../cpu/camera'
import type { CloudsFrameState } from '../cpu/frame'
import { Vec2, type Mat4, type Vec3 } from '../cpu/math'
import type { FieldValue } from './pack'

// Values only the app knows: its scene objects and renderer state
export interface AppFields {
  // By `<buffer>.<field>` or by field name, e.g. reference_toneMappingExposure
  fields: Record<string, FieldValue>
  // three_modelWorldMatrix and three_modelNormalMatrix by pipeline name
  objects: Record<string, { modelWorldMatrix: Mat4; modelNormalMatrix?: Mat4 }>
}

// The harness's shadow consumer copies, taken before the frame updates them
export interface ConsumerHistory {
  readonly ecefToWorldMatrix: Mat4
  readonly altitudeCorrection: Vec3
}

export interface FieldSources {
  frame: CloudsFrameState
  atmosphere: AtmosphereUniformValues
  atmosphereInputs: AtmosphereInputs
  camera: CameraState
  builtins: BuiltinUniformValues
  consumer: ConsumerHistory
  app: AppFields
}

// Where a write lands: which buffer, which repeat of the field in this part
// of the schedule (the cascade of a per-draw write) and the pipeline drawn next
export interface FieldSite {
  buffer: string
  occurrence: number
  pipeline: string
  // a fullscreen pass reads three's quad camera, a scene pass the app's
  quad: boolean
  // the pass's render target size, null when it draws to the canvas
  target: number[] | null
}

const DRAW_FIELDS = new Set([
  'inverseShadowMatrix',
  'reprojectionMatrix',
  'mipLevel',
  'cascadeIndex'
])

type Table = Record<string, unknown>

function member(table: unknown, key: string): FieldValue | undefined {
  return (table as Table)[key] as FieldValue | undefined
}

function shadowField(s: FieldSources, key: string, site: FieldSite) {
  if (!DRAW_FIELDS.has(key)) return member(s.frame.shadowPass, key)
  const draw = s.frame.shadow.draws[site.occurrence]
  if (draw == null)
    throw new Error(`${site.buffer}: no cascade draw ${site.occurrence}`)
  return member(draw, key)
}

function cascadeField(s: FieldSources, key: string): FieldValue | undefined {
  const cs = s.frame.cloudShadow
  if (key === 'count') return cs.cascadeCount
  return member(cs, key)
}

function consumerField(s: FieldSources, key: string): FieldValue | undefined {
  const f = s.frame
  switch (key) {
    case 'viewMatrix':
      return f.camera.viewMatrix
    case 'cameraNear':
      return f.camera.cameraNear
    case 'sunDirection':
      return f.march.sunDirection
    case 'worldToECEFMatrix':
      return f.march.worldToECEFMatrix
    case 'worldToUnit':
      return f.march.worldToUnit
    case 'ecefToWorldMatrix':
      return s.consumer.ecefToWorldMatrix
    case 'altitudeCorrection':
      return s.consumer.altitudeCorrection
    case 'temporalJitter':
      return new Vec2()
    case 'resolution':
      return f.shadowPass.shadowResolution
    case 'screenResolution':
      return s.builtins.screenResolution
    case 'shadowFrame':
      return f.parameter.frame
  }
  return undefined
}

function skyField(s: FieldSources, key: string): FieldValue | undefined {
  const a = s.atmosphereInputs
  const table: Record<string, FieldValue> = {
    sunNode_angularRadius: a.sunAngularRadius,
    sunNode_intensity: a.sunIntensity,
    moonNode_angularRadius: a.moonAngularRadius,
    moonNode_intensity: a.moonIntensity,
    starsNode_pointSize: a.starsPointSize,
    starsNode_intensity: a.starsIntensity,
    starsNode_magnitudeRange: a.starsMagnitudeRange
  }
  return table[key]
}

// three's built-in object and renderer uniforms
function threeField(s: FieldSources, key: string, site: FieldSite) {
  const b = s.builtins
  const base = key.replace(/_\d+$/, '')
  switch (base) {
    case 'screenSize':
      return site.target == null
        ? b.screenSize
        : { x: site.target[0]!, y: site.target[1]! }
    case 'viewport':
      return site.target == null
        ? b.viewport
        : { x: 0, y: 0, z: site.target[0]!, w: site.target[1]! }
    // three r186 names the screen node's pixel-ratio uniform screenDPR
    case 'dpr':
    case 'screenDPR':
      return b.pixelRatio
    case 'matrixUniform':
      return b.uvTransform
    case 'modelWorldMatrix':
      return modelMatrix(s, site, 'modelWorldMatrix')
    case 'modelNormalMatrix':
      return modelMatrix(s, site, 'modelNormalMatrix')
  }
  return undefined
}

function modelMatrix(
  s: FieldSources,
  site: FieldSite,
  key: 'modelWorldMatrix' | 'modelNormalMatrix'
): FieldValue | undefined {
  const app = s.app.objects[site.pipeline]?.[key]
  if (app != null) return app
  if (key !== 'modelWorldMatrix') return undefined
  if (site.quad) return s.builtins.modelWorldMatrix
  // takram's StarsNode moves its points to the camera every render
  return site.pipeline === 'Stars'
    ? s.builtins.starsModelWorldMatrix
    : undefined
}

function renderGroupField(s: FieldSources, key: string, site: FieldSite) {
  if (key === 'cameraProjectionMatrix')
    return site.quad
      ? s.builtins.quadProjectionMatrix
      : s.camera.projectionMatrix
  if (key === 'cameraViewMatrix')
    return site.quad ? s.builtins.quadViewMatrix : s.camera.matrixWorldInverse
  return undefined
}

// takram's AtmosphereContext fields and its camera accessors
function atmosphereField(s: FieldSources, name: string) {
  const fromCamera: Record<string, FieldValue> = {
    inverseProjectionMatrix: s.camera.projectionMatrixInverse,
    inverseViewMatrix: s.camera.matrixWorld,
    projectionMatrix: s.camera.projectionMatrix,
    cameraNear: s.camera.near,
    cameraFar: s.camera.far
  }
  return fromCamera[name] ?? member(s.atmosphere, name)
}

const PREFIXED: Record<
  string,
  (s: FieldSources, key: string, site: FieldSite) => FieldValue | undefined
> = {
  camera: (s, k) => member(s.frame.camera, k),
  march: (s, k) => member(s.frame.march, k),
  layer: (s, k) => member(s.frame.layer, k),
  parameter: (s, k) => member(s.frame.parameter, k),
  resolve: (s, k) => member(s.frame.resolve, k),
  shadowResolve: (s, k) =>
    member(s.frame.resolve, `shadow${k[0]!.toUpperCase()}${k.slice(1)}`),
  shadow: shadowField,
  cascade: cascadeField,
  pass: (s, k) => member(s.frame.cloudShadow, k),
  shadowConsumer: consumerField,
  three: threeField
}

export function fieldValue(
  s: FieldSources,
  name: string,
  site: FieldSite
): FieldValue {
  const value = lookup(s, name, site)
  if (value === undefined)
    throw new Error(`no CPU value for ${site.buffer}.${name}`)
  return value
}

function lookup(
  s: FieldSources,
  name: string,
  site: FieldSite
): FieldValue | undefined {
  const app = s.app.fields[`${site.buffer}.${name}`] ?? s.app.fields[name]
  if (app !== undefined) return app
  // a buffer holding one array, e.g. RenderPipeline.cascade_matrices.value
  if (name === 'value') {
    const owner = site.buffer.slice(site.buffer.lastIndexOf('.') + 1)
    return lookup(s, owner, site)
  }
  if (name.startsWith('takram_skyNode_'))
    return skyField(s, name.slice('takram_skyNode_'.length))
  const split = name.indexOf('_')
  if (split > 0) {
    const resolve = PREFIXED[name.slice(0, split)]
    if (resolve != null) return resolve(s, name.slice(split + 1), site)
  }
  return renderGroupField(s, name, site) ?? atmosphereField(s, name)
}
