// The fake device stores every descriptor as plain data. A value reached
// twice without a cycle is data both times: three shares one clearValue
// between two colour attachments, and "[cycle]" there is a pass the browser
// rejects (case shafts-low-sun)

import { log } from '../../test/helpers/log'
import { snapshot } from './fakeGpu'

describe('fakeGpu snapshot', () => {
  it('copies a value shared by two siblings both times', () => {
    const clearValue = { r: 0, g: 0, b: 0, a: 1 }
    const descriptor = {
      colorAttachments: [
        { loadOp: 'clear', clearValue },
        { loadOp: 'clear', clearValue }
      ]
    }
    const out = snapshot(descriptor) as {
      colorAttachments: { clearValue: unknown }[]
    }
    log('shared clearValue', {
      first: JSON.stringify(out.colorAttachments[0]!.clearValue),
      second: JSON.stringify(out.colorAttachments[1]!.clearValue)
    })
    expect(out.colorAttachments[0]!.clearValue).toEqual(clearValue)
    expect(out.colorAttachments[1]!.clearValue).toEqual(clearValue)
  })

  it('still cuts a real cycle', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node['self'] = node
    expect(snapshot(node)).toEqual({ name: 'a', self: '[cycle]' })
  })
})
