// three-ocean-waves' Realistic+ (sun track) surface as the ground of a WebGPU
// clouds story. The ocean keeps its own shading (the lighting mask leaves it
// out of the aerial node's post-lighting), takes its sun from the atmosphere,
// its reflections from the clouds' environment bake, and the cloud shadow
// through cloudsPass.cloudShadowAt. Mounted inside <Clouds>, rebased worlds only

import { useFrame, useThree } from '@react-three/fiber'
import { useAtomValue } from 'jotai'
import { useEffect, useLayoutEffect, useMemo, useState, type FC } from 'react'
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Uint32BufferAttribute
} from 'three'
import { WaterProCloudSky, type CloudsPassNode } from 'three-clouds-webgpu'
import { useClouds } from 'three-clouds-webgpu/r3f'
import {
  defineStyle,
  findWaterPreset,
  OceanWaves,
  type ClipmapOptions,
  type OceanStyle
} from 'three-ocean-waves'
import { realisticGroundswell, realisticPlus } from 'three-ocean-waves/styles'
import {
  float,
  modelWorldMatrix,
  mrt,
  positionGeometry,
  positionWorld,
  vec3,
  vec4
} from 'three/tsl'
import type { Node, NodeBuilder, Renderer } from 'three/webgpu'

import {
  getAtmosphereContext,
  getSplitIlluminance
} from '@takram/three-atmosphere/webgpu'
import { FnVar } from '@takram/three-geospatial/webgpu'

import { WATER_BODIES, waterAtom } from './ground'

// Fine near the camera, where the waves are: the library's 0.5 m centre cells,
// out to 2 km. Displacement fades by e^-0.007 per metre past 150 m, so beyond
// this the sea is flat and FAR_RING carries it cheaply
const NEAR_CLIPMAP: ClipmapOptions = {
  innerCells: 256,
  innerCellSize: 0.5,
  rings: 5,
  ratio: 2,
  ringCells: 64
}
const NEAR_HALF_EXTENT = 2048

// Square annuli doubling from the clipmap's edge to 262 km, 16 cells across
// each. Only the curvature displaces them, so their T-junctions open under
// 2 m at 130 km and under a millimetre at the clipmap
const FAR_RING_COUNT = 7

