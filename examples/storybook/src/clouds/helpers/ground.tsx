// The `ground` toolbar global: Google Photorealistic 3D Tiles under the
// WebGPU clouds stories, so an experiment can be judged over real terrain
// instead of the bare ellipsoid. A global, not an arg, so it survives switching
// between an experiment and its baseline

import { useThree } from '@react-three/fiber'
import { atom, useAtomValue } from 'jotai'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  type FC
} from 'react'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { float } from 'three/tsl'
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu'

import {
  Ellipsoid,
  Geodetic,
  PointOfView,
  radians
} from '@takram/three-geospatial'

import { Globe } from '../../vendor/components/Globe'
import type { PointOfViewProps } from '../../vendor/hooks/usePointOfView'

// Low, mid-latitude ground on purpose: cloud layers sit at fixed altitudes
// above the ellipsoid, so 2 to 3 km terrain hides them, and day 0 at 09:00 is
// before sunrise at 62 N
export const GROUND_LOCATIONS = {
  fuji: {
    title: 'Mount Fuji',
    pov: {
      longitude: 138.634,
      latitude: 35.5,
      heading: -91,
      pitch: -27,
      distance: 8444
    }
  },
  capeTown: {
    title: 'Cape Town',
    pov: {
      longitude: 18.4241,
      latitude: -33.9249,
      height: 0,
      heading: 180,
      pitch: -8,
      distance: 6000
    }
  },
  goldenGate: {
    title: 'Golden Gate',
    pov: {
      longitude: -122.4783,
      latitude: 37.8199,
      height: 0,
      heading: -20,
      pitch: -6,
      distance: 4000
    }
  },
  rio: {
    title: 'Rio de Janeiro',
    pov: {
      longitude: -43.1567,
      latitude: -22.9486,
      height: 0,
      heading: 160,
      pitch: -6,
      distance: 4000
    }
  },
  tokyo: {
    title: 'Tokyo',
    pov: {
      longitude: 139.8146,
      latitude: 35.7455,
      heading: -110,
      pitch: -9,
      distance: 1000
    }
  },
  london: {
    title: 'London',
    pov: {
      longitude: -0.1293,
      latitude: 51.4836,
      heading: -94,
      pitch: -7,
      distance: 3231
    }
  },
  toronto: {
    title: 'Toronto',
    pov: {
      longitude: -79.3871,
      latitude: 43.6426,
      heading: 90,
      pitch: -6,
      distance: 3500
    }
  }
} satisfies Record<string, { title: string; pov: PointOfViewProps }>

export type GroundLocation = keyof typeof GROUND_LOCATIONS

export type GroundValue = GroundLocation | 'bare' | 'ocean'

export const groundAtom = atom<GroundValue>('bare')

export function isGroundValue(value: unknown): value is GroundValue {
  return (
    value === 'bare' ||
    value === 'ocean' ||
    (typeof value === 'string' && Object.hasOwn(GROUND_LOCATIONS, value))
  )
}

// The ocean's water body. The look's own is clear oceanic water, realistic and
// dark. The coastal mixes scatter more, so cloud shadows read at a distance
export const WATER_BODIES = {
  look: { title: 'Water: clear ocean (Groundswell look)', preset: null },
  coastalClear: { title: 'Water: coastal clear', preset: 'coastal-clear' },
  coastalTurbid: { title: 'Water: coastal turbid', preset: 'coastal-turbid' }
} as const

export type WaterBody = keyof typeof WATER_BODIES

export const waterAtom = atom<WaterBody>('look')

export function isWaterBody(value: unknown): value is WaterBody {
  return typeof value === 'string' && Object.hasOwn(WATER_BODIES, value)
}

export interface Ground {
  value: GroundValue
  tiles: boolean
  // three-ocean-waves at sea level under the story's own pose, in a world
  // rebased to north-up-east at the story's location (the ocean is Y-up)
  ocean: boolean
  // The story's own pose when bare or ocean, the location's when tiled
  pov: PointOfViewProps
  // Post-lit tiles hand the aerial node unlit albedo, scaled as the 3D Tiles
  // story does
  albedoScale: number | undefined
}

export function useGround(storyPov: PointOfViewProps): Ground {
  const value = useAtomValue(groundAtom)
  if (value === 'bare' || value === 'ocean') {
    return {
      value,
      tiles: false,
      ocean: value === 'ocean',
      pov: storyPov,
      albedoScale: undefined
    }
  }
  return {
    value,
    tiles: true,
    ocean: false,
    pov: GROUND_LOCATIONS[value].pov,
    albedoScale: 2 / Math.PI
  }
}

// The ocean's pixels keep their own shading: 0 in this channel excludes them
// from the aerial node's post-lighting (its lighting mask), 1 everywhere else
export function groundMRT(ocean: boolean): Record<string, Node> {
  return ocean ? { lit: float(1) } : {}
}

const frameScratch = new Matrix4()
const inverseScratch = new Matrix4()
const rotationScratch = new Quaternion()
const ecefScratch = new Vector3()

// Places the camera at the pose and writes the world frame: identity (ECEF)
// normally, north-up-east at the location for the ocean. Returns the orbit
// target in that world frame
export function useGroundCamera(
  ground: Ground,
  matrixWorldToECEF: Matrix4
): Vector3 {
  const camera = useThree(({ camera }) => camera)
  const {
    longitude,
    latitude,
    height = 0,
    heading,
    pitch,
    distance
  } = ground.pov
  const { ocean } = ground

  const [frame, target] = useMemo(() => {
    const frame = new Matrix4()
    if (ocean) {
      Ellipsoid.WGS84.getNorthUpEastFrame(
        new Geodetic(radians(longitude), radians(latitude), 0).toECEF(
          ecefScratch
        ),
        frame
      )
    }
    const target = new Geodetic(
      radians(longitude),
      radians(latitude),
      height
    ).toECEF()
    return [frame, target.applyMatrix4(inverseScratch.copy(frame).invert())]
  }, [ocean, longitude, latitude, height])

  useLayoutEffect(() => {
    matrixWorldToECEF.copy(frame)
    const targetECEF = ecefScratch.copy(target).applyMatrix4(frame)
    new PointOfView(distance, radians(heading), radians(pitch)).decompose(
      targetECEF,
      camera.position,
      camera.quaternion,
      camera.up
    )
    inverseScratch.copy(frame).invert()
    rotationScratch.setFromRotationMatrix(inverseScratch)
    camera.position.applyMatrix4(inverseScratch)
    camera.quaternion.premultiply(rotationScratch)
    camera.up.applyQuaternion(rotationScratch)
  }, [frame, target, matrixWorldToECEF, camera, heading, pitch, distance])

  // Leaving the ocean must not leave the next story rebased
  useEffect(
    () => () => {
      matrixWorldToECEF.copy(frameScratch.identity())
    },
    [matrixWorldToECEF]
  )

  return target
}

export const GroundTiles: FC<{ ground: Ground }> = ({ ground }) => {
  const materialHandler = useCallback(() => new MeshBasicNodeMaterial(), [])
  return ground.tiles ? <Globe materialHandler={materialHandler} /> : null
}
