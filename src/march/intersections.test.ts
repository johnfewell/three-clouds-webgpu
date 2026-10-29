import { describe, expect, it } from 'vitest'

// CPU twin of the GLSL formulas, independent of @takram/three-geospatial
// so the test validates the algorithm independent of the TSL graph

function logTable(label: string, rows: Record<string, string | number>[]) {
  console.log(`\n[intersections] ${label}`)
  if (rows.length === 0) return
  const keys = Object.keys(rows[0]!)
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k]).length))
  )
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join(' | ')
  console.log(header)
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'))
  for (const row of rows) {
    console.log(
      keys.map((k, i) => String(row[k]).padEnd(widths[i]!)).join(' | ')
    )
  }
}

// CPU twin: ray-sphere math

function vec3Dot(
  a: [number, number, number],
  b: [number, number, number]
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function vec3Length(v: [number, number, number]): number {
  return Math.sqrt(vec3Dot(v, v))
}

// clouds.frag:718–722
function cpuRayIntersectsGround(
  cameraPosition: [number, number, number],
  rayDirection: [number, number, number],
  bottomRadius: number
): boolean {
  const r = vec3Length(cameraPosition)
  const mu = vec3Dot(cameraPosition, rayDirection) / r
  return mu < 0 && r * r * (mu * mu - 1) + bottomRadius * bottomRadius >= 0
}

// Scalar ray-sphere intersection → [near, far] or [-1, -1] on miss
function raySphereIntersection(
  origin: [number, number, number],
  direction: [number, number, number],
  radius: number
): [number, number] {
  const b = vec3Dot(direction, origin)
  const c = vec3Dot(origin, origin) - radius * radius
  const disc = b * b - c
  if (disc < 0) return [-1, -1]
  const Q = Math.sqrt(disc)
  return [-b - Q, -b + Q]
}

interface CpuIntersections {
  ground: boolean
  first: [number, number, number, number]
  second: [number, number, number, number]
}

// clouds.frag:730–741
function cpuGetIntersections(
  cameraPosition: [number, number, number],
  rayDirection: [number, number, number],
  bottomRadius: number,
  minHeight: number,
  maxHeight: number,
  shadowTopHeight: number
): CpuIntersections {
  const ground = cpuRayIntersectsGround(
    cameraPosition,
    rayDirection,
    bottomRadius
  )
  const radii = [
    bottomRadius,
    bottomRadius + minHeight,
    bottomRadius + maxHeight,
    bottomRadius + shadowTopHeight
  ]
  const first: [number, number, number, number] = [0, 0, 0, 0]
  const second: [number, number, number, number] = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    const [near, far] = raySphereIntersection(
      cameraPosition,
      rayDirection,
      radii[i]!
    )
    first[i] = near
    second[i] = far
  }
  return { ground, first, second }
}

// clouds.frag:743–769
function cpuGetRayNearFar(
  intersections: CpuIntersections,
  cameraHeight: number,
  cameraNear: number,
  minHeight: number,
  maxHeight: number,
  maxRayDistance: number
): [number, number] {
  const { ground, first, second } = intersections
  if (cameraHeight < minHeight) {
    if (ground) return [-1, -1]
    return [second[1], Math.min(second[2], maxRayDistance)]
  } else if (cameraHeight < maxHeight) {
    if (ground) return [cameraNear, first[1]]
    return [cameraNear, second[2]]
  } else {
    const nearFar: [number, number] = [first[2], second[2]]
    if (ground) nearFar[1] = first[1]
    return nearFar
  }
}

// Test constants

// Metres
const BOTTOM_RADIUS = 6360000
const MIN_HEIGHT = 750
const MAX_HEIGHT = 1400
const SHADOW_TOP_HEIGHT = 8000
const CAMERA_NEAR = 0.1
const MAX_RAY_DISTANCE = 80000

function cameraAt(altitude: number): [number, number, number] {
  return [0, BOTTOM_RADIUS + altitude, 0]
}

const DOWN: [number, number, number] = [0, -1, 0]
const UP: [number, number, number] = [0, 1, 0]
const HORIZONTAL: [number, number, number] = [1, 0, 0]

function normalize(v: [number, number, number]): [number, number, number] {
  const len = vec3Length(v)
  return [v[0] / len, v[1] / len, v[2] / len]
}

