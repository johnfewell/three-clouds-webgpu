// Reads a live side B's knobs into the plain SessionSetup a three-free
// runtime starts from. Knobs only: every derived value is the core's own

import { Vector2, type PerspectiveCamera } from 'three'

import { createCloudsInputs } from '../src/cpu/inputs'
import type { SessionSetup } from '../src/runtime/session'

interface SideBLike {
  renderer: {
    getPixelRatio(): number
    getSize(v: Vector2): unknown
    getDrawingBufferSize(v: Vector2): unknown
    toneMappingExposure: number
  }
  camera: unknown
  cloudsContext: unknown
  atmosphereContext: unknown
}

type Plain = Record<string, unknown>

// Vectors and matrices as plain components, everything else as is
function plain(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  if ('elements' in value)
    return { elements: Array.from((value as Plain)['elements'] as number[]) }
  if (Array.isArray(value)) return value.map(plain)
  if ('isVector2' in value || 'isVector3' in value || 'isVector4' in value) {
    const { x, y, z, w } = value as Plain
    return Object.fromEntries(
      Object.entries({ x, y, z, w }).filter(([, c]) => c !== undefined)
    )
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, plain(v)])
  )
}

// The CloudsInputs keys, read off the context under the same names
const INPUT_KEYS = [
  'time',
  'frame',
  'temporalUpscale',
  'resolutionScale',
  'lightShafts',
  'shapeDetail',
  'turbulence',
  'haze',
  'worldToECEFMatrix',
  'bottomRadius',
  'correctAltitude',
  'sunDirection',
  'moonDirection',
  'moonGain',
  'moonColor',
  'coverage',
  'scatteringCoefficient',
  'absorptionCoefficient',
  'turbulenceDisplacement',
  'skyLightScale',
  'groundBounceScale',
  'powderScale',
  'powderExponent',
  'localWeatherRepeat',
  'shapeRepeat',
  'shapeDetailRepeat',
  'turbulenceRepeat',
  'localWeatherOffset',
  'shapeOffset',
  'shapeDetailOffset',
  'localWeatherVelocity',
  'shapeVelocity',
  'shapeDetailVelocity'
]

const LAYER_KEYS = [
  'channel',
  'altitude',
  'height',
  'densityScale',
  'shapeAmount',
  'shapeDetailAmount',
  'weatherExponent',
  'shapeAlteringBias',
  'coverageFilterWidth',
  'densityProfile',
  'shadow'
]

function pick(from: Plain, keys: string[]): Plain {
  return Object.fromEntries(keys.map(k => [k, plain(from[k])]))
}

export function caseSetup(sideB: SideBLike): SessionSetup {
  const ctx = sideB.cloudsContext as Plain
  const layers = (ctx['cloudLayers'] as Plain[]).map(l => pick(l, LAYER_KEYS))
  const experimental = ctx['experimental'] as { moonlight: boolean }
  // the quality groups carry exactly the core's keys, nothing the port adds
  const defaults = createCloudsInputs()
  const clouds = pick(ctx['clouds'] as Plain, Object.keys(defaults.clouds))
  const shadow = pick(ctx['shadow'] as Plain, Object.keys(defaults.shadow))
  const inputs: Plain = {
    ...pick(ctx, INPUT_KEYS),
    moonlight: experimental.moonlight,
    cloudLayers: layers,
    clouds,
    shadow
  }

  const atm = sideB.atmosphereContext as Record<string, { value: unknown }>
  const atmosphere: Plain = Object.fromEntries(
    [
      'matrixWorldToECEF',
      'matrixECIToECEF',
      'matrixMoonFixedToECEF',
      'sunDirectionECEF',
      'moonDirectionECEF'
    ].map(k => [k, plain(atm[k]!.value)])
  )

  const camera = sideB.camera as PerspectiveCamera
  camera.updateMatrixWorld()
  const r = sideB.renderer
  const css = new Vector2()
  const buffer = new Vector2()
  r.getSize(css)
  r.getDrawingBufferSize(buffer)
  return {
    inputs,
    atmosphere,
    camera: {
      fov: camera.fov,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
      zoom: camera.zoom,
      matrixWorld: Array.from(camera.matrixWorld.elements)
    },
    size: {
      width: buffer.x,
      height: buffer.y,
      cssWidth: css.x,
      cssHeight: css.y,
      pixelRatio: r.getPixelRatio()
    },
    app: {
      fields: {
        reference_toneMappingExposure: r.toneMappingExposure,
        'Stars.object.reference_opacity': 1
      },
      objects: {}
    }
  }
}
