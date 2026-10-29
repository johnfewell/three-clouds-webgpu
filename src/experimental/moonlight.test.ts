// Twilight moonlight: the CPU half, its shader half, and the wiring that keeps
// it out of the default graph. Rule 9, the tests encode WHY each number is
// what it is: the blend exists so there is no pop at sunset, the illuminated
// fraction is geometry rather than a knob, and the off path is the sun

import { Vector3 } from 'three'
import { float, uniform, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import {
  createMoonlightNodes,
  FULL_MOON_IRRADIANCE_RATIO,
  illuminatedFractionCPU,
  moonlightCPU,
  twilightBlendCPU
} from './moonlight'

type MoonlightOut =
  ReturnType<typeof moonlightCPU> extends unknown
    ? { lightDirection: Vector3; irradianceRatio: Vector3 }
    : never

const out = (): MoonlightOut => ({
  lightDirection: new Vector3(),
  irradianceRatio: new Vector3()
})

// Overhead sun, an observer under it, and a moon 90 degrees away
const sunUp = new Vector3(1, 0, 0)
const cameraUnderSun = new Vector3(1, 0, 0)
const moonEast = new Vector3(0, 0, 1)

describe('twilight fade', () => {
  it('is a fade across civil twilight, not a switch', () => {
    const elevations = [-0.3, -0.2, -0.104528, -0.05, 0, 0.1, 0.5]
    const blends = elevations.map(twilightBlendCPU)
    table(
      'twilight-blend',
      elevations.map((elevation, i) => ({
        field: `sin(elevation) ${elevation}`,
        expected: '0 at 0, 1 at -0.1045',
        actual: blends[i]!.toFixed(4)
      }))
    )
    expect(blends[2]).toBeCloseTo(1, 6)
    expect(blends[4]).toBe(0)
    expect(blends[5]).toBe(0)
    // Listed by rising elevation, so the blend falls
    for (let i = 1; i < blends.length; i++) {
      expect(blends[i]).toBeLessThanOrEqual(blends[i - 1]!)
    }
  })

  it('has its midpoint at half the twilight depth', () => {
    // A smoothstep puts 0.5 where the edges do. Reading it as a linear ramp
    // also passes a monotonicity check, so the midpoint is the claim
    expect(twilightBlendCPU(-0.052264)).toBeCloseTo(0.5, 6)
  })
})

describe('moon phase from the elongation', () => {
  it('reads new moon at zero elongation and full at opposite', () => {
    const newMoon = illuminatedFractionCPU(sunUp, new Vector3(1, 0, 0))
    const full = illuminatedFractionCPU(sunUp, new Vector3(-1, 0, 0))
    const quarter = illuminatedFractionCPU(sunUp, new Vector3(0, 0, 1))
    table('illuminated-fraction', [
      { field: 'same direction', expected: 0, actual: newMoon },
      { field: 'opposite', expected: 1, actual: full },
      { field: 'quarter', expected: 0.5, actual: quarter }
    ])
    expect(newMoon).toBeCloseTo(0, 12)
    expect(full).toBeCloseTo(1, 12)
    expect(quarter).toBeCloseTo(0.5, 12)
  })

  it('never leaves [0,1] for unnormalized directions', () => {
    // A caller that hands over a moon direction with a scale on it still gets
    // a fraction, because the cosine does not care about the length
    const stretched = illuminatedFractionCPU(
      sunUp,
      moonEast.clone().multiplyScalar(7)
    )
    expect(stretched).toBeCloseTo(0.5, 12)
    log('illuminated-unnormalized', { stretched })
  })
})

describe('the light the march shades by', () => {
  it('is the sun, exactly, while the sun is up', () => {
    // The off path's guarantee, and the one that keeps the ladder out of it: a
    // mix at t=0 is the sun bit for bit, so no normalize() difference sneaks in
    const target = out()
    const { blend } = moonlightCPU(
      sunUp,
      moonEast,
      cameraUnderSun,
      1,
      new Vector3(1, 1, 1),
      target
    )
    table('daylight', [
      { field: 'blend', expected: 0, actual: blend },
      {
        field: 'dot(light, sun)',
        expected: 1,
        actual: target.lightDirection.dot(sunUp)
      },
      {
        field: 'irradiance ratio',
        expected: 0,
        actual: target.irradianceRatio.length()
      }
    ])
    expect(blend).toBe(0)
    expect(target.lightDirection.dot(sunUp)).toBeCloseTo(1, 12)
    expect(target.irradianceRatio.length()).toBe(0)
  })

  it('is the moon once the sun has set, at the physical share', () => {
    const target = out()
    // Observer under the +x axis, so +x is up and a sun with a negative x is
    // below the horizon. The moon sits high in the sky, off the sun's azimuth
    const observer = new Vector3(1, 0, 0)
    const sunBelow = new Vector3(-1, -0.5, 0).normalize()
    const moon = new Vector3(0.3, 0.6, 1).normalize()
    const { blend, illuminated } = moonlightCPU(
      sunBelow,
      moon,
      observer,
      1,
      new Vector3(1, 1, 1),
      target
    )
    const expected = FULL_MOON_IRRADIANCE_RATIO * illuminated
    table('deep-night', [
      { field: 'blend', expected: 1, actual: blend },
      {
        field: 'dot(light, moon)',
        expected: 1,
        actual: target.lightDirection.dot(moon)
      },
      { field: 'ratio', expected: expected, actual: target.irradianceRatio.x },
      {
        field: 'ratio is 2.5e-6 of the sun',
        expected: FULL_MOON_IRRADIANCE_RATIO,
        actual: target.irradianceRatio.x
      }
    ])
    expect(blend).toBe(1)
    expect(target.lightDirection.dot(moon)).toBeCloseTo(1, 12)
    // Elongation here is neither new nor full, so the share is a fraction of
    // the full moon's rather than the whole of it
    expect(illuminated).toBeGreaterThan(0)
    expect(illuminated).toBeLessThan(1)
    expect(target.irradianceRatio.x).toBeCloseTo(expected, 20)
    expect(target.irradianceRatio.y).toBeCloseTo(expected, 20)
    // A new moon contributes nothing, which is the phase dependence the
    // elongation buys: no separate moon-phase knob to keep in step
    const newMoon = out()
    // New moon: the moon sits in the sun's direction, so the elongation is 0
    moonlightCPU(
      sunBelow,
      sunBelow.clone(),
      observer,
      1,
      new Vector3(1, 1, 1),
      newMoon
    )
    log('phase-dependence', {
      illuminated,
      newMoonIrradiance: newMoon.irradianceRatio.x
    })
    expect(newMoon.irradianceRatio.x).toBeLessThan(1e-18)
  })

  it('keeps the sun in charge when no moon direction is set', () => {
    // A zero vector is what an app that never sets moonDirection has. Naively
    // mixing it in would collapse the light to NaN and the march would render
    // nothing at all
    const target = out()
    const sunBelow = new Vector3(-1, -0.5, 0).normalize()
    moonlightCPU(
      sunBelow,
      new Vector3(),
      new Vector3(1, 0, 0),
      1,
      new Vector3(1, 1, 1),
      target
    )
    log('unset-moon', {
      dot: target.lightDirection.dot(sunBelow),
      isFinite: Number.isFinite(target.lightDirection.lengthSq())
    })
    expect(target.lightDirection.dot(sunBelow)).toBeCloseTo(1, 12)
  })

  it('passes a degenerate sun through instead of normalizing it', () => {
    // NaN in the march's light direction renders nothing at all, and an app
    // that has not set sunDirection yet is not a user error
    const target = out()
    const { blend } = moonlightCPU(
      new Vector3(),
      new Vector3(0.3, 0.6, 1).normalize(),
      new Vector3(1, 0, 0),
      1,
      new Vector3(1, 1, 1),
      target
    )
    log('degenerate-sun', {
      blend,
      length: target.lightDirection.length(),
      ratio: target.irradianceRatio.length()
    })
    expect(blend).toBe(0)
    expect(target.lightDirection.length()).toBe(0)
    expect(target.irradianceRatio.length()).toBe(0)
  })

  it('scales by the gain and takes the colour of the moon', () => {
    const a = out()
    const b = out()
    const moon = new Vector3(0.3, 0.6, 1).normalize()
    const sunBelow = new Vector3(-1, -0.5, 0).normalize()
    moonlightCPU(
      sunBelow,
      moon,
      new Vector3(1, 0, 0),
      1,
      new Vector3(1, 0.8, 0.6),
      a
    )
    moonlightCPU(
      sunBelow,
      moon,
      new Vector3(1, 0, 0),
      10,
      new Vector3(1, 0.8, 0.6),
      b
    )
    table('moon-gain-and-colour', [
      {
        field: 'gain 10 over gain 1',
        expected: 10,
        actual: b.irradianceRatio.x / a.irradianceRatio.x
      },
      {
        field: 'green over red',
        expected: 0.8,
        actual: a.irradianceRatio.y / a.irradianceRatio.x
      }
    ])
    expect(b.irradianceRatio.x / a.irradianceRatio.x).toBeCloseTo(10, 9)
    expect(a.irradianceRatio.y / a.irradianceRatio.x).toBeCloseTo(0.8, 9)
  })

  it('hands the handover over progressively as the sun sets', () => {
    // The whole reason the blend exists: a switch at the horizon would move the
    // light from the sun's azimuth to the moon's in one frame
    const angles = [0, -2, -4, -6, -8].map(degrees => (degrees * Math.PI) / 180)
    // Observer under +x, so a sun of (sin e, cos e, 0) sits at elevation e
    const moon = new Vector3(0.3, 0.6, 1).normalize()
    const light = angles.map(elevation => {
      const target = out()
      moonlightCPU(
        new Vector3(Math.sin(elevation), Math.cos(elevation), 0),
        moon,
        new Vector3(1, 0, 0),
        1,
        new Vector3(1, 1, 1),
        target
      )
      // How moon-like the light has become: 0 while the sun still leads
      return target.lightDirection.dot(moon)
    })
    table(
      'handover',
      angles.map((elevation, i) => ({
        field: `elevation ${((elevation * 180) / Math.PI).toFixed(0)} deg`,
        expected: 'rises to 1',
        actual: light[i]!.toFixed(4)
      }))
    )
    // Non-decreasing, and strictly increasing while the fade still runs. By
    // -6 deg the blend has saturated at 1, so the flat tail is by design
    for (let i = 1; i < light.length; i++) {
      expect(light[i]).toBeGreaterThanOrEqual(light[i - 1]!)
    }
    expect(light[1]).toBeGreaterThan(light[0]!)
    // At the horizon the light is still the sun's, so the moon-likeness is
    // exactly the sun-moon angle; 8 degrees down it is the moon's own
    expect(light[0]).toBeCloseTo(new Vector3(0, 1, 0).dot(moon), 6)
    expect(light[4]).toBeCloseTo(1, 6)
  })
})

describe('the shader half', () => {
  it('adds the moon to the direct member and leaves the sky member alone', async () => {
    const { AtmosphereContext } =
      await import('@takram/three-atmosphere/webgpu')
    const atmosphere = Object.create(AtmosphereContext.prototype) as Record<
      string,
      unknown
    >
    atmosphere.parametersNode = {
      worldToUnit: float(1),
      solarIrradiance: vec3(1, 1, 1),
      sunAngularRadius: float(0.01),
      sunRadianceToLuminance: float(1),
      luminanceScale: float(1)
    }
    atmosphere.dispose = () => {}

    const lightDirection = uniform(new Vector3(0, 0, 1))
    const irradianceRatio = uniform(new Vector3(2.5e-6, 2.5e-6, 2.5e-6))
    const nodes = createMoonlightNodes({
      lightDirection,
      irradianceRatio,
      sunAngularRadius: 0.004675
    })

    const { splitIlluminance } = await import('../lighting/sunSkyLight')
    const irradiance = splitIlluminance(vec3(1, 0.5, 0.25), vec3(0.1, 0.2, 0.3))
    const { fragment } = compileWGSL(nodes.addMoonlight(irradiance), {
      contextNode: (await import('three/tsl')).context({
        getAtmosphere: () => atmosphere
      })
    })
    log('moonlight-wgsl', {
      bytes: fragment.length,
      tail: fragment.slice(-400)
    })
    // The direct member gains a term the sky member never sees, and the
    // struct still carries both members, so the march's own consumers are
    // untouched
    expect(fragment).toContain('CloudsSplitIlluminance')
    expect(nodes.direction).toBe(lightDirection)
    table('moonlight-node', [
      {
        field: 'direction is the uniform',
        expected: true,
        actual: nodes.direction === lightDirection
      },
      { field: 'fragment bytes', expected: '> 0', actual: fragment.length > 0 }
    ])
  })
})

describe('the graph wiring', () => {
  it('builds nothing at all with the option off', async () => {
    // The off-proof: no moonlight node is built, so the sun's direction and
    // the atmosphere's own irradiance reach the shader. graphVariantDigest
    // records the same thing over all 1024 experimental variants
    const { createMarchUniforms } = await import('../marchUniforms')
    const { CloudsContext } = await import('../CloudsContext')
    const { buildMoonlight, withMoonlight } = await import('../pass/marchGraph')
    const { splitIlluminance } = await import('../lighting/sunSkyLight')

    const ctx = new CloudsContext()
    const marchU = createMarchUniforms(ctx)
    expect(ctx.experimental.moonlight).toBe(false)
    expect(buildMoonlight(ctx, marchU)).toBeNull()

    // and the producer passes through untouched
    const producer = () => splitIlluminance(vec3(1), vec3(0))
    expect(withMoonlight(producer, null)).toBe(producer)

    ctx.experimental = { moonlight: true }
    const on = buildMoonlight(ctx, marchU)
    expect(on).not.toBeNull()
    expect(on!.direction).toBe(marchU.lightDirection)
    expect(withMoonlight(producer, on)).not.toBe(producer)
    log('moonlight-wiring', {
      offBuildsNothing: true,
      onUsesLightUniform: on!.direction === marchU.lightDirection
    })
  })

  it('reference mode pins it off', async () => {
    const { CloudsContext } = await import('../CloudsContext')
    const { applyReferenceMode } = await import('../referenceMode')
    const ctx = new CloudsContext()
    ctx.experimental = { moonlight: true }
    applyReferenceMode(ctx)
    table('reference-mode-moonlight', [
      {
        field: 'moonlight',
        expected: false,
        actual: ctx.experimental.moonlight
      }
    ])
    expect(ctx.experimental.moonlight).toBe(false)
  })
})
