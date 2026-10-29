export interface DeviceDisposal {
  deviceId: unknown
  destructionCount: number
  loss: Record<string, unknown>
}

export function inspectDeviceDisposal(
  events: Record<string, unknown>[]
): DeviceDisposal | null

export function waitForDeviceDisposal(
  subscribe: (listener: () => void) => () => void,
  events: Record<string, unknown>[],
  timeout?: number
): Promise<DeviceDisposal>

export function sampleStoppedFrames(
  expected: string,
  timeout?: number
): Promise<string[]>
