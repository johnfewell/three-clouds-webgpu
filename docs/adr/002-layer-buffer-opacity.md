# ADR-002 — Layer buffer convention: associated color + OPACITY (takram), not transmittance-alpha

## Context

The cloud march accumulates `radianceIntegral` (rgb) and `transmittanceIntegral` (scalar, 1 → 0). At write-out, the result must be stored in a `vec4` render target. Two conventions exist: transmittance-alpha (`cloud.rgb + dst.rgb * cloud.a` where `.a` = transmittance) and associated/premultiplied color with opacity. The original uses opacity (`clouds.frag:617`): `return vec4(radianceIntegral, remapClamped(transmittanceIntegral, 1.0, minTransmittance))`.

## Decision

The cloud layer target stores per texel:

- `rgb` = associated (premultiplied) radiance — the march's `radianceIntegral` after in-volume aerial perspective.
- `a` = OPACITY = `remapClamped(transmittanceIntegral, 1.0, minTransmittance)` (clear → 0, dense → ~1).

Composite (from `cloudsEffect.frag:8–9`):

```text
out.rgb = dst.rgb * (1.0 - clouds.a) + clouds.rgb
out.a   = dst.a   * (1.0 - clouds.a) + clouds.a
```

Do NOT use `cloud.rgb + dst.rgb * cloud.a` (transmittance-alpha) and do not store transmittance in `.a`.

`remapClamped(x, a, b)` = `clamp((x - a) / (b - a), 0, 1)`.

## Consequences

- `CloudsPassNode.layer` is a `vec4` HalfFloat target; `composite()` bilinear-samples `layer` at full resolution and applies the over operator above.
- Haze blends into the same encoding before write-out.
- The resolve clips history in this space; `varianceClipping` operates on vec4 (rgb + opacity).
- The parity linear readback (ADR-011) is taken after this composite and before tone mapping on both sides.
- `march/writeLayer.ts` and `CloudsPassNode.composite()` cite this ADR and `clouds.frag:617` / `cloudsEffect.frag:8`.

## References

- `reference/clouds/src/shaders/clouds.frag:617`
- `reference/clouds/src/shaders/cloudsEffect.frag:8��9`
- ADR-011 (parity methodology — readback after composite)
