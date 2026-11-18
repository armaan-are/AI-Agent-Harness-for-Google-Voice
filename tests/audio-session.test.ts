import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import type { IncomingSocketEvent, SessionConfig } from '@elevenlabs/client'
import { audioSchema, planSchema, settingsSchema, type CallRecord, type SessionUpdate } from '../shared/model.js'
import { decodeAudio, encodeAudio } from '../src/audio-codec.js'
import { standardDevices, validateRoute, type Device } from '../src/audio-routing.js'
import { detectProbe, toneStrength } from '../src/diagnostics.js'
import { Session } from '../src/session.js'

const audio = audioSchema.parse({ input: 'rx-in', output: 'tx-out', monitor: 'headphones' })
const routes: Device[] = [
  { deviceId: 'rx-in', groupId: 'rx', kind: 'audioinput', label: 'BlackHole 2ch' },
  { deviceId: 'rx-out', groupId: 'rx', kind: 'audiooutput', label: 'BlackHole 2ch' },
  { deviceId: 'tx-out', groupId: 'tx', kind: 'audiooutput', label: 'BlackHole 16ch' },
  { deviceId: 'headphones', groupId: 'physical', kind: 'audiooutput', label: 'Headphones' },
]

test('selects separate virtual paths and rejects default, missing, same-device and unsafe monitor selections', () => {
  assert.deepEqual(standardDevices(routes), { input: 'rx-in', output: 'tx-out' })
  assert.equal(validateRoute(routes, audio).output.deviceId, 'tx-out')
  assert.throws(() => validateRoute(routes, { ...audio, output: 'rx-out' }), /share a device/)
  assert.throws(() => validateRoute(routes, { ...audio, monitor: 'tx-out' }), /physical/)
  assert.throws(() => validateRoute(routes, { ...audio, input: 'default' }), /unavailable/)
  assert.throws(() => validateRoute(routes.slice(0, 2), audio), /unavailable/)
})

test('round-trips PCM and μ-law and applies input gain', () => {
  const samples = new Float32Array([0, 0.13, -0.12, 0.7, -0.7])
  for (const format of ['pcm', 'ulaw'] as const) {
    const decoded = decodeAudio(encodeAudio(samples, format, 0.5), format)
    assert(decoded.every((sample, index) => Math.abs(sample - samples[index] * 0.5) < 0.02))
  }
})

test('audio worklet downsamples to the negotiated rate and preserves mono channel balance', () => {
  const chunks: Float32Array[] = []
  const port: { onmessage?: (event: { data: number }) => void; postMessage(frame: Float32Array): void } = {
    postMessage: frame => chunks.push(frame.slice()),
  }
  let Processor: new () => { process(input: Float32Array[][]): boolean }
  runInNewContext(readFileSync(new URL('../public/capture-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = port }, sampleRate: 48000,
    registerProcessor: (_: string, next: typeof Processor) => { Processor = next },
  })
  const processor = new Processor!()
  port.onmessage?.({ data: 16000 })
  const left = new Float32Array(128).fill(0.25)
  const right = new Float32Array(128).fill(0.75)
  for (let i = 0; i < 19; i++) processor.process([[left, right]])
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length, 400)
  assert(chunks[1].every(value => Math.abs(value - 0.5) < 0.0001))
})

test('recognizes a delayed four-tone route signature and rejects silence and wrong tone order', () => {
  const length = 1024
  const detected = toneStrength(Float32Array.from({ length }, (_, i) => 0.13 * Math.sin(2 * Math.PI * 967 * i / 48000)), 48000, 967)
  assert(Math.abs(detected - 0.13) < 0.005)
  const start = 1000
  const frames = Array.from({ length: 85 }, (_, index) => {
    const time = 750 + index * 14
    const offset = time - start - 64
    const band = offset >= 0 ? Math.floor(offset / 145) : -1
    const strength = [0, 0, 0, 0].map((_, index) => band === index && offset % 145 < 95 ? 0.13 : 0)
    return { time, strength, rms: 0.07, wave: [] }
  })
  const probe = detectProbe(frames, start)
  assert.equal(probe.hits, 4)
  assert(probe.latency !== null && probe.latency >= 55 && probe.latency <= 80)
  assert.equal(detectProbe([], start).hits, 0)
  assert.equal(detectProbe(frames.map(frame => ({ ...frame, strength: [...frame.strength].reverse() })), start).hits, 0)
})