function createFarRing(): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  const index = new Map<string, number>()
  const vertex = (x: number, z: number): number => {
    const key = `${x},${z}`
    let id = index.get(key)
    if (id == null) {
      id = positions.length / 3
      positions.push(x, 0, z)
      index.set(key, id)
    }
    return id
  }
  for (let ring = 0; ring < FAR_RING_COUNT; ++ring) {
    const inner = NEAR_HALF_EXTENT * 2 ** ring
    const outer = inner * 2
    const cell = inner / 16
    for (let x0 = -outer; x0 < outer; x0 += cell) {
      for (let z0 = -outer; z0 < outer; z0 += cell) {
        const inside =
          x0 >= -inner &&
          x0 + cell <= inner &&
          z0 >= -inner &&
          z0 + cell <= inner
        if (inside) continue
        const a = vertex(x0, z0)
        const b = vertex(x0, z0 + cell)
        const c = vertex(x0 + cell, z0 + cell)
        const d = vertex(x0 + cell, z0)
        // Counter-clockwise seen from +Y, the clipmap's facing
        indices.push(a, b, c, a, c, d)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(new Uint32BufferAttribute(indices, 1))
  return geometry
}

// Mean radius for the curvature drop. A flat sea would sit 5 km above the
// ellipsoid at the far ring's edge and lift the horizon to eye level
const EARTH_RADIUS = 6_371_000

// Direct sunlight on a surface facing the sun, in the units the aerial node
// post-lights with. The atmosphere's LUTs take positions in its own unit
const sunIlluminanceAt = FnVar(
  (positionWorldNode: Node<'vec3'>) => (builder: NodeBuilder) => {
    const ctx = getAtmosphereContext(builder)
    const ecef = ctx.matrixWorldToECEF.mul(vec4(positionWorldNode, 1)).xyz
    const point = ecef
      .mul(ctx.parametersNode.worldToUnit)
      .add(ctx.altitudeCorrectionUnit)
    return getSplitIlluminance(
      point,
      ctx.sunDirectionECEF,
      ctx.sunDirectionECEF
    ).get('direct')
  }
)

const sunDirectionWorld = FnVar(() => (builder: NodeBuilder) => {
  const ctx = getAtmosphereContext(builder)
  return ctx.matrixECEFToWorld
    .mul(vec4(ctx.sunDirectionECEF, 0))
    .xyz.normalize()
})

function realisticPlusUnderClouds(pass: CloudsPassNode): OceanStyle {
  return defineStyle({
    ...realisticPlus,
    id: 'realistic-plus-under-clouds',
    displayName: 'Realistic+ (sun track) under clouds',

    surface(fields, params) {
      // The style multiplies sunColor by π (Godot's LIGHT_COLOR convention)
      const sunColor = sunIlluminanceAt(positionWorld)
        .div(Math.PI)
        .mul(pass.cloudShadowAt(positionWorld))
      const atmosphere = {
        ...fields.atmosphere,
        sunColor,
        sunDirection: sunDirectionWorld()
      }
      const shadowed = new Proxy(fields, {
        get: (target, key) =>
          key === 'atmosphere' ? atmosphere : Reflect.get(target, key)
      })
      return realisticPlus.surface(shadowed, params)
    },

    displacementModifier(offset, params) {
      const base =
        realisticPlus.displacementModifier?.(offset, params) ?? offset
      const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz
      const drop = world.x
        .mul(world.x)
        .add(world.z.mul(world.z))
        .div(2 * EARTH_RADIUS)
      return base.sub(vec3(0, drop, 0))
    },

    spray: () => 'none'
  })
}

export const GroundOcean: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as never)
  const scene = useThree(({ scene }) => scene)
  const { pass, context } = useClouds()
  const [ocean, setOcean] = useState<{
    ocean: OceanWaves
    clipmap: Mesh | null
    far: Mesh
  } | null>(null)

  // The sky and clouds the water reflects: the environment bake, unrolled to
  // the equirect the ocean's PMREM reads. Its texture never changes identity
  useLayoutEffect(() => {
    const previous = context.experimental.cloudEnvironment
    context.experimental = { cloudEnvironment: true }
    return () => {
      context.experimental = { cloudEnvironment: previous }
    }
  }, [context])
  const sky = useMemo(() => new WaterProCloudSky(pass.environment), [pass])
  useEffect(() => () => sky.dispose(), [sky])

  useEffect(() => {
    let cancelled = false
    let created: OceanWaves | null = null
    let farGeometry: BufferGeometry | null = null
    OceanWaves.create(renderer, {
      mapSize: 512,
      clipmap: NEAR_CLIPMAP,
      spray: { enabled: false },
      environment: sky.environmentTexture,
      // The library's Realistic+ Groundswell look, minus its fog: the
      // atmosphere's aerial perspective is the haze here
      style: realisticPlusUnderClouds(pass),
      styleParams: realisticGroundswell.styleParams,
      cascades: realisticGroundswell.cascades,
      onError: error => {
        console.error('[ground ocean]', error)
      }
    })
      .then(result => {
        if (cancelled) {
          result.dispose()
          return
        }
        created = result
        // Merged over the scene pass's MRT: this surface is self-lit
        result.surface.material.mrtNode = mrt({ lit: float(0) })
        result.surface.material.needsUpdate = true
        const clipmap = result.children.find(
          (child): child is Mesh =>
            child instanceof Mesh && child.material === result.surface.material
        )
        farGeometry = createFarRing()
        const far = new Mesh(farGeometry, result.surface.material)
        far.name = 'GroundOceanFarRing'
        result.add(far)
        scene.add(result)
        setOcean({ ocean: result, clipmap: clipmap ?? null, far })
      })
      .catch((error: unknown) => {
        console.error('[ground ocean] create failed', error)
      })
    return () => {
      cancelled = true
      if (created != null) {
        scene.remove(created)
        created.dispose()
        farGeometry?.dispose()
      }
    }
  }, [renderer, scene, pass, sky])

  // Before the composite (priority 1): the equirect converts last frame's
  // bake, the same one-frame lag any reflection map has
  // The Water menu, live: the style's parameters, no rebuild
  const water = useAtomValue(waterAtom)
  useEffect(() => {
    if (ocean == null) return
    const { preset } = WATER_BODIES[water]
    const constituents =
      preset != null ? findWaterPreset(preset)?.constituents : undefined
    ocean.ocean.style.params.setAll(
      constituents != null
        ? {
            chlorophyll: constituents.chlorophyll,
            cdom: constituents.cdom,
            turbidity: constituents.mineral
          }
        : realisticGroundswell.styleParams
    )
  }, [ocean, water])

  // Dev-only handle so a script can check the bake and the ocean
  if (import.meta.env.DEV) {
    ;(window as unknown as { __groundOcean?: unknown }).__groundOcean = {
      sky,
      ocean,
      pass,
      context
    }
  }

  useFrame(({ camera }, delta) => {
    sky.update(renderer)
    if (ocean == null) return
    // update() snaps the clipmap under the camera before its first await, so
    // the far ring can follow it on the same lattice this frame
    void ocean.ocean.update(camera, delta)
    if (ocean.clipmap != null) ocean.far.position.copy(ocean.clipmap.position)
  })

  return null
}
