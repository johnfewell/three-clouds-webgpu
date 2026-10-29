export interface PixelImage {
  width: number
  height: number
  channels: number
  data: Uint8Array
  mask?: { x: number; y: number; width: number; height: number }
}
export interface PixelMetrics {
  samples: number
  mean: number
  range: number
  meanDifference: number
  changedFraction: number
}
export const LIMITS: Readonly<Record<string, number>>
export function decodeScreenshot(
  bytes: Uint8Array,
  mask?: PixelImage['mask']
): PixelImage
export function comparePixels(
  first: PixelImage,
  second?: PixelImage
): PixelMetrics
export function assertVisible(image: PixelImage): PixelMetrics
export function assertContribution(
  on: PixelImage,
  repeat: PixelImage,
  off: PixelImage,
  restored: PixelImage,
  limits?: Readonly<Record<string, number>>
): {
  noise: PixelMetrics
  contribution: PixelMetrics
  restoration: PixelMetrics
}
