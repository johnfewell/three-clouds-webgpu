// The CPU side of one rendered view: knobs in, every field source out. A
// session is built from plain data, so a page with no three can run one

import {
  createAtmosphereInputs,
  createAtmosphereUniformValues,
  updateAtmosphereUniformValues
} from '../cpu/atmosphere'
import {
  createBuiltinUniformValues,
  updateBuiltinUniformValues,
  type RendererSize
} from '../cpu/builtins'
import { createCamera, setCameraWorld, setPerspective } from '../cpu/camera'
import { CloudsFrameState } from '../cpu/frame'
import { createCloudsInputs } from '../cpu/inputs'
import { Mat4, Vec3 } from '../cpu/math'
import type { AppFields, FieldSources } from './fieldValues'

type Plain = Record<string, unknown>

// Copies a plain value tree onto the core's objects, key by key. Vectors and
// matrices copy their components, so the target keeps its classes
export function assignPlain(target: object, source: Plain, path = ''): void {
  const into = target as Plain
  for (const [key, value] of Object.entries(source)) {
    const at = path === '' ? key : `${path}.${key}`
    if (!(key in into)) throw new Error(`unknown input ${at}`)
    const current = into[key]
    if (current != null && typeof current === 'object') {
      if (value == null || typeof value !== 'object')
        throw new Error(`input ${at} needs an object`)
      if ('elements' in current) {
        const e = (current as { elements: number[] }).elements
        const from = (value as { elements: ArrayLike<number> }).elements
        for (let i = 0; i < e.length; i++) e[i] = from[i]!
      } else assignPlain(current, value as Plain, at)
    } else into[key] = value
  }
}

export interface PerspectiveSetup {
  fov: number
  aspect: number
  near: number
  far: number
  zoom: number
  // column-major, as three's Matrix4.elements
  matrixWorld: number[]
}

// Everything a view needs, as JSON. `inputs` and `atmosphere` hold any
// subset of CloudsInputs and AtmosphereInputs
export interface SessionSetup {
  inputs: Plain
  atmosphere: Plain
  camera: PerspectiveSetup
  size: RendererSize
  app: AppFields
}

export class RuntimeSession {
  readonly inputs = createCloudsInputs()
  readonly atmosphereInputs = createAtmosphereInputs()
  readonly camera = createCamera()
  readonly frame: CloudsFrameState
  readonly sources: FieldSources
  private readonly consumer = {
    ecefToWorldMatrix: new Mat4(),
    altitudeCorrection: new Vec3()
  }

  constructor(readonly setup: SessionSetup) {
    assignPlain(this.inputs, setup.inputs)
    assignPlain(this.atmosphereInputs, setup.atmosphere)
    this.setCamera(setup.camera)
    this.frame = new CloudsFrameState(this.inputs)
    this.sources = {
      frame: this.frame,
      atmosphere: createAtmosphereUniformValues(),
      atmosphereInputs: this.atmosphereInputs,
      camera: this.camera,
      builtins: createBuiltinUniformValues(),
      consumer: this.consumer,
      app: setup.app
    }
  }

  setCamera(c: PerspectiveSetup): void {
    setPerspective(this.camera, c)
    setCameraWorld(this.camera, new Mat4().fromArray(c.matrixWorld))
  }

  // One frame's CPU state, in the order the three package computes it
  update(): FieldSources {
    const s = this.sources
    const size = this.setup.size
    // the harness copies these before the pass updates them (CPU-STATE.md)
    this.consumer.ecefToWorldMatrix.copy(this.frame.reference.ecefToWorldMatrix)
    this.consumer.altitudeCorrection.copy(
      this.frame.reference.altitudeCorrection
    )
    this.frame.update(this.camera, size.width, size.height)
    updateAtmosphereUniformValues(
      s.atmosphere,
      this.atmosphereInputs,
      this.camera
    )
    updateBuiltinUniformValues(s.builtins, size, this.camera)
    return s
  }

  afterRender(): void {
    this.frame.afterRender(this.camera)
  }

  resetHistory(): void {
    this.frame.resetHistory()
  }
}
