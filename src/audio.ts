import type { FormatConfig } from '@elevenlabs/client'
import type { AudioSettings } from '../shared/model.js'
import { assertFormat, decodeAudio, encodeAudio } from './audio-codec.js'
import { requireDevice, rms, sameDevice, validateRoute, virtual } from './audio-routing.js'

type RoutedContext = AudioContext & {
  setSinkId(id: string | { type: 'none' }): Promise<void>
  addEventListener(type: string, listener: EventListener): void
}

export function makeContext() {
  if (!window.AudioContext || !('setSinkId' in window.AudioContext.prototype)) {
    throw new Error('Use current Google Chrome on localhost for independent audio outputs.')
  }
  return new AudioContext({ latencyHint: 'interactive' }) as RoutedContext
}

export async function capture(id?: string) {
  if (!navigator.mediaDevices) throw new Error('Open VoicePilot in Chrome at http://localhost.')
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, autoGainControl: false, noiseSuppression: false },
    })
  } catch (error) {
    if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
      throw new Error('Chrome microphone access was denied. Allow Microphone for localhost and enable Chrome under macOS Privacy & Security.')
    }
    if (error instanceof DOMException && ['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(error.name)) {
      throw new Error('Chrome could not open the selected input. Check Audio MIDI Setup, then reconnect or reselect the device.')
    }
    throw error
  }
}

export const stopStream = (stream?: MediaStream) => stream?.getTracks().forEach(track => track.stop())

export async function enumerate(ask = false) {
  if (!navigator.mediaDevices) return []
  if (ask) stopStream(await capture())
  return navigator.mediaDevices.enumerateDevices()
}

export type Meter = { input: number; output: number; human: number; wave: number[]; latency: number }
export const emptyMeter: Meter = { input: 0, output: 0, human: 0, wave: [], latency: 0 }

export class AudioBridge {
  private inputContext?: RoutedContext
  private outputContext?: RoutedContext
  private inbound?: MediaStream
  private human?: MediaStream
  private humanSource?: MediaStreamAudioSourceNode
  private humanAnalyser?: AnalyserNode
  private callerAnalyser?: AnalyserNode
  private outputAnalyser?: AnalyserNode
  private speakerGain?: GainNode
  private monitorGain?: GainNode
  private worklet?: AudioWorkletNode
  private sources = new Set<AudioBufferSourceNode>()
  private nextTime = 0
  private inputFormat?: FormatConfig
  private outputFormat?: FormatConfig
  private inputHandler?: (chunk: string) => void
  private inputMuted = false
  private outputMuted = false
  private gated = true
  private disposed = false
  private lastSent = 0
  private timer?: number
  private humanEpoch = 0
  private echoFrames = 0
  private echoHistory: { time: number; bands: number[] }[] = []

  constructor(private settings: AudioSettings, private onMeter: (values: Meter) => void, private onFail: (reason: string) => void) {}

