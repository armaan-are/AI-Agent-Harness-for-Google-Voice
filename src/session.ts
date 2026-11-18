import type { WebSocketConnection, IncomingSocketEvent, SessionConfig } from '@elevenlabs/client'
import { defaultInstructions, type AudioSettings, type CallRecord, type Plan, type SessionStatus, type SessionUpdate, type Settings, type Transcript } from '../shared/model.js'
import { type AudioBridge, type Meter } from './audio.js'

export type Authorization = { signedUrl: string } | { agentId: string }
type Transport = Pick<WebSocketConnection, 'conversationId' | 'inputFormat' | 'outputFormat' | 'close' | 'sendMessage' |
  'onMessage' | 'onDisconnect' | 'onOutgoingMessage' | 'addListener'>
type Bridge = Pick<AudioBridge, 'open' | 'configure' | 'update' | 'setGate' | 'setMute' | 'play' | 'interrupt' | 'startHuman' | 'stopHuman' | 'close'>
export type Approval = { id: string; action: string; details: string; authentication: boolean }
export type LiveState = {
  phase: SessionStatus | 'idle'
  call?: CallRecord
  plan?: Plan
  transcript: Transcript[]
  approval?: Approval
  error: string
  takeoverRoute: 'off' | 'local' | 'manual'
  inputMuted: boolean
  outputMuted: boolean
  providerLatency?: number
  changingAudio?: boolean
}
export const initialLive: LiveState = {
  phase: 'idle', transcript: [], error: '', takeoverRoute: 'off', inputMuted: false, outputMuted: false,
}

type Dependencies = {
  reserve(plan: Plan): Promise<{ call: CallRecord; authorization: Authorization }>
  cancel(): void
  publish(update: SessionUpdate): boolean
  audio(settings: AudioSettings, meter: (value: Meter) => void, fail: (reason: string) => void): Bridge
  connect?: (options: SessionConfig) => Promise<Transport>
  update(state: LiveState): void
  meter(value: Meter): void
}

export class Session {
  state: LiveState = initialLive
  private bridge?: Bridge
  private replacement?: Bridge
  private transport?: Transport
  private controller?: AbortController
  private pauseTimer?: ReturnType<typeof setTimeout>
  private approvalTimer?: ReturnType<typeof setTimeout>
  private startTimer?: ReturnType<typeof setTimeout>
  private pendingReserve = false
  private interruptEvent = -1
  private newestAudio = -1
  private audioCutoff = -1
  private stripTags = (text: string) => text

  constructor(private readonly dependencies: Dependencies) {}

  private update(changes: Partial<LiveState>) {
    this.state = { ...this.state, ...changes }
    this.dependencies.update(this.state)
  }

  async start(plan: Plan, settings: Settings) {
    if (this.controller || this.pendingReserve) return
    const controller = this.controller = new AbortController()
    const signal = controller.signal
    this.interruptEvent = -1
    this.newestAudio = -1
    this.audioCutoff = -1
    this.state = initialLive
    this.update({ phase: 'connecting', plan })
    this.startTimer = setTimeout(() => this.fail('Connection timed out. Check device permissions, agent overrides, and your ElevenLabs connection.'), 30000)
    try {
      const audio = this.bridge = this.dependencies.audio(settings.audio, this.dependencies.meter, this.fail)
      await audio.open(signal)
      signal.throwIfAborted()
      this.pendingReserve = true
      const reservation = await this.dependencies.reserve(plan).finally(() => { this.pendingReserve = false })
      if (signal.aborted) {
        this.dependencies.cancel()
        return
      }
      this.update({ call: reservation.call })
      const agentPrompt = [
        defaultInstructions, settings.instructions === defaultInstructions ? '' : settings.instructions,
        'Call direction: ' + plan.direction, 'Objective: ' + plan.objective, 'Call instructions: ' + plan.instructions,
        'Relevant context: ' + plan.context,
      ].filter(Boolean).join('\n\n')
      let connect = this.dependencies.connect
      if (!connect) {
        const sdk = await import('@elevenlabs/client')
        signal.throwIfAborted()
        this.stripTags = sdk.stripAudioTags
        connect = sdk.WebSocketConnection.create
      }
      const transport = await connect({
        ...reservation.authorization,
        connectionType: 'websocket',
        ...(settings.overrides ? {
          overrides: { agent: {
            prompt: { prompt: agentPrompt },
            ...(settings.greeting ? { firstMessage: settings.greeting } : {}),
          } },
        } : {}),
      })
      if (signal.aborted) {
        transport.close()
        return
      }
      this.transport = transport
      transport.onOutgoingMessage(() => undefined)
      // The SDK also queues audio for its playback adapter. This bridge
      // handles the original events so it can enforce its own output gate.
      transport.addListener(() => undefined)
      transport.onDisconnect(details => {
        if (signal.aborted) return
        if (details.reason === 'error') this.fail('ElevenLabs disconnected. Check the connection, agent configuration, and account limits.')
        else this.end('ElevenLabs ended the session')
      })
      audio.configure(transport.inputFormat, transport.outputFormat, chunk => this.send({ user_audio_chunk: chunk }))
      if (!this.dependencies.publish({ type: 'connected', conversationId: transport.conversationId })) {
        this.fail('Local server disconnected during startup.')
        return
      }
      const call = { ...reservation.call, conversationId: transport.conversationId, connectedAt: Date.now(), status: 'active' as const }
      this.update({ phase: 'active', call })
      if (!settings.overrides) this.send({ type: 'contextual_update', text: agentPrompt })
      audio.setGate(false)
      transport.onMessage(event => {
        if (signal.aborted) return
        try { this.handle(event) } catch { this.fail('ElevenLabs sent an invalid conversation event.') }
      })
      clearTimeout(this.startTimer)
    } catch (error) {
      if (!signal.aborted) this.fail(error instanceof Error && !(error.name === 'SessionConnectionError')
        ? error.message : 'ElevenLabs refused the session. Check agent permissions, override settings, and account limits.')
    }
  }