describe('rayIntersectsGround', () => {
  it('looking down from above ground → true', () => {
    const cam = cameraAt(1000)
    expect(cpuRayIntersectsGround(cam, DOWN, BOTTOM_RADIUS)).toBe(true)
    logTable('ground hit (down from 1km)', [
      { camera: '1km above', direction: 'down', result: 'true' }
    ])
  })

  it('looking up from above ground → false', () => {
    const cam = cameraAt(1000)
    expect(cpuRayIntersectsGround(cam, UP, BOTTOM_RADIUS)).toBe(false)
  })

  it('looking horizontal from surface → false (tangent)', () => {
    const cam = cameraAt(0)
    expect(cpuRayIntersectsGround(cam, HORIZONTAL, BOTTOM_RADIUS)).toBe(false)
  })

  it('looking slightly down from near surface → true', () => {
    const cam = cameraAt(10)
    const dir = normalize([1, -0.01, 0])
    expect(cpuRayIntersectsGround(cam, dir, BOTTOM_RADIUS)).toBe(true)
  })
})

describe('getIntersections', () => {
  it('camera 8km above deck — four spheres hit', () => {
    const cam = cameraAt(8000)
    const dir = DOWN
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )

    expect(inter.ground).toBe(true)

    logTable('8km altitude, looking down', [
      {
        sphere: 'ground',
        near: inter.first[0].toFixed(2),
        far: inter.second[0].toFixed(2)
      },
      {
        sphere: 'minH',
        near: inter.first[1].toFixed(2),
        far: inter.second[1].toFixed(2)
      },
      {
        sphere: 'maxH',
        near: inter.first[2].toFixed(2),
        far: inter.second[2].toFixed(2)
      },
      {
        sphere: 'shadow',
        near: inter.first[3].toFixed(2),
        far: inter.second[3].toFixed(2)
      }
    ])

    // Camera is at bottomRadius + 8000, looking straight down
    // Ground sphere (radius = bottomRadius): near should be close to 8000
    expect(inter.first[0]).toBeCloseTo(8000, -1)
    // minHeight sphere (radius = bottomRadius + 750): near = 8000 - 750 = 7250
    expect(inter.first[1]).toBeCloseTo(7250, -1)
    // maxHeight sphere (radius = bottomRadius + 1400): near = 8000 - 1400 = 6600
    expect(inter.first[2]).toBeCloseTo(6600, -1)
    // shadowTop sphere (radius = bottomRadius + 8000): near = 0 (camera is on this sphere)
    expect(inter.first[3]).toBeCloseTo(0, -1)
  })

  it('camera below clouds — spheres above', () => {
    const cam = cameraAt(500)
    const dir = UP
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )

    expect(inter.ground).toBe(false)
    // Looking up: ground sphere miss (looking away)
    expect(inter.first[0]).toBeLessThan(0)
    // minHeight sphere: far should be at altitude 750, so distance = 250
    expect(inter.second[1]).toBeCloseTo(250, -1)
  })
})

