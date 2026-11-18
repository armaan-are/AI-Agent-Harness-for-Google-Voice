import { capture, makeContext, stopStream } from './audio.js'
import { rms } from './audio-routing.js'

export type Probe = {
  success: boolean; leaked: boolean; latency: number | null; inputRate: number; outputRate: number
  peak: number; received: number; cross: number; wave: number[]
}
type Frame = { time: number; strength: number[]; rms: number; wave: number[] }
const frequencies = [659, 967, 1327, 1777]

export function toneStrength(samples: Float32Array, rate: number, frequency: number) {
  const step = 2 * Math.PI * frequency / rate
  let real = 0
  let imaginary = 0
  for (let i = 0; i < samples.length; i++) {
    const weighted = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (samples.length - 1)))
    real += weighted * Math.cos(i * step)
    imaginary += weighted * Math.sin(i * step)
  }
  return 4 * Math.hypot(real, imaginary) / samples.length
}

export function detectProbe(frames: Frame[], started: number) {
  const ambient = frames.filter(frame => frame.time < started).map(frame => Math.max(...frame.strength))
  const floor = Math.max(0.003, (ambient.length ? Math.max(...ambient) : 0) * 2.5)
  for (let delay = -25; delay <= 750; delay += 5) {
    const hits = frequencies.filter((_, index) => frames.some(frame => {
      const relative = frame.time - started - delay - index * 145
      return relative >= 15 && relative <= 80 && frame.strength[index] > floor &&
        frame.strength[index] > 0.6 * frame.rms &&
        frame.strength[index] > Math.max(...frame.strength.filter((_, band) => band !== index)) * 2.5
    })).length
    if (hits === frequencies.length) {
      const first = frames.find(frame => frame.time >= started - 25 && frame.strength[0] > floor &&
        frame.strength[0] > 0.6 * frame.rms && frame.strength[0] > Math.max(...frame.strength.slice(1)) * 2.5)
      return { hits, latency: Math.max(0, Math.round((first?.time ?? started + delay) - started)) }
    }
  }
  return { hits: 0, latency: null }
}

export async function probe(inputId: string, outputId: string, otherInputId: string, signal: AbortSignal): Promise<Probe> {
  const read = makeContext()
  let write: ReturnType<typeof makeContext> | undefined
  const streams: MediaStream[] = []
  try {
    const output = write = makeContext()
    await Promise.all([read.setSinkId({ type: 'none' }), output.setSinkId(outputId), read.resume(), output.resume()])
    signal.throwIfAborted()
    const attach = async (id: string) => {
      const stream = await capture(id)
      streams.push(stream)
      signal.throwIfAborted()
      const analyser = read.createAnalyser()
      analyser.fftSize = 1024
      read.createMediaStreamSource(stream).connect(analyser).connect(read.destination)
      return analyser
    }
    const input = await attach(inputId)
    const other = otherInputId ? await attach(otherInputId) : undefined
    const startAudio = output.currentTime + 0.24
    const start = performance.now() + 240
    for (const [index, frequency] of frequencies.entries()) {
      const oscillator = output.createOscillator()
      oscillator.frequency.value = frequency
      const gate = output.createGain()
      const at = startAudio + index * 0.145
      gate.gain.setValueAtTime(0, at)
      gate.gain.linearRampToValueAtTime(0.13, at + 0.009)
      gate.gain.setValueAtTime(0.13, at + 0.085)
      gate.gain.linearRampToValueAtTime(0, at + 0.099)
      oscillator.connect(gate).connect(output.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.1)
    }
    const sample = (analyser: AnalyserNode): Frame => {
      const data = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(data)
      return { time: performance.now(), strength: frequencies.map(frequency => toneStrength(data, read.sampleRate, frequency)),
        rms: rms(data), wave: Array.from({ length: 72 }, (_, i) => data[Math.floor(i * data.length / 72)]) }
    }
    const frames: Frame[] = []
    const crossFrames: Frame[] = []
    while (performance.now() - start < 1380) {
      signal.throwIfAborted()
      if (streams.some(stream => !stream.active)) throw new Error('A diagnostic input disconnected.')
      frames.push(sample(input))
      if (other) crossFrames.push(sample(other))
      await new Promise(resolve => setTimeout(resolve, 14))
    }
    const received = detectProbe(frames, start)
    const cross = detectProbe(crossFrames, start)
    const strongest = frames.reduce((left, right) => left.rms > right.rms ? left : right)
    return { success: received.hits === frequencies.length, leaked: cross.hits === frequencies.length,
      latency: received.latency, inputRate: streams[0].getAudioTracks()[0].getSettings().sampleRate || read.sampleRate,
      outputRate: output.sampleRate, wave: strongest.wave, peak: strongest.rms, received: received.hits, cross: cross.hits }
  } finally {
    streams.forEach(stopStream)
    await Promise.allSettled([read.close(), write?.close()])
  }
}

export async function listen(id: string, update: (level: number, wave: number[]) => void, signal: AbortSignal) {
  const context = makeContext()
  let stream: MediaStream | undefined
  try {
    await Promise.all([context.setSinkId({ type: 'none' }), context.resume()])
    signal.throwIfAborted()
    stream = await capture(id)
    signal.throwIfAborted()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser).connect(context.destination)
    const data = new Float32Array(analyser.fftSize)
    while (!signal.aborted && stream.active) {
      analyser.getFloatTimeDomainData(data)
      update(rms(data), Array.from({ length: 72 }, (_, i) => data[Math.floor(i * data.length / 72)]))
      await new Promise(resolve => setTimeout(resolve, 70))
    }
    if (!signal.aborted) throw new Error('Input device disconnected.')
  } finally {
    stopStream(stream)
    await context.close()
  }
}

export async function playTestTone(id: string, signal: AbortSignal) {
  const output = makeContext()
  try {
    await Promise.all([output.setSinkId(id), output.resume()])
    signal.throwIfAborted()
    const oscillator = output.createOscillator()
    const gain = output.createGain()
    oscillator.frequency.value = 700
    gain.gain.value = 0.08
    oscillator.connect(gain).connect(output.destination)
    oscillator.start()
    oscillator.stop(output.currentTime + 0.45)
    await new Promise<void>(resolve => {
      oscillator.onended = () => resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  } finally {
    await output.close()
  }
}
