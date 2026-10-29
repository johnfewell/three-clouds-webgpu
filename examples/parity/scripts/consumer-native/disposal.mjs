import { assertHardware, insist } from './proof.mjs'

export function inspectDeviceDisposal(events) {
  const device = assertHardware(events)
  const destroyed = events.filter(event => event.type === 'destroy')
  const lost = events.filter(event => event.type === 'lost')
  insist(destroyed.length <= 1, 'expected exactly one final device destruction')
  insist(
    [...destroyed, ...lost].every(event => event.id === device.id),
    'disposal event does not match the application device'
  )
  insist(
    lost.every(event => event.reason === 'destroyed'),
    'unexpected device loss'
  )
  return destroyed.length === 1 && lost.length > 0
    ? { deviceId: device.id, destructionCount: destroyed.length, loss: lost[0] }
    : null
}

export function waitForDeviceDisposal(subscribe, events, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timer)
      unsubscribe()
      if (error != null) reject(error)
      else resolve(result)
    }
    const check = () => {
      try {
        const result = inspectDeviceDisposal(events)
        if (result != null) finish(null, result)
      } catch (error) {
        finish(error)
      }
    }
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'Consumer native: timed out waiting for application device destruction and destroyed loss'
          )
        ),
      timeout
    )
    const unsubscribe = subscribe(check)
    check()
  })
}

export function sampleStoppedFrames(expected, timeout = 90000) {
  return new Promise((resolve, reject) => {
    if (typeof expected !== 'string' || !/^\d+$/.test(expected)) {
      reject(new Error('missing rendered-frame counter at disposal'))
      return
    }
    const samples = []
    let frameRequest
    const finish = error => {
      clearTimeout(timer)
      cancelAnimationFrame(frameRequest)
      if (error != null) reject(error)
      else resolve(samples)
    }
    const timer = setTimeout(
      () => finish(new Error('timed out observing frames after disposal')),
      timeout
    )
    const check = () => {
      const observed = document.querySelector('#status')?.dataset.frames
      samples.push(observed)
      if (observed !== expected)
        finish(new Error('frames advanced after disposal'))
      else if (samples.length === 3) finish()
      else frameRequest = requestAnimationFrame(check)
    }
    frameRequest = requestAnimationFrame(check)
  })
}