const selected = 'agent_customer_service'
const settings = settingsSchema.parse({ agents: [{ id: selected, name: 'Support', private: true }], selectedAgent: selected, audio })
const plan = planSchema.parse({
  agentId: selected, direction: 'incoming', label: 'Caller', phone: '', objective: 'Collect refund options',
  instructions: '', context: '', consent: true, confirmed: true, saveTranscript: true,
})
const record = {
  id: 'call_1', direction: plan.direction, label: plan.label, phone: '', objective: plan.objective, agentId: selected,
  startedAt: Date.now(), connectedAt: null, endedAt: null, conversationId: null, duration: 0, status: 'connecting',
  endReason: '', saveTranscript: true, notes: '', summary: null, providerSummary: '', transcript: [],
} satisfies CallRecord

function fixture() {
  let onMessage: (event: IncomingSocketEvent) => void = () => undefined
  let onDisconnect: (details: { reason: 'agent' }) => void = () => undefined
  let input: (chunk: string) => void = () => undefined
  let gated = true
  let connectCount = 0
  let closes = 0
  const actions: string[] = []
  const outbound: object[] = []
  const updates: SessionUpdate[] = []
  const bridge = {
    open: async () => undefined,
    configure: (_: unknown, __: unknown, handler: typeof input) => { input = handler },
    setGate: (value: boolean) => { gated = value; actions.push(value ? 'gate' : 'open') },
    setMute: () => undefined, update: () => undefined,
    play: (audio: string) => { if (!gated) actions.push('play:' + audio) },
    interrupt: () => { actions.push('interrupt') }, startHuman: async () => { actions.push('human open') },
    stopHuman: () => { actions.push('human stop') }, close: () => { gated = true; actions.push('close bridge') },
  }
  const transport = {
    conversationId: 'conv_test', inputFormat: { format: 'pcm', sampleRate: 16000 } as const,
    outputFormat: { format: 'pcm', sampleRate: 24000 } as const,
    close: () => { closes++; actions.push('close socket') },
    sendMessage: (event: object) => { outbound.push(event) },
    onMessage: (handler: typeof onMessage) => { onMessage = handler },
    onDisconnect: (handler: typeof onDisconnect) => { onDisconnect = handler },
    onOutgoingMessage: () => undefined, addListener: () => undefined,
  }
  const deps = {
    reserve: async () => ({ call: record, authorization: { signedUrl: 'wss://example.test/signature' } }),
    cancel: () => { actions.push('cancel') },
    publish: (update: SessionUpdate) => { updates.push(update); return true },
    audio: () => bridge,
    connect: async (options: SessionConfig) => {
      connectCount++
      assert.match(options.overrides?.agent?.prompt?.prompt || '', /Collect refund options/)
      assert.equal(options.connectionType, 'websocket')
      return transport
    },
    update: () => undefined, meter: () => undefined,
  }
  return { deps, transport, actions, outbound, updates,
    emit: (event: unknown) => onMessage(event as IncomingSocketEvent),
    input: (value: string) => { if (!gated) input(value) },
    disconnect: () => onDisconnect({ reason: 'agent' }),
    connections: () => connectCount,
    closes: () => closes,
  }
}

