// Ambient declarations for the slice of three-ocean-waves used by the ocean
// ground, resolved from its sibling build in vite.config.ts

declare module 'three-ocean-waves' {
  import type { Camera, Object3D, Texture } from 'three'
  import type { Node, NodeMaterial, Renderer } from 'three/webgpu'

  export interface OceanAtmosphereSlice {
    sunColor: Node
    sunDirection: Node
  }

  export interface OceanFieldsSlice {
    atmosphere: OceanAtmosphereSlice
  }

  export interface OceanStyle {
    readonly id: string
    readonly displayName: string
    readonly costClass: string
    readonly parameters: unknown
    surface(fields: OceanFieldsSlice, params: unknown): Node
    displacementModifier?(offset: Node<'vec3'>, params: unknown): Node<'vec3'>
    spray?(params: unknown): string
  }

  export function defineStyle(style: OceanStyle): OceanStyle

  export interface WaterPreset {
    readonly id: string
    readonly constituents: {
      readonly chlorophyll: number
      readonly cdom: number
      readonly mineral: number
    }
  }

  export function findWaterPreset(id: string): WaterPreset | undefined

  export interface ClipmapOptions {
    innerCells: number
    innerCellSize: number
    rings: number
    ratio: number
    ringCells: number
  }

  export interface OceanWavesOptions {
    mapSize?: 128 | 256 | 512 | 1024
    clipmap?: ClipmapOptions
    spray?: { enabled?: boolean }
    environment?: Texture | null
    style?: string | OceanStyle
    styleParams?: Readonly<Record<string, unknown>>
    cascades?: readonly unknown[]
    onError?: (error: unknown) => void
  }

  export class OceanWaves extends Object3D {
    static create(
      renderer: Renderer,
      options?: OceanWavesOptions
    ): Promise<OceanWaves>
    readonly effectiveMapSize: number
    readonly surface: { material: NodeMaterial }
    readonly style: {
      readonly params: {
        setAll(values: Readonly<Record<string, unknown>>): void
      }
    }
    update(camera: Camera, deltaTime: number): Promise<void>
    dispose(): void
  }
}

declare module 'three-ocean-waves/styles' {
  import type { OceanStyle } from 'three-ocean-waves'

  export const realisticPlus: OceanStyle

  export interface OceanLookPreset {
    readonly id: string
    readonly style: string
    readonly styleParams: Readonly<Record<string, unknown>>
    readonly cascades: readonly unknown[]
  }

  export const realisticGroundswell: OceanLookPreset
}
