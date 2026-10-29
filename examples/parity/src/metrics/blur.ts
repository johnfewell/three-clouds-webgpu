// Gaussian blur for SSIM pre-processing
// Separable 2-pass (horizontal then vertical) over a single-channel buffer

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 3)
  const size = 2 * radius + 1
  const kernel = new Float32Array(size)
  let sum = 0
  for (let i = 0; i < size; i++) {
    const x = i - radius
    kernel[i] = Math.exp((-x * x) / (2 * sigma * sigma))
    sum += kernel[i]!
  }
  for (let i = 0; i < size; i++) {
    kernel[i] = kernel[i]! / sum
  }
  return kernel
}

export function gaussianBlur(
  data: Float32Array,
  width: number,
  height: number,
  sigma: number
): Float32Array {
  const kernel = gaussianKernel(sigma)
  const radius = (kernel.length - 1) / 2
  const temp = new Float32Array(width * height)
  const out = new Float32Array(width * height)

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(Math.max(x + k, 0), width - 1)
        sum += data[y * width + sx]! * kernel[k + radius]!
      }
      temp[y * width + x] = sum
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(Math.max(y + k, 0), height - 1)
        sum += temp[sy * width + x]! * kernel[k + radius]!
      }
      out[y * width + x] = sum
    }
  }

  return out
}
