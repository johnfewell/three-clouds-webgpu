import { describe, expect, it } from 'vitest'

import { sitePath } from './sitePath'

describe('sitePath', () => {
  it('keeps public files inside a project deployment path', () => {
    expect(sitePath('/api/grid-data.json', '/three-clouds-webgpu/')).toBe(
      '/three-clouds-webgpu/api/grid-data.json'
    )
  })

  it('supports Vite relative-base builds', () => {
    expect(sitePath('/assets/local_weather.png', './')).toBe(
      './assets/local_weather.png'
    )
  })
})