describe('getRayNearFar — three camera regimes', () => {
  it('below clouds, no ground hit → second.y to second.z', () => {
    const cam = cameraAt(500)
    const dir = normalize([1, 0.3, 0])
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )
    const [near, far] = cpuGetRayNearFar(
      inter,
      500,
      CAMERA_NEAR,
      MIN_HEIGHT,
      MAX_HEIGHT,
      MAX_RAY_DISTANCE
    )

    logTable('below clouds, no ground', [
      { near: near.toFixed(2), far: far.toFixed(2), regime: 'below' }
    ])

    expect(near).toBeGreaterThan(0)
    expect(far).toBeGreaterThan(near)
    expect(far).toBeLessThanOrEqual(MAX_RAY_DISTANCE)
  })

  it('below clouds, ground hit → vec2(-1)', () => {
    const cam = cameraAt(500)
    const dir = normalize([1, -0.5, 0])
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )

    if (!inter.ground) {
      // At 500m looking steeply down this should hit
      expect.fail('Expected ground hit')
    }
    const [near, far] = cpuGetRayNearFar(
      inter,
      500,
      CAMERA_NEAR,
      MIN_HEIGHT,
      MAX_HEIGHT,
      MAX_RAY_DISTANCE
    )

    logTable('below clouds, ground hit', [
      { near: near.toFixed(2), far: far.toFixed(2), regime: 'below-ground' }
    ])
    expect(near).toBe(-1)
    expect(far).toBe(-1)
  })

  it('inside clouds, no ground hit → cameraNear to second.z', () => {
    const cam = cameraAt(1000)
    const dir = UP
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )
    const [near, far] = cpuGetRayNearFar(
      inter,
      1000,
      CAMERA_NEAR,
      MIN_HEIGHT,
      MAX_HEIGHT,
      MAX_RAY_DISTANCE
    )

    logTable('inside clouds, up', [
      { near: near.toFixed(4), far: far.toFixed(2), regime: 'inside' }
    ])

    expect(near).toBeCloseTo(CAMERA_NEAR, 4)
    expect(far).toBeGreaterThan(0)
  })

  it('inside clouds, ground hit → cameraNear to first.y', () => {
    const cam = cameraAt(1000)
    const dir = DOWN
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )
    const [near, far] = cpuGetRayNearFar(
      inter,
      1000,
      CAMERA_NEAR,
      MIN_HEIGHT,
      MAX_HEIGHT,
      MAX_RAY_DISTANCE
    )

    logTable('inside clouds, down', [
      { near: near.toFixed(4), far: far.toFixed(2), regime: 'inside-ground' }
    ])

    expect(near).toBeCloseTo(CAMERA_NEAR, 4)
    expect(far).toBeGreaterThan(0)
    // Far should be at minHeight sphere = distance from 1000 to 750 = 250
    expect(far).toBeCloseTo(250, -1)
  })

  it('above clouds → first.z to second.z', () => {
    const cam = cameraAt(5000)
    const dir = DOWN
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )
    const [near, far] = cpuGetRayNearFar(
      inter,
      5000,
      CAMERA_NEAR,
      MIN_HEIGHT,
      MAX_HEIGHT,
      MAX_RAY_DISTANCE
    )

    logTable('above clouds, down', [
      { near: near.toFixed(2), far: far.toFixed(2), regime: 'above' }
    ])

    expect(near).toBeGreaterThan(0)
    // near should be at maxHeight sphere distance = 5000 - 1400 = 3600
    expect(near).toBeCloseTo(3600, -1)
    // ground hit → far clamped to first.y (minHeight sphere near)
    // far = first.y ≈ 5000 - 750 = 4250
    expect(far).toBeCloseTo(4250, -1)
  })

  it('above clouds, no ground hit (looking up) → near > 0 only if shell hit', () => {
    const cam = cameraAt(5000)
    const dir = UP
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      MIN_HEIGHT,
      MAX_HEIGHT,
      SHADOW_TOP_HEIGHT
    )
    const [near, far] = cpuGetRayNearFar(
      inter,
      5000,
      CAMERA_NEAR,
      MIN_HEIGHT,
      MAX_HEIGHT,
      MAX_RAY_DISTANCE
    )

    logTable('above clouds, up', [
      { near: near.toFixed(2), far: far.toFixed(2), regime: 'above-up' }
    ])
    // Looking up from above clouds: maxHeight sphere miss → first.z < 0
    expect(near).toBeLessThan(0)
  })
})

describe('reported below-layer geometries', () => {
  // A camera below EVERY layer, looking at the horizon. The regime is
  // `cameraHeight < minHeight`, and the interval must be a real march. It runs
  // to ~180 km, past MAX_RAY_DISTANCE above, hence the preset's 2e5
  const BELOW_MAX_RAY_DISTANCE = 2e5
  const ROWS = [
    { cameraAltitude: 400, minHeight: 1500, maxHeight: 3000, pitch: 0.06 },
    { cameraAltitude: 2397, minHeight: 3000, maxHeight: 4200, pitch: 0.02 },
    { cameraAltitude: 2397, minHeight: 4600, maxHeight: 5500, pitch: 0.02 }
  ] as const

  it('every row is below its layer and gets a non-empty march interval', () => {
    for (const row of ROWS) {
      const cam = cameraAt(row.cameraAltitude)
      const dir = normalize([1, row.pitch, 0])
      const inter = cpuGetIntersections(
        cam,
        dir,
        BOTTOM_RADIUS,
        row.minHeight,
        row.maxHeight,
        row.maxHeight
      )
      const [near, far] = cpuGetRayNearFar(
        inter,
        row.cameraAltitude,
        CAMERA_NEAR,
        row.minHeight,
        row.maxHeight,
        BELOW_MAX_RAY_DISTANCE
      )

      logTable(`cam ${row.cameraAltitude} m below layer ${row.minHeight}`, [
        {
          cameraAltitude: String(row.cameraAltitude),
          layerMin: String(row.minHeight),
          layerMax: String(row.maxHeight),
          belowLayer: String(row.cameraAltitude < row.minHeight),
          ground: String(inter.ground),
          near: near.toFixed(1),
          far: far.toFixed(1)
        }
      ])

      expect(row.cameraAltitude).toBeLessThan(row.minHeight)
      expect(inter.ground, 'horizon-grazing must not hit the ground').toBe(
        false
      )
      // A zero ray would make the march empty, which is the reported symptom
      expect(near).toBeGreaterThan(0)
      expect(far).toBeGreaterThan(near)
    }
  })

  it('the interval comes from the shell crossings, not from a zeroed ray', () => {
    const row = ROWS[0]
    const cam = cameraAt(row.cameraAltitude)
    const dir = normalize([1, row.pitch, 0])
    const inter = cpuGetIntersections(
      cam,
      dir,
      BOTTOM_RADIUS,
      row.minHeight,
      row.maxHeight,
      row.maxHeight
    )
    const [near, far] = cpuGetRayNearFar(
      inter,
      row.cameraAltitude,
      CAMERA_NEAR,
      row.minHeight,
      row.maxHeight,
      BELOW_MAX_RAY_DISTANCE
    )

    logTable('below layer: interval source', [
      {
        near: near.toFixed(1),
        secondY: inter.second[1].toFixed(1),
        far: far.toFixed(1),
        secondZ: inter.second[2].toFixed(1),
        capped: String(
          far === Math.min(inter.second[2], BELOW_MAX_RAY_DISTANCE)
        )
      }
    ])

    // clouds.frag:743-769, the below-minHeight non-ground arm
    expect(near).toBeCloseTo(inter.second[1], 6)
    expect(far).toBeCloseTo(
      Math.min(inter.second[2], BELOW_MAX_RAY_DISTANCE),
      6
    )
  })
})