test('starts once, streams live events, interrupts playback, gates audio on hold and stops synchronously', async () => {
  const mock = fixture()
  const engine = new Session(mock.deps)
  await Promise.all([engine.start(plan, settings), engine.start(plan, settings)])
  assert.equal(mock.connections(), 1)
  assert.equal(engine.state.phase, 'active')
  mock.input('outgoing')
  mock.emit({ type: 'ping', ping_event: { event_id: 4, ping_ms: 90 } })
  mock.emit({ type: 'user_transcript', user_transcription_event: { event_id: 1, user_transcript: 'Hello' } })
  mock.emit({ type: 'agent_response', agent_response_event: { event_id: 2, agent_response: 'Good afternoon' } })
  mock.emit({ type: 'agent_response_correction', agent_response_correction_event: { original_agent_response: 'Good afternoon', corrected_agent_response: 'Good' } })
  mock.emit({ type: 'audio', audio_event: { audio_base_64: 'speech', event_id: 2 } })
  mock.emit({ type: 'interruption', interruption_event: { event_id: 3 } })
  mock.emit({ type: 'audio', audio_event: { audio_base_64: 'stale', event_id: 2 } })
  assert.equal(engine.state.transcript.length, 2)
  assert.equal(engine.state.transcript[1].text, 'Good')
  assert.equal(engine.state.providerLatency, 90)
  assert.deepEqual(mock.outbound.slice(0, 2), [{ user_audio_chunk: 'outgoing' }, { type: 'pong', event_id: 4 }])
  assert(mock.actions.includes('play:speech'))
  assert(mock.actions.includes('interrupt'))
  engine.pause()
  mock.input('held')
  mock.emit({ type: 'audio', audio_event: { audio_base_64: 'held', event_id: 4 } })
  await engine.takeover()
  assert.equal(engine.state.takeoverRoute, 'local')
  engine.resume()
  mock.emit({ type: 'audio', audio_event: { audio_base_64: 'stale', event_id: 4 } })
  engine.end('Emergency stop')
  assert.equal(mock.closes(), 1)
  assert.deepEqual(mock.actions.slice(-2), ['close bridge', 'close socket'])
  assert(!mock.actions.some(action => action.startsWith('play:') && action !== 'play:speech'))
  assert.equal(mock.updates.at(-1)?.type, 'ended')
})

test('handles client-tool approval and refuses to approve authentication', async () => {
  const mock = fixture()
  const engine = new Session(mock.deps)
  await engine.start(plan, settings)
  const approval = (action: string) => mock.emit({ type: 'client_tool_call',
    client_tool_call: { tool_name: 'request_human_approval', tool_call_id: 'tool_1', parameters: { action, details: 'Specific terms' } },
  })
  approval('charge')
  assert.equal(engine.state.approval?.details, 'Specific terms')
  engine.decide(true)
  assert.match(JSON.stringify(mock.outbound.at(-1)), /Approved/)
  approval('authentication')
  engine.decide(true)
  assert.match(JSON.stringify(mock.outbound.at(-1)), /Denied/)
  mock.disconnect()
  assert.equal(engine.state.phase, 'ended')
})

test('closes a late ElevenLabs connection after an emergency stop and permits a later explicit start', async () => {
  const mock = fixture()
  let resolveConnect!: (transport: typeof mock.transport) => void
  let started!: () => void
  const connecting = new Promise<void>(resolve => { started = resolve })
  let late = true
  const engine = new Session({ ...mock.deps, connect: async () => {
    if (!late) return mock.transport
    started()
    return new Promise(resolve => { resolveConnect = resolve })
  } })
  const pending = engine.start(plan, settings)
  await connecting
  engine.end('Emergency stop')
  assert.equal(engine.state.phase, 'ended')
  resolveConnect(mock.transport)
  await pending
  assert.equal(mock.closes(), 1)
  assert(!mock.updates.some(event => event.type === 'connected'))
  late = false
  await engine.start(plan, settings)
  assert.equal(engine.state.phase, 'active')
  engine.end()
})
