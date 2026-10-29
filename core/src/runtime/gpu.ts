// The slice of the WebGPU API the runtime calls, typed structurally so the
// core needs no @webgpu/types. Descriptors pass through as plain data

type Descriptor = Record<string, unknown>

export interface GpuTexture {
  createView(descriptor?: unknown): unknown
  destroy(): void
}

export type GpuBuffer = object
export type GpuBindGroup = object
export type GpuBindGroupLayout = object

export interface GpuPipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout
}

export interface GpuPass {
  setPipeline(pipeline: GpuPipeline): void
  setBindGroup(index: number, group: GpuBindGroup): void
  setVertexBuffer(
    slot: number,
    buffer: GpuBuffer,
    offset?: number,
    size?: number
  ): void
  setIndexBuffer(
    buffer: GpuBuffer,
    format: string,
    offset?: number,
    size?: number
  ): void
  draw(
    vertices: number,
    instances?: number,
    first?: number,
    base?: number
  ): void
  drawIndexed(
    indices: number,
    instances?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number
  ): void
  dispatchWorkgroups(x: number, y?: number, z?: number): void
  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number
  ): void
  setScissorRect(x: number, y: number, width: number, height: number): void
  end(): void
}

export interface GpuCommandEncoder {
  beginRenderPass(descriptor: Descriptor): GpuPass
  beginComputePass(descriptor?: Descriptor): GpuPass
  finish(): unknown
}

export interface GpuDevice {
  createTexture(descriptor: Descriptor): GpuTexture
  createSampler(descriptor: Descriptor): object
  createBuffer(descriptor: Descriptor): GpuBuffer
  createShaderModule(descriptor: Descriptor): object
  createBindGroupLayout(descriptor: Descriptor): GpuBindGroupLayout
  createPipelineLayout(descriptor: Descriptor): object
  createRenderPipeline(descriptor: Descriptor): GpuPipeline
  createComputePipeline(descriptor: Descriptor): GpuPipeline
  createBindGroup(descriptor: Descriptor): GpuBindGroup
  createCommandEncoder(): GpuCommandEncoder
  queue: {
    writeBuffer(buffer: GpuBuffer, offset: number, data: Uint8Array): void
    submit(commands: unknown[]): void
  }
}
