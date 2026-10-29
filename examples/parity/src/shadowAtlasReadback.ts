// Side A's shadow atlas is a WebGLArrayRenderTarget, so a per-cascade read is
// a framebufferTextureLayer + readPixels, where side B reads the same data
// through three's async reader. That is why readShadowAtlas() could only ever
// answer for B. The GL surface is named member by member rather than
// typed as a WebGL2RenderingContext, so the arithmetic below is unit-testable
import { DataUtils } from 'three'

export interface AtlasGLReader {
  // constants
  FRAMEBUFFER: number
  READ_FRAMEBUFFER: number
  DRAW_FRAMEBUFFER: number
  COLOR_ATTACHMENT0: number
  FRAMEBUFFER_COMPLETE: number
  RGBA: number
  FLOAT: number
  HALF_FLOAT: number
  IMPLEMENTATION_COLOR_READ_FORMAT: number
  IMPLEMENTATION_COLOR_READ_TYPE: number
  READ_FRAMEBUFFER_BINDING: number
  DRAW_FRAMEBUFFER_BINDING: number
  NO_ERROR: number
  // calls
  createFramebuffer: () => unknown
  deleteFramebuffer: (framebuffer: unknown) => void
  bindFramebuffer: (target: number, framebuffer: unknown) => void
  checkFramebufferStatus: (target: number) => number
  framebufferTextureLayer: (
    target: number,
    attachment: number,
    texture: unknown,
    level: number,
    layer: number
  ) => void
  readBuffer: (attachment: number) => void
  getParameter: (name: number) => unknown
  getError: (this: void) => number
  readPixels: (
    x: number,
    y: number,
    width: number,
    height: number,
    format: number,
    type: number,
    pixels: ArrayBufferView
  ) => void
}

export interface AtlasCascadeLayersInput {
  depth: number
  temporalPass: boolean
  /** the pre-resolve march output rather than the published resolve */
  raw: boolean
}

/**
 * How many array layers of side A's shadow atlas carry cascade data.
 *
 * `depth` in every case, and the reason is the trap: the reference sizes its
 * CURRENT target `depth * 2` while the temporal pass is on, because the upper
 * half is the depth velocity (ShadowPass.setSize:151-159). That doubles the
 * LAYER COUNT, not the cascade OFFSET, so cascade 0 still begins at layer 0
 * and reading `depth` layers from there is the atlas, not a stride of it
 */
export function atlasCascadeLayerCount(input: AtlasCascadeLayersInput): number {
  const { depth } = input
  if (!Number.isInteger(depth) || depth <= 0) {
    throw new Error(`Shadow atlas depth ${depth} is not a positive integer`)
  }
  return depth
}

export interface AtlasReadFormat {
  format: number
  type: number
  element: 'float' | 'uint16'
}

/**
 * The readPixels pair for the framebuffer's own IMPLEMENTATION_COLOR_READ_*
 * answer, refusing rather than guessing.
 *
 * An RGBA16F attachment may report HALF_FLOAT, and FLOAT on it is an
 * INVALID_OPERATION on some drivers, which arrives as a zero-filled buffer
 */
export function atlasReadFormat(
  readFormat: number,
  readType: number,
  gl: Pick<AtlasGLReader, 'RGBA' | 'FLOAT' | 'HALF_FLOAT'>
): AtlasReadFormat {
  if (readFormat !== gl.RGBA) {
    throw new Error(
      `Shadow atlas read format 0x${readFormat.toString(16)} is not RGBA`
    )
  }
  if (readType === gl.FLOAT) {
    return { format: gl.RGBA, type: gl.FLOAT, element: 'float' }
  }
  if (readType === gl.HALF_FLOAT) {
    return { format: gl.RGBA, type: gl.HALF_FLOAT, element: 'uint16' }
  }
  throw new Error(
    `Shadow atlas read type 0x${readType.toString(16)} is neither FLOAT nor HALF_FLOAT`
  )
}