  private send(message: Parameters<Transport['sendMessage']>[0]) {
    if (!this.transport) return false
    try {
      this.transport.sendMessage(message)
      return true
    } catch {
      this.fail('ElevenLabs connection was lost.')
      return false
    }
  }

  private record(id: string, role: Transcript['role'], text: string) {
    if (!text.trim()) return
    const previous = this.state.transcript.find(row => row.id === id)
    const row = { id, role, text: text.trim().slice(0, 24000), at: previous?.at ?? Date.now() }
    const transcript = previous ? this.state.transcript.map(item => item.id === id ? row : item) : [...this.state.transcript, row]
    this.update({ transcript })
    this.dependencies.publish({ type: 'transcript', row })
  }

  private handle(event: IncomingSocketEvent) {
    switch (event.type) {
      case 'ping':
        this.send({ type: 'pong', event_id: event.ping_event.event_id })
        if (typeof event.ping_event.ping_ms === 'number') this.update({ providerLatency: event.ping_event.ping_ms })
        return
      case 'audio':
        this.newestAudio = Math.max(this.newestAudio, event.audio_event.event_id)
        if (event.audio_event.event_id >= this.interruptEvent && event.audio_event.event_id > this.audioCutoff && this.state.phase === 'active' && !this.state.approval) {
          this.bridge?.play(event.audio_event.audio_base_64)
        }
        return
      case 'interruption':
        this.interruptEvent = event.interruption_event.event_id
        this.bridge?.interrupt()
        return
      case 'user_transcript':
        if (this.state.phase === 'active') this.record('user-' + event.user_transcription_event.event_id, 'user', event.user_transcription_event.user_transcript)
        return
      case 'agent_response': {
        if (this.state.phase !== 'active' || this.state.outputMuted || this.state.approval) return
        const value = event.agent_response_event
        this.record('agent-' + (value.response_id || value.event_id), 'agent', this.stripTags(value.agent_response))
        return
      }
      case 'agent_response_correction': {
        const value = event.agent_response_correction_event
        const previous = [...this.state.transcript].reverse().find(row => row.role === 'agent' && row.text === this.stripTags(value.original_agent_response).trim())
        if (previous) this.record(previous.id, 'agent', this.stripTags(value.corrected_agent_response))
        return
      }
      case 'client_tool_call': {
        const tool = event.client_tool_call
        const action = typeof tool.parameters?.action === 'string' ? tool.parameters.action.trim() : ''
        const details = typeof tool.parameters?.details === 'string' ? tool.parameters.details.trim() : ''
        const authentication = action.toLowerCase() === 'authentication'
        if (tool.tool_name !== 'request_human_approval' || !action || !details || action.length > 160 || details.length > 2000 || this.state.approval || this.state.phase !== 'active') {
          this.send({ type: 'client_tool_result', tool_call_id: tool.tool_call_id, result: 'Denied. Tool unavailable or approval request incomplete.', is_error: true })
          return
        }
        this.bridge?.setGate(true)
        this.update({ approval: { id: tool.tool_call_id, action, details, authentication } })
        this.approvalTimer = setTimeout(() => this.decide(false), 45000)
        return
      }
      case 'error':
        this.fail('ElevenLabs reported a conversation error. Check agent settings and account usage.')
    }
  }

