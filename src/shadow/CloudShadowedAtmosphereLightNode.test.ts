import { describe, expect, it } from 'vitest'

describe('CloudShadowedAtmosphereLightNode', () => {
  it('exports CloudShadowedAtmosphereLightNode class', async () => {
    const mod = await import('./CloudShadowedAtmosphereLightNode')
    expect(mod.CloudShadowedAtmosphereLightNode).toBeDefined()
    expect(typeof mod.CloudShadowedAtmosphereLightNode).toBe('function')
  })

  it('shadowTransmittanceFn defaults to null', async () => {
    const { CloudShadowedAtmosphereLightNode } =
      await import('./CloudShadowedAtmosphereLightNode')
    const node = new CloudShadowedAtmosphereLightNode()
    expect(node.shadowTransmittanceFn).toBeNull()
  })
})
