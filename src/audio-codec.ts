import type { FormatConfig } from '@elevenlabs/client'

export function assertFormat(format: FormatConfig) {
  if (!['pcm', 'ulaw'].includes(format.format) || !Number.isInteger(format.sampleRate) ||
      format.sampleRate < 8000 || format.sampleRate > 96000) {
    throw new Error('ElevenLabs negotiated an unsupported audio format. Select PCM audio in the agent settings.')
  }
}

function muLaw(value: number) {
  const sign = value < 0 ? 128 : 0
  const magnitude = Math.min(32635, Math.abs(value)) + 132
  const exponent = Math.max(0, 24 - Math.clz32(magnitude))
  const mantissa = (magnitude >> (exponent + 3)) & 15
  return (~(sign | (exponent << 4) | mantissa)) & 255
}

export function encodeAudio(frame: Float32Array, format: FormatConfig['format'], gain: number) {
  const bytes = new Uint8Array(frame.length * (format === 'pcm' ? 2 : 1))
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < frame.length; i++) {
    const sample = Math.round(Math.max(-1, Math.min(1, frame[i] * gain)) * 32767)
    if (format === 'pcm') view.setInt16(i * 2, sample, true)
    else bytes[i] = muLaw(sample)
  }
  return btoa(String.fromCharCode(...bytes))
}

export function decodeAudio(encoded: string, format: FormatConfig['format']) {
  const raw = atob(encoded)
  const frame = new Float32Array(Math.floor(raw.length / (format === 'pcm' ? 2 : 1)))
  for (let i = 0; i < frame.length; i++) {
    if (format === 'pcm') frame[i] = ((raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8)) << 16 >> 16) / 32768
    else {
      const code = (~raw.charCodeAt(i)) & 255
      const magnitude = ((code & 15) * 8 + 132) << ((code >> 4) & 7)
      frame[i] = ((code & 128) ? 132 - magnitude : magnitude - 132) / 32768
    }
  }
  return frame
}
