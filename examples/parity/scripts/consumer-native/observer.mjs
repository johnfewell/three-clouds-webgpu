export const EVENT_PREFIX = 'CLOUDS_NATIVE_OBSERVER '

export function observeDevice(prefix) {
  const emit = event => console.info(prefix + JSON.stringify(event))
  const devices = new WeakMap()
  let nextId = 0
  let nextFetch = 0
  const fetch = globalThis.fetch
  globalThis.fetch = function (...args) {
    const [input, options] = args
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href
    ).href
    const signal =
      options?.signal ?? (input instanceof Request ? input.signal : null)
    const id = ++nextFetch
    emit({ type: 'fetch-start', id, url })
    signal?.addEventListener(
      'abort',
      () => emit({ type: 'fetch-abort', id, url }),
      { once: true }
    )
    const result = fetch.apply(this, args)
    void result.then(
      response => emit({ type: 'fetch-settled', id, url, ok: response.ok }),
      error =>
        emit({
          type: 'fetch-settled',
          id,
          url,
          ok: false,
          error: String(error)
        })
    )
    return result
  }
  if (typeof GPUAdapter === 'undefined') {
    emit({ type: 'unavailable' })
    return
  }
  const requestDevice = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = function (...args) {
    const adapter = this
    const result = requestDevice.apply(adapter, args)
    void result.then(
      device => {
        const id = ++nextId
        devices.set(device, id)
        const info = adapter.info
        emit({
          type: 'device',
          id,
          vendor: info?.vendor,
          architecture: info?.architecture,
          description: info?.description,
          device: info?.device,
          fallback: adapter.isFallbackAdapter ?? info?.isFallbackAdapter
        })
        device.addEventListener('uncapturederror', event =>
          emit({ type: 'gpu-error', id, message: event.error.message })
        )
        void device.lost.then(info =>
          emit({ type: 'lost', id, reason: info.reason, message: info.message })
        )
      },
      error => emit({ type: 'gpu-error', message: String(error) })
    )
    return result
  }
  const configure = GPUCanvasContext.prototype.configure
  GPUCanvasContext.prototype.configure = function (configuration) {
    const result = configure.call(this, configuration)
    emit({
      type: 'canvas',
      device: devices.get(configuration.device),
      width: this.canvas.width,
      height: this.canvas.height
    })
    return result
  }
  const destroy = GPUDevice.prototype.destroy
  GPUDevice.prototype.destroy = function (...args) {
    const result = destroy.apply(this, args)
    emit({ type: 'destroy', id: devices.get(this) })
    return result
  }
}
