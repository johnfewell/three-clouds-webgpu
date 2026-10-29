export declare const ATMOSPHERE_MODES: readonly NonNullable<
  ProfileOptions['atmosphereMode']
>[]
export declare const RAYMARCH_MODES: readonly NonNullable<
  ProfileOptions['atmosphereMode']
>[]
export interface ProfileOptions {
  scatteringSamples?: [number, number]
  atmosphereMode?:
    | 'reference'
    | 'raymarch-256'
    | 'samples-scene-64'
    | 'samples-clouds-64'
    | 'lookup-both'
  qualityScreen?: boolean
}
export declare function screenProfileQuality(): Promise<Record<string, unknown>>
export interface ProfilePass {
  type: string
  uid: string
  names: string[]
  scatteringSamples?: number[]
  startNs: string
  endNs: string
  ms: number
}
export declare function validateProfileOptions(
  profile: ProfileOptions,
  backend: string
): void
export declare function summarisePasses(
  frames: ProfilePass[][]
): Record<string, { framesPresent: number; medianMs: number; values: number[] }>
export declare function validateAtmosphereReceipt(
  profile: {
    frames: ProfilePass[][]
    integration: { cloudsRaymarch: boolean; sceneRaymarch: boolean }
  },
  mode: NonNullable<ProfileOptions['atmosphereMode']>
): void