export interface AtlasGLReadInput {
  gl: AtlasGLReader
  /** the renderer's __webglTexture for the target's texture */
  texture: unknown
  width: number
  height: number
  layerCount: number
}

export interface AtlasLayerRead {
  layers: Float32Array[]
  preexistingErrors: number[]
}

// WebGL INVALID_FRAMEBUFFER_OPERATION. Not exported: the test hardcodes it
const INVALID_FRAMEBUFFER_OPERATION = 0x0506

/**
 * Side A's raw atlas: one Float32Array per cascade layer, in gl.readPixels'
 * own bottom-row-first order.
 *
 * Bottom-first is correct and must NOT be flipped here. The ray-extent twin
 * (`reconstructShadowRayExtent`) maps row 0 to clipY -1, which is the
 * correspondence gl.readPixels delivers, and side B's atlas contract already
 * passes against that twin. Flipping would break the one instrument that can
 * say which order a side is in
 */
export function readAtlasLayersGL(input: AtlasGLReadInput): AtlasLayerRead {
  const { gl, texture, width, height, layerCount } = input
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      `Shadow atlas size ${width}x${height} is not a positive integer pair`
    )
  }
  if (!Number.isInteger(layerCount) || layerCount <= 0) {
    throw new Error(`Shadow atlas layer count ${layerCount} is not positive`)
  }
  // Drain what the render left behind: a pending error would otherwise be
  // attributed to this read, or hide one
  const preexisting = drainErrors(gl)
  const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
  const previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
  const framebuffer = gl.createFramebuffer()
  const layers: Float32Array[] = []
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer)
    // IMPLEMENTATION_COLOR_READ_* describes the BOUND read framebuffer, so it
    // cannot be asked before this framebuffer is bound. Asked earlier this
    // driver answers UNSIGNED_BYTE, for the default framebuffer
    gl.framebufferTextureLayer(
      gl.READ_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      texture,
      0,
      0
    )
    const readFormat = atlasReadFormat(
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number,
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number,
      gl
    )
    for (let layer = 0; layer < layerCount; layer++) {
      gl.framebufferTextureLayer(
        gl.READ_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        texture,
        0,
        layer
      )
      gl.readBuffer(gl.COLOR_ATTACHMENT0)
      const status = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(
          `Shadow atlas framebuffer incomplete ` +
            `(0x${Number(status).toString(16)}) at layer ${layer}`
        )
      }
      const values =
        readFormat.element === 'float'
          ? new Float32Array(width * height * 4)
          : new Uint16Array(width * height * 4)
      gl.readPixels(
        0,
        0,
        width,
        height,
        readFormat.format,
        readFormat.type,
        values
      )
      const error = gl.getError()
      if (error !== gl.NO_ERROR) {
        throw new Error(
          `Shadow atlas read failed: GL error 0x${error.toString(16)} ` +
            `at layer ${layer}`
        )
      }
      layers.push(
        readFormat.element === 'float'
          ? (values as Float32Array)
          : Float32Array.from(values as Uint16Array, code =>
              DataUtils.fromHalfFloat(code)
            )
      )
    }
  } finally {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw)
    gl.deleteFramebuffer(framebuffer)
  }
  // Side A's render leaves INVALID_FRAMEBUFFER_OPERATION (0x506) pending
  // It is drained above so readPixels is not charged for it
  // The texels come back with the code. Any other pending code still refuses
  if (preexisting.some(code => code !== INVALID_FRAMEBUFFER_OPERATION)) {
    const codes = preexisting.map(code => `0x${code.toString(16)}`).join(', ')
    throw new Error(
      `Shadow atlas read ran with ${preexisting.length} pending GL error(s): ${codes}`
    )
  }
  return { layers, preexistingErrors: preexisting }
}

function drainErrors(gl: AtlasGLReader): number[] {
  const errors: number[] = []
  for (
    let error = gl.getError();
    error !== gl.NO_ERROR;
    error = gl.getError()
  ) {
    errors.push(error)
    if (errors.length > 8) break
  }
  return errors
}