  async open(signal: AbortSignal) {
    signal.throwIfAborted()
    try {
      this.inputContext = makeContext()
      this.outputContext = makeContext()
      const inputContext = this.inputContext
      const outputContext = this.outputContext
      const outputSelection = outputContext.setSinkId(this.settings.output)
      const monitorSelection = inputContext.setSinkId(this.settings.monitor || { type: 'none' })
      await Promise.all([outputSelection, monitorSelection, inputContext.resume(), outputContext.resume()])
      signal.throwIfAborted()
      validateRoute(await enumerate(), this.settings)
      const trackStream = await capture(this.settings.input)
      if (signal.aborted || this.disposed) {
        stopStream(trackStream)
        throw new DOMException('Audio setup cancelled.', 'AbortError')
      }
      this.inbound = trackStream
      trackStream.getAudioTracks()[0].addEventListener('ended', () => this.fail('Caller audio input disconnected.'), { once: true })
      await inputContext.audioWorklet.addModule('/capture-worklet.js')
      signal.throwIfAborted()
      const caller = inputContext.createMediaStreamSource(trackStream)
      const callerAnalyser = this.callerAnalyser = inputContext.createAnalyser()
      callerAnalyser.fftSize = 1024
      caller.connect(callerAnalyser)
      const monitorGain = this.monitorGain = inputContext.createGain()
      monitorGain.gain.value = this.settings.monitorGain
      if (this.settings.monitor) callerAnalyser.connect(monitorGain).connect(inputContext.destination)
      const worklet = this.worklet = new AudioWorkletNode(inputContext, 'voicepilot-capture')
      callerAnalyser.connect(worklet).connect(inputContext.destination)
      worklet.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (!this.gated && !this.inputMuted && this.inputFormat && this.inputHandler) {
          this.inputHandler(encodeAudio(data, this.inputFormat.format, this.settings.inputGain))
        }
      }
      this.speakerGain = outputContext.createGain()
      this.speakerGain.gain.value = 0
      this.outputAnalyser = outputContext.createAnalyser()
      this.outputAnalyser.fftSize = 1024
      this.speakerGain.connect(this.outputAnalyser).connect(outputContext.destination)
      navigator.mediaDevices.addEventListener('devicechange', this.checkDevices)
      inputContext.addEventListener('sinkchange', this.checkDevices)
      outputContext.addEventListener('sinkchange', this.checkDevices)
      for (const context of [inputContext, outputContext]) {
        context.addEventListener('statechange', () => {
          if (!this.disposed && context.state !== 'running') this.fail('Chrome suspended an audio device. Recheck audio settings and restart the AI.')
        })
      }
      this.timer = window.setInterval(this.meter, 50)
    } catch (error) {
      this.close()
      throw error
    }
  }

  configure(input: FormatConfig, output: FormatConfig, handler: (chunk: string) => void) {
    assertFormat(input)
    assertFormat(output)
    this.inputFormat = input
    this.outputFormat = output
    this.inputHandler = handler
    this.worklet?.port.postMessage(input.sampleRate)
  }

  update(settings: Pick<AudioSettings, 'inputGain' | 'outputGain' | 'monitorGain' | 'echoGuard'>) {
    const { inputGain, outputGain, monitorGain, echoGuard } = settings
    this.settings = { ...this.settings, inputGain, outputGain, monitorGain, echoGuard }
    if (this.monitorGain) this.monitorGain.gain.value = monitorGain
    this.applyGate()
  }

  setGate(gated: boolean) {
    this.gated = gated
    this.applyGate()
    if (gated) this.interrupt()
  }

  setMute(input: boolean, output: boolean) {
    this.inputMuted = input
    this.outputMuted = output
    this.applyGate()
    if (output) this.interrupt()
  }

  private applyGate() {
    if (this.speakerGain) this.speakerGain.gain.value = this.gated || this.outputMuted ? 0 : this.settings.outputGain
  }

  play(encoded: string) {
    const context = this.outputContext
    if (this.disposed || this.gated || this.outputMuted || !this.outputFormat || !context || !this.speakerGain) return
    const data = decodeAudio(encoded, this.outputFormat.format)
    if (!data.length || data.length > this.outputFormat.sampleRate * 4) return
    if (this.nextTime - context.currentTime > 8) {
      this.fail('ElevenLabs playback fell too far behind. Start a new AI session.')
      return
    }
    const buffer = context.createBuffer(1, data.length, this.outputFormat.sampleRate)
    buffer.copyToChannel(data, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.speakerGain)
    this.sources.add(source)
    source.onended = () => { source.disconnect(); this.sources.delete(source) }
    const start = Math.max(context.currentTime + 0.035, this.nextTime)
    source.start(start)
    this.nextTime = start + buffer.duration
  }

  interrupt() {
    for (const source of this.sources) {
      source.stop()
      source.disconnect()
    }
    this.sources.clear()
    this.nextTime = 0
  }

  async startHuman() {
    this.setGate(true)
    this.stopHuman()
    const epoch = this.humanEpoch
    const devices = await enumerate()
    const microphone = requireDevice(devices, this.settings.microphone, 'audioinput', 'Takeover microphone')
    const remote = requireDevice(devices, this.settings.input, 'audioinput', 'Caller input')
    if (virtual(microphone) || sameDevice(microphone, remote)) throw new Error('Select a physical microphone for takeover.')
    const stream = await capture(microphone.deviceId)
    if (this.disposed || !this.outputContext || epoch !== this.humanEpoch) {
      stopStream(stream)
      return
    }
    this.human = stream
    stream.getAudioTracks()[0].addEventListener('ended', () => this.fail('Takeover microphone disconnected.'), { once: true })
    this.humanSource = this.outputContext.createMediaStreamSource(stream)
    this.humanAnalyser = this.outputContext.createAnalyser()
    this.humanSource.connect(this.humanAnalyser).connect(this.outputContext.destination)
  }

  stopHuman() {
    this.humanEpoch++
    this.humanSource?.disconnect()
    this.humanAnalyser?.disconnect()
    stopStream(this.human)
    this.humanSource = undefined
    this.humanAnalyser = undefined
    this.human = undefined
  }

  private checkDevices = async () => {
    if (this.disposed) return
    try {
      const devices = await enumerate()
      validateRoute(devices, this.settings)
      if (this.human) requireDevice(devices, this.settings.microphone, 'audioinput', 'Takeover microphone')
      const output = (this.outputContext as (RoutedContext & { sinkId?: unknown }) | undefined)?.sinkId
      if (typeof output === 'string' && output !== this.settings.output) throw new Error('Call output changed.')
    } catch { this.fail('An audio device changed or disconnected. Recheck the Audio Diagnostics page before restarting.') }
  }

  private frame(analyser?: AnalyserNode) {
    if (!analyser) return new Float32Array(1)
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    return data
  }

  private spectrum(analyser: AnalyserNode) {
    const data = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(data)
    const bands = Array.from({ length: 12 }, (_, band) => {
      const start = Math.round((180 + band * 280) * analyser.fftSize / analyser.context.sampleRate)
      const end = Math.round((460 + band * 280) * analyser.fftSize / analyser.context.sampleRate)
      let power = 0
      for (let i = start; i < end; i++) power += 10 ** (data[i] / 10)
      return Math.sqrt(power)
    })
    const norm = Math.hypot(...bands) || 1
    return bands.map(value => value / norm)
  }

  private meter = () => {
    if (this.disposed || !this.callerAnalyser || !this.outputAnalyser) return
    const now = performance.now()
    const caller = this.frame(this.callerAnalyser)
    const input = rms(caller)
    const output = rms(this.frame(this.outputAnalyser))
    if (this.settings.echoGuard && !this.gated) {
      if (output > 0.009) this.echoHistory.push({ time: now, bands: this.spectrum(this.outputAnalyser) })
      this.echoHistory = this.echoHistory.filter(frame => now - frame.time < 300)
      if (input > 0.009 && this.echoHistory.length) {
        const spectrum = this.spectrum(this.callerAnalyser)
        const match = this.echoHistory.some(frame => frame.bands.reduce((score, v, i) => score + v * spectrum[i], 0) > 0.99)
        this.echoFrames = match ? this.echoFrames + 1 : Math.max(0, this.echoFrames - 2)
        if (this.echoFrames >= 14) {
          this.fail('Sustained matching audio detected on both call paths. Check BlackHole routing and use headphones.')
          return
        }
      } else this.echoFrames = Math.max(0, this.echoFrames - 1)
    }
    if (now - this.lastSent < 85) return
    this.lastSent = now
    this.onMeter({
      input, output, human: rms(this.frame(this.humanAnalyser)),
      wave: Array.from({ length: 72 }, (_, i) => caller[Math.floor(i * caller.length / 72)]),
      latency: ((this.outputContext?.baseLatency || 0) + (this.outputContext?.outputLatency || 0)) * 1000,
    })
  }

  private fail(reason: string) {
    if (this.disposed) return
    this.close()
    this.onFail(reason)
  }

  close() {
    if (this.disposed) return
    this.disposed = true
    this.setGate(true)
    this.stopHuman()
    stopStream(this.inbound)
    if (this.worklet) this.worklet.port.onmessage = null
    navigator.mediaDevices?.removeEventListener('devicechange', this.checkDevices)
    window.clearInterval(this.timer)
    for (const context of [this.inputContext, this.outputContext]) {
      if (context && context.state !== 'closed') void context.close().catch(() => undefined)
    }
  }
}
