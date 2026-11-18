import type { AudioSettings } from '../shared/model.js'

export type Device = Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'kind' | 'label'>
export const specific = (id: string) => Boolean(id && id !== 'default' && id !== 'communications')
export const virtual = (device: Device) => /blackhole|loopback|soundflower|virtual|aggregate|multi.output/i.test(device.label)
export const sameDevice = (left: Device, right: Device) =>
  left.deviceId === right.deviceId || Boolean(left.groupId && left.groupId === right.groupId) ||
  Boolean(left.label && left.label === right.label)

export function requireDevice(devices: Device[], id: string, kind: Device['kind'], name: string) {
  const device = devices.find(item => item.kind === kind && item.deviceId === id)
  if (!specific(id) || !device?.label) throw new Error(name + ' is unavailable. Grant Chrome microphone access and select a specific device.')
  return device
}

export function validateRoute(devices: Device[], settings: AudioSettings) {
  const input = requireDevice(devices, settings.input, 'audioinput', 'Caller input')
  const output = requireDevice(devices, settings.output, 'audiooutput', 'Call output')
  if (!virtual(input) || !virtual(output)) throw new Error('Select two distinct virtual audio devices for the call paths.')
  if (sameDevice(input, output)) throw new Error('Caller input and call output share a device. Select independent BlackHole paths.')
  if (settings.monitor) {
    const monitor = requireDevice(devices, settings.monitor, 'audiooutput', 'Monitoring output')
    if (virtual(monitor) || sameDevice(input, monitor) || sameDevice(output, monitor)) {
      throw new Error('Select physical headphones or speakers for monitoring.')
    }
  }
  return { input, output }
}

export function standardDevices(devices: Device[]) {
  const find = (kind: Device['kind'], name: RegExp) =>
    devices.find(device => specific(device.deviceId) && device.kind === kind && name.test(device.label))?.deviceId || ''
  return { input: find('audioinput', /BlackHole\s*2ch/i), output: find('audiooutput', /BlackHole\s*16ch/i) }
}

export function rms(frame: Float32Array) {
  let sum = 0
  for (const value of frame) sum += value * value
  return Math.sqrt(sum / frame.length)
}
