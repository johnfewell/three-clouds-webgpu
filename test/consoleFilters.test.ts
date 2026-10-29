import { describe, expect, it } from 'vitest'

import {
  countTslRenameNotices,
  isTslRenameNotice
} from './helpers/consoleFilters'

describe('test-log filter for TSL rename notices', () => {
  it('matches the exact notice three prints', () => {
    expect(
      isTslRenameNotice(
        "THREE.TSL: Declaration name 'stbn' of 'float' already in use. Renamed to 'stbn_1'.\nStack trace not available."
      )
    ).toBe(true)
    expect(
      isTslRenameNotice(
        "THREE.TSL: Declaration name 'cloudTypeW0_weather' of 'float' already in use. Renamed to 'cloudTypeW0_weather_1'."
      )
    ).toBe(true)
  })

  it('lets every other warning and error through', () => {
    for (const log of [
      'THREE.TSL: Member "x" not found in struct "Y"',
      "THREE.TSL: Declaration name 'stbn' of 'float' is invalid",
      'THREE.WebGPURenderer: some other warning',
      'GPUValidationError: bind group layout mismatch',
      'AssertionError: expected 1 to be 2'
    ]) {
      expect(isTslRenameNotice(log)).toBe(false)
    }
  })
  it('counts every notice in one buffered call', () => {
    const one =
      "THREE.TSL: Declaration name 'stbn' of 'float' already in use. Renamed to 'stbn_1'."
    expect(countTslRenameNotices(`${one}\n${one}\n${one}`)).toBe(3)
    expect(countTslRenameNotices('nothing here')).toBe(0)
  })
})
