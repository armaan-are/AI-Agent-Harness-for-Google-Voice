class VoicePilotCapture extends AudioWorkletProcessor {
  targetRate = sampleRate
  fraction = 0
  integral = 0
  index = 0
  frame = new Float32Array(Math.round(sampleRate / 40))

  constructor() {
    super()
    this.port.onmessage = ({ data }) => {
      if (!Number.isFinite(data) || data < 8000 || data > 96000) return
      this.targetRate = data
      this.fraction = 0
      this.integral = 0
      this.index = 0
      this.frame = new Float32Array(Math.round(data / 40))
    }
  }

  process(inputs) {
    const channels = inputs[0]
    if (!channels?.[0]) return true
    const left = channels[0]
    const right = channels[1]
    const step = this.targetRate / sampleRate
    for (let i = 0; i < left.length; i++) {
      const sample = right ? (left[i] + right[i]) / 2 : left[i]
      let remaining = step
      // Integrate each source sample over the target sample window. This
      // smooths downsampling, and also handles fractional hardware rates.
      while (this.fraction + remaining >= 1) {
        const portion = 1 - this.fraction
        this.frame[this.index++] = this.integral + sample * portion
        if (this.index === this.frame.length) {
          this.port.postMessage(this.frame, [this.frame.buffer])
          this.frame = new Float32Array(this.frame.length || Math.round(this.targetRate / 40))
          this.index = 0
        }
        remaining -= portion
        this.fraction = 0
        this.integral = 0
      }
      this.integral += sample * remaining
      this.fraction += remaining
    }
    return true
  }
}

registerProcessor('voicepilot-capture', VoicePilotCapture)
