import { float, Fn, vec4 } from 'three/tsl'
import { expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'

it('retains appended function side effects', () => {
  const { fragment } = compileWGSL(
    Fn(() => {
      const value = float(0).toVar()
      Fn(() => {
        value.addAssign(0.12345)
      }, 'void')()
      return vec4(value)
    })()
  )
  expect(fragment).toContain('0.12345')
  log('explicit void side effects', { bytes: fragment.length })
})
