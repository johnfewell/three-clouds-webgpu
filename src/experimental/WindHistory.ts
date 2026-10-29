// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: CloudsEffect.ts:348-357, clouds.frag:945-950

import { Matrix4, Vector2, Vector3 } from 'three'
import { Fn, uniform } from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { CloudsContext } from '../CloudsContext'

export const previousCloudPosition = Fn(
  ([position, displacement]: [Node<'vec3'>, Node<'vec3'>]) =>
    position.add(displacement)
)

export class WindHistory {
  readonly displacement = uniform(new Vector3()).setName('wind_displacement')
  readonly cloudValid = uniform(false).setName('wind_cloudValid')
  readonly shadowValid = uniform(false).setName('wind_shadowValid')
  private previousTime: number | null = null
  private readonly shape = new Vector3()
  private readonly detail = new Vector3()
  private readonly repeat = new Vector3()
  private readonly detailRepeat = new Vector3()
  private readonly weatherRepeat = new Vector2()
  private readonly worldToECEF = new Matrix4()
  private readonly detailDisplacement = new Vector3()

  reset(): void {
    this.previousTime = null
    this.displacement.value.setScalar(0)
    this.cloudValid.value = false
    this.shadowValid.value = false
  }

  update(ctx: CloudsContext): void {
    const delta = this.previousTime == null ? -1 : ctx.time - this.previousTime
    const valid = delta >= 0 && delta <= 0.5 && this.sameDomain(ctx)
    const displacement = this.displacement.value
    displacement.setScalar(0)
    if (valid) {
      // For r*p + offset, the PREVIOUS position of today's sample is
      // p + (offsetToday - offsetYesterday)/r, not minus that displacement
      displacement
        .copy(ctx.derivedShapeOffset)
        .sub(this.shape)
        .divide(ctx.shapeRepeat)
    }
    this.cloudValid.value =
      valid &&
      displacement.toArray().every(Number.isFinite) &&
      this.compatibleDetail(ctx)
    this.shadowValid.value =
      this.cloudValid.value && displacement.lengthSq() < 1e-12
    if (!this.cloudValid.value) displacement.setScalar(0)
    this.remember(ctx)
  }

  // The weather OFFSET is deliberately absent: a translation this class never
  // compensates, so it can only switch the history off, never make a fetch
  // better (see docs/EXPERIMENTAL.md). Its REPEAT stays: a new tiling is another map
  private sameDomain(ctx: CloudsContext): boolean {
    return (
      this.repeat.equals(ctx.shapeRepeat) &&
      this.detailRepeat.equals(ctx.shapeDetailRepeat) &&
      this.weatherRepeat.equals(ctx.localWeatherRepeat) &&
      this.worldToECEF.equals(ctx.worldToECEFMatrix) &&
      ctx.shapeRepeat
        .toArray()
        .every(value => Number.isFinite(value) && value !== 0)
    )
  }

  private compatibleDetail(ctx: CloudsContext): boolean {
    if (!ctx.shapeDetail) return true
    if (
      !ctx.shapeDetailRepeat
        .toArray()
        .every(value => Number.isFinite(value) && value !== 0)
    )
      return false
    this.detailDisplacement
      .copy(ctx.derivedShapeDetailOffset)
      .sub(this.detail)
      .divide(ctx.shapeDetailRepeat)
    return (
      this.detailDisplacement.distanceToSquared(this.displacement.value) < 1e-8
    )
  }

  private remember(ctx: CloudsContext): void {
    this.previousTime = ctx.time
    this.shape.copy(ctx.derivedShapeOffset)
    this.detail.copy(ctx.derivedShapeDetailOffset)
    this.repeat.copy(ctx.shapeRepeat)
    this.detailRepeat.copy(ctx.shapeDetailRepeat)
    this.weatherRepeat.copy(ctx.localWeatherRepeat)
    this.worldToECEF.copy(ctx.worldToECEFMatrix)
  }
}
