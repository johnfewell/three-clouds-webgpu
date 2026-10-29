// Fills the asset textures the description's init steps name, in a browser
// The upload arguments are three's own (flipY, colour space, regions)

import type { TextureInfo, UploadStep } from './description'
import type { GpuTexture } from './gpu'

interface UploadQueue {
  writeTexture(
    destination: object,
    data: Uint8Array,
    layout: object,
    size: object
  ): void
  copyExternalImageToTexture(
    source: object,
    destination: object,
    size: object
  ): void
}

// lowbias32 from the port's createHashJitterTexture, the parity jitter volume
function lowbias32(x: number): number {
  x = (x + 0x9e3779b9) | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x21f0aaad)
  x ^= x >>> 15
  x = Math.imul(x, 0x735a2d97)
  x ^= x >>> 15
  return x >>> 0
}

function generated(kind: string, size: number[]): Uint8Array {
  if (kind !== 'hashJitter') throw new Error(`unknown generated asset ${kind}`)
  const data = new Uint8Array(size[0]! * size[1]! * size[2]!)
  for (let i = 0; i < data.length; i++) data[i] = lowbias32(i) & 0xff
  return data
}

// baseUrl: the directory holding the asset files (the parity assets)
export function browserUpload(
  queue: UploadQueue,
  textures: Record<string, TextureInfo>,
  baseUrl: string
): (step: UploadStep, texture: GpuTexture) => Promise<void> {
  return async (step, texture) => {
    const info = textures[step.texture]!
    const content = info.content
    if (content == null) throw new Error(`no content for ${step.texture}`)
    if (step.kind === 'copyExternalImage') {
      const img = new Image()
      img.src = `${baseUrl}/${content.file!}`
      await img.decode()
      const { source, dst, size } = step.args as Record<string, object>
      queue.copyExternalImageToTexture(
        { ...source, source: img },
        { ...dst, texture },
        size!
      )
      return
    }
    const data =
      content.generated != null
        ? generated(content.generated, info.size)
        : new Uint8Array(
            await (await fetch(`${baseUrl}/${content.file!}`)).arrayBuffer()
          )
    for (const region of step.args as Record<string, object>[]) {
      const { layout, size, ...dst } = region
      queue.writeTexture({ ...dst, texture }, data, layout!, size!)
    }
  }
}