  decide(approved: boolean, keepGated = false) {
    const request = this.state.approval
    if (!request) return
    clearTimeout(this.approvalTimer)
    this.update({ approval: undefined })
    if (!keepGated && this.state.phase === 'active') {
      this.audioCutoff = this.newestAudio
      this.bridge?.setGate(false)
    }
    this.send({
      type: 'client_tool_result', tool_call_id: request.id, is_error: false,
      result: approved && !request.authentication ? 'Approved by the human operator for these exact terms only.' :
        'Denied. Defer this action to the human operator. Never share or solicit credentials.',
    })
  }

  setMute(inputMuted: boolean, outputMuted: boolean) {
    if (!outputMuted && this.state.outputMuted) this.audioCutoff = this.newestAudio
    this.bridge?.setMute(inputMuted, outputMuted)
    this.update({ inputMuted, outputMuted })
  }

  gains(settings: AudioSettings) { this.bridge?.update(settings) }

  message(text: string, contextual: boolean) {
    if (this.state.phase !== 'active' || this.state.approval || !text.trim()) return
    this.send({ type: contextual ? 'contextual_update' : 'user_message', text: text.trim().slice(0, 8000) })
  }

  pause() {
    if (this.state.phase !== 'active' && this.state.phase !== 'takeover') return
    this.bridge?.setGate(true)
    this.bridge?.stopHuman()
    this.decide(false, true)
    if (!this.controller) return
    this.update({ phase: 'paused', takeoverRoute: 'off' })
    this.dependencies.publish({ type: 'paused' })
    this.capPause()
  }

  async takeover() {
    if (!['active', 'paused'].includes(this.state.phase) || !this.bridge || this.state.changingAudio) return
    const audio = this.bridge
    audio.setGate(true)
    this.decide(false, true)
    if (!this.controller) return
    this.update({ phase: 'takeover', takeoverRoute: 'off', error: '' })
    this.dependencies.publish({ type: 'takeover' })
    this.capPause()
    try {
      await audio.startHuman()
      if (this.state.phase === 'takeover' && this.bridge === audio) this.update({ takeoverRoute: 'local' })
    } catch {
      if (this.state.phase === 'takeover' && this.bridge === audio) {
        this.update({ takeoverRoute: 'manual', error: 'Automatic routing unavailable. Switch microphone and speakers in Google Voice.' })
      }
    }
  }

  async changeAudio(settings: AudioSettings) {
    const controller = this.controller
    const transport = this.transport
    if (!controller || !transport || this.replacement || this.state.approval ||
        !['active', 'paused'].includes(this.state.phase)) return
    if (this.state.phase === 'active') this.pause()
    this.update({ changingAudio: true, error: '' })
    const previous = this.bridge
    const audio = this.replacement = this.dependencies.audio(settings, this.dependencies.meter, this.fail)
    try {
      await audio.open(controller.signal)
      controller.signal.throwIfAborted()
      audio.configure(transport.inputFormat, transport.outputFormat, chunk => this.send({ user_audio_chunk: chunk }))
      audio.setMute(this.state.inputMuted, this.state.outputMuted)
      this.bridge = audio
      previous?.close()
      this.update({ changingAudio: false })
    } catch (error) {
      audio.close()
      if (!controller.signal.aborted) this.update({ changingAudio: false, error: 'Audio devices could not be changed. Previous route remains paused. ' +
        (error instanceof Error ? error.message : '') })
    } finally {
      if (this.replacement === audio) this.replacement = undefined
    }
  }

  private capPause() {
    clearTimeout(this.pauseTimer)
    this.pauseTimer = setTimeout(() => this.end('Pause or takeover exceeded two minutes'), 120000)
  }

  resume() {
    if (!['paused', 'takeover'].includes(this.state.phase) || !this.transport || this.state.changingAudio) return
    clearTimeout(this.pauseTimer)
    this.bridge?.stopHuman()
    this.audioCutoff = this.newestAudio
    this.bridge?.setGate(false)
    this.update({ phase: 'active', takeoverRoute: 'off', error: '' })
    this.dependencies.publish({ type: 'active' })
  }

  fail = (reason: string) => { this.end(reason); this.update({ error: reason }) }

  end(reason = 'Ended by operator') {
    if (!this.controller) return
    this.bridge?.close()
    this.replacement?.close()
    this.replacement = undefined
    this.controller.abort()
    this.controller = undefined
    const transport = this.transport
    this.transport = undefined
    this.bridge = undefined
    clearTimeout(this.pauseTimer)
    clearTimeout(this.approvalTimer)
    clearTimeout(this.startTimer)
    try { transport?.close() } catch { /* Audio is already gated. */ }
    if (this.state.call) this.dependencies.publish({ type: 'ended', reason: reason.slice(0, 160) })
    else if (this.pendingReserve) this.dependencies.cancel()
    const call = this.state.call && { ...this.state.call, endedAt: Date.now(), status: 'ended' as const }
    this.update({ phase: 'ended', call, approval: undefined, takeoverRoute: 'off', changingAudio: false })
  }
}