describe('WGSL compilation', () => {
  it('getRayNearFar compiles to WGSL', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { createContextStub } = await import('../../test/helpers/contextStub')
    const {
      float: tslFloat,
      vec4: tslVec4,
      bool: tslBool
    } = await import('three/tsl')
    const { getRayNearFar } = await import('./intersections')
    const { contextNode } = createContextStub()

    const ground = tslBool(false)
    const first = tslVec4(0, 100, 200, 300)
    const second = tslVec4(1000, 900, 800, 700)
    const cameraHeight = tslFloat(1000)
    const cameraNear = tslFloat(0.1)
    const minHeight = tslFloat(750)
    const maxHeight = tslFloat(1400)
    const maxRayDistance = tslFloat(80000)

    const result = getRayNearFar(
      ground,
      first,
      second,
      cameraHeight,
      cameraNear,
      minHeight,
      maxHeight,
      maxRayDistance
    )

    const { fragment } = compileWGSL(result, { contextNode })
    expect(fragment).toContain('if')
    expect(fragment).toContain('vec2')
    logTable('WGSL compilation', [
      { check: 'compiled', result: 'yes' },
      { check: 'contains if', result: String(fragment.includes('if')) },
      { check: 'fragment length', result: String(fragment.length) }
    ])
  })
})

describe('near/far inputs that are not vars', () => {
  // Every altitude branch reads ground/first/second. Three r186 declares a
  // plain node in the first branch that uses it, so each function declares
  // its inputs itself and a caller that passes plain nodes cannot regress
  it('are declared in a block that encloses every read', async () => {
    const { Vector4 } = await import('three')
    const { uniform } = await import('three/tsl')
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { createContextStub } = await import('../../test/helpers/contextStub')
    const { readsOutsideAssigningBlock, varsAssigned } =
      await import('../../test/helpers/branchScope')
    const { getHazeRayNearFar, getRayNearFar, getShadowRayNearFar } =
      await import('./intersections')
    const { contextNode } = createContextStub()

    const inputs = () => {
      const ground = uniform(0).setName('rnfGround').greaterThan(0.5)
      const first = uniform(new Vector4()).setName('rnfFirst').mul(2)
      const second = uniform(new Vector4()).setName('rnfSecond').mul(3)
      const height = uniform(0).setName('rnfHeight')
      return { ground, first, second, height }
    }
    const builds = {
      getRayNearFar: () => {
        const i = inputs()
        return getRayNearFar(
          i.ground,
          i.first,
          i.second,
          i.height,
          uniform(0.1),
          uniform(750),
          uniform(1400),
          uniform(80000)
        )
      },
      getShadowRayNearFar: () => {
        const i = inputs()
        return getShadowRayNearFar(
          i.ground,
          i.first,
          i.second,
          i.height,
          uniform(0.1),
          uniform(3000),
          uniform(80000)
        )
      },
      getHazeRayNearFar: () => {
        const i = inputs()
        return getHazeRayNearFar(
          i.ground,
          i.first,
          i.second,
          i.height,
          uniform(0.1),
          uniform(1400)
        )
      }
    }

    const rows = Object.entries(builds).map(([fn, build]) => {
      const { fragment } = compileWGSL(build(), { contextNode })
      const names = varsAssigned(fragment, /rnf(Ground|First|Second)/)
      const outside = names.flatMap(n =>
        readsOutsideAssigningBlock(fragment, n)
      )
      return { fn, vars: names.length, outside: outside.length }
    })
    logTable('near/far input scope', rows)
    for (const row of rows) {
      expect(row.vars, `${row.fn} declares its three inputs`).toBe(3)
      expect(row.outside, `${row.fn} orphan reads`).toBe(0)
    }
  })
})
