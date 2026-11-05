export interface WeatherTextureData {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
  sample(u: number, v: number, level: number): number[]
}

export interface VolumeTextureData {
  readonly size: number
  readonly data: Uint8Array
  sample(x: number, y: number, z: number): number
}

export interface CloudAssets {
  readonly weather: WeatherTextureData
  readonly shape: VolumeTextureData
  readonly shapeDetail: VolumeTextureData
}

export declare function assetsRoot(): string
export declare function loadAssets(root?: string): CloudAssets
