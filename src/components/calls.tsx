import { useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, AudioLines, Bell, CircleStop, Clipboard, ExternalLink, Headphones, Mic, MicOff, Pause, Play, Radio, Send, ShieldAlert, Volume2, VolumeX } from 'lucide-react'
import { googleVoice, type Transcript } from '../../shared/model.js'
import { clock, liveSession, routeKey, usePilot } from '../context.js'
import { Button, Card, Check, Field, Level, Notice, Status, Wave } from './ui.js'
import { AudioFields } from './devices.js'

export function VoiceLink({ primary = false }: { primary?: boolean }) {
  return <Button asChild variant={primary ? 'primary' : 'secondary'}>
    <a href={googleVoice} target="_blank" rel="noreferrer">Open Google Voice <ExternalLink size={14} /></a>
  </Button>
}

export function CallForm({ direction }: { direction: 'incoming' | 'outgoing' }) {
  const pilot = usePilot()
  const { draft, setDraft, settings, armed, possibleAudio, go, flash } = pilot
  const active = liveSession(pilot.live)
  const incoming = direction === 'incoming'
  const [error, setError] = useState('')
  const set = <K extends keyof typeof draft,>(key: K, value: typeof draft[K]) =>
    setDraft(previous => ({ ...previous, direction, [key]: value }))
  const agent = draft.agentId || settings.selectedAgent
  return <div className="page-stack">
    <header className="page-heading"><div><h1>{incoming ? 'Incoming Calls' : 'Outgoing Calls'}</h1>
      <p>{incoming ? 'Answer in Google Voice, then hand the conversation to your agent.' : 'Prepare your agent, then place the call in Google Voice.'}</p></div><VoiceLink /></header>
    {active && <Notice>A VoicePilot session is already in progress. <button className="text-button" onClick={() => go('active')}>View Active Call</button></Notice>}
    {error && <Notice danger>{error}</Notice>}
    <div className="content-grid">
      <Card title="Call details" icon={incoming ? <ArrowDownLeft /> : <ArrowUpRight />}>
        <fieldset className="stack" disabled={active}>
          <div className="field-grid">
            <Field label={incoming ? 'Caller label' : 'Destination name'}><input maxLength={120} placeholder={incoming ? 'Caller name' : 'Customer service'} value={draft.label} onChange={e => set('label', e.target.value)} /></Field>
            <Field label="Phone number"><div className="input-action"><input type="tel" maxLength={40} placeholder="+1 (555) 014-2000" value={draft.phone} onChange={e => set('phone', e.target.value)} />
              <Button aria-label="Copy phone number" title="Copy phone number" disabled={!draft.phone} onClick={() => void navigator.clipboard.writeText(draft.phone).then(() => flash('Number copied'), () => flash('Clipboard access was denied.'))}><Clipboard size={16} /></Button>
            </div></Field>
          </div>
          <Field label="Agent"><select value={agent} onChange={e => set('agentId', e.target.value)}>
            <option value="">Select an agent</option>{settings.agents.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select></Field>
          {!settings.agents.length && <button className="text-button" onClick={() => go('agents')}>Add an ElevenLabs agent</button>}
          <Field label="Objective"><textarea rows={3} maxLength={4000} placeholder="Ask about a refund for a delayed order." value={draft.objective} onChange={e => set('objective', e.target.value)} /></Field>
          <Field label="Call instructions"><textarea rows={4} maxLength={16000} placeholder="Ask for written confirmation of any resolution." value={draft.instructions} onChange={e => set('instructions', e.target.value)} /></Field>
          <Field label="Additional context"><textarea rows={2} maxLength={8000} value={draft.context} onChange={e => set('context', e.target.value)} /></Field>
        </fieldset>
      </Card>
      <div className="stack">
        {incoming && <Card title="Incoming standby" icon={<Bell />}>
          <div className="stack"><Status tone={draft.confirmed ? 'good' : possibleAudio ? 'warn' : armed ? 'good' : 'neutral'}>
            {draft.confirmed ? 'Call manually confirmed' : possibleAudio ? 'Possible call audio detected' : armed ? 'Waiting for call' : 'Standby off'}
          </Status>
          <p className="muted">Standby listens for signal on the caller route. A ringtone or other sound does not establish that a call is connected.</p>
          <Button disabled={active} onClick={() => {
            setError('')
            if (armed) pilot.disarm()
            else void pilot.arm().catch(error => setError(error.message))
          }}>{armed ? 'Disarm Agent' : 'Arm Agent'}</Button></div>
        </Card>}
        <Card title={incoming ? 'Answer and connect' : 'Dial and connect'} icon={<Radio />}>
          <div className="stack">
            <ol className="steps-list">
              <li>Open Google Voice and {incoming ? 'answer the caller' : 'dial the number'} manually.</li>
              <li>Wait for the call to connect and check the routing in Google Voice.</li>
              <li>Give the required notice and confirm the call below.</li>
            </ol>
            <Check value={draft.confirmed} disabled={active} onChange={value => set('confirmed', value)}>The Google Voice call is connected.</Check>
            <Check value={draft.consent} disabled={active} onChange={value => set('consent', value)}>I disclosed AI participation and obtained any required consent for sending speech to ElevenLabs and processing a transcript.</Check>
            {settings.transcriptStorage && <Check value={draft.saveTranscript} disabled={active} onChange={value => set('saveTranscript', value)}>Save the transcript and summary on this Mac.</Check>}
            <Button variant="primary" disabled={active || !draft.confirmed || !draft.consent || !agent} onClick={pilot.start}><Play size={16} /> Start AI Agent</Button>
            <small className="muted">VoicePilot stores session details locally. It does not save raw audio.</small>
          </div>
        </Card>
      </div>
    </div>
  </div>
}

export function TranscriptList({ rows, live = false }: { rows: Transcript[]; live?: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { if (live && end.current) end.current.parentElement?.scrollTo({ top: end.current.offsetTop }) }, [rows, live])
  if (!rows.length) return <div className="empty"><AudioLines size={25} /><p>{live ? 'Transcript will appear as the conversation progresses.' : 'No transcript saved.'}</p></div>
  return <div className="messages" role={live ? 'log' : undefined} aria-label="Conversation transcript">
    {rows.map(row => <div className={'message ' + row.role} key={row.id}>
      <div className="message-avatar">{row.role === 'agent' ? <AudioLines size={15} /> : <Mic size={14} />}</div>
      <div className="message-body"><div><strong>{row.role === 'agent' ? 'AI Agent' : 'Caller'}</strong><time>{new Date(row.at).toLocaleTimeString()}</time></div><p>{row.text}</p></div>
    </div>)}
    <div ref={end} />
  </div>
}

export function ActiveCall() {
  const { live, engine, settings, meter, evidence, draft, go, start } = usePilot()
  const [now, setNow] = useState(Date.now())
  const [text, setText] = useState('')
  const [gains, setGains] = useState(settings.audio)
  const [humanVerified, setHumanVerified] = useState(false)
  const [changeDevices, setChangeDevices] = useState(false)
  const [devicesChanged, setDevicesChanged] = useState(false)
  const active = liveSession(live)
  const routeVerified = !devicesChanged && evidence.key === routeKey(settings) && evidence.receive && evidence.send
  const connected = live.phase === 'active'
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active])
  useEffect(() => { if (live.phase !== 'takeover') setHumanVerified(false) }, [live.phase])
  useEffect(() => {
    if (live.phase === 'connecting' || live.phase === 'idle') {
      setDevicesChanged(false)
      setChangeDevices(false)
      setGains(settings.audio)
    }
  }, [live.phase, settings.audio])
  const plan = live.plan
  const label = plan?.label || (plan?.direction === 'incoming' ? 'Incoming caller' : plan ? 'Outgoing call' : 'Active Call')
  const elapsed = live.call?.connectedAt ? ((live.call.endedAt ?? now) - live.call.connectedAt) / 1000 : 0
  const mode = live.phase === 'idle' ? 'Ready when connected' : live.phase === 'ended' ? 'Session ended' : live.phase === 'connecting'
    ? 'Agent connecting' : live.phase === 'takeover' ? 'Human takeover' : live.phase === 'paused' ? 'Agent paused'
      : live.approval ? 'Approval required' : meter.output > 0.006 ? 'Agent speaking' : 'Agent listening'
  return <div className="page-stack">
    <header className="page-heading"><div><h1>{label}</h1><p>{plan ? [plan.direction === 'incoming' ? 'Incoming call' : 'Outgoing call', plan.phone].filter(Boolean).join(' · ') : 'Control a Google Voice call from VoicePilot.'}</p></div>
      <div className="row"><Status tone={connected ? 'good' : live.phase === 'connecting' ? 'warn' : 'neutral'}>{mode}</Status><span className="clock">{clock(elapsed)}</span></div>
    </header>
    {live.error && <Notice danger>{live.error}</Notice>}
    <div className="content-grid">
      <div className="stack">
        <Card title="Live audio" icon={<AudioLines />} action={<Status tone={routeVerified ? 'good' : 'neutral'}>{routeVerified ? 'Local paths verified' : 'Local paths unverified'}</Status>}>
          <Wave data={active ? meter.wave : []} height={148} />
          <div className="meter-grid">
            <Level label="Caller input" value={active ? meter.input : 0} />
            <Level label="AI output" value={active ? meter.output : 0} />
            {live.phase === 'takeover' && <Level label="Your microphone" value={meter.human} />}
          </div>
          <p className="meta muted">{[meter.latency && active ? Math.round(meter.latency) + ' ms local output latency' : '', live.providerLatency && active ? live.providerLatency + ' ms ElevenLabs ping' : '', live.call?.conversationId].filter(Boolean).join(' · ')}</p>
        </Card>
        <Card title="Conversation transcript" icon={<Radio />} action={live.transcript.length > 0 ? <span className="muted small">{live.transcript.length} turns</span> : undefined}>
          <TranscriptList rows={live.transcript} live={active} />
        </Card>
        <Card className="call-controls">
          <div className="row wrap">
            {!active && <Button variant="primary" onClick={draft.confirmed && draft.consent ? start : () => go(draft.direction)}><Play size={16} />{draft.confirmed && draft.consent ? 'Start Agent' : 'Prepare a Call'}</Button>}
            {connected && <Button onClick={() => engine.pause()}><Pause size={16} /> Pause Agent</Button>}
            {['paused', 'takeover'].includes(live.phase) && <Button variant="primary" disabled={live.changingAudio} onClick={() => {
              if ((devicesChanged || live.takeoverRoute === 'manual') && !window.confirm('Do the microphone and speaker settings in Google Voice match the current VoicePilot routes?')) return
              engine.resume()
            }}><Play size={16} /> Resume Agent</Button>}
            <Button disabled={live.changingAudio || !['active', 'paused'].includes(live.phase)} onClick={() => void engine.takeover()}><Headphones size={16} /> Take Over</Button>
            <Button disabled={!active || live.phase === 'connecting'} onClick={() => engine.setMute(!live.inputMuted, live.outputMuted)}>{live.inputMuted ? <MicOff size={16} /> : <Mic size={16} />}{live.inputMuted ? 'Unmute Input' : 'Mute Input'}</Button>
            <Button disabled={!active || live.phase === 'connecting'} onClick={() => engine.setMute(live.inputMuted, !live.outputMuted)}>{live.outputMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}{live.outputMuted ? 'Unmute Output' : 'Mute Output'}</Button>
            <Button disabled={!active} onClick={() => engine.end()}><CircleStop size={16} /> End AI Session</Button>
            <Button variant="danger" disabled={!active} onClick={() => engine.end('Emergency stop')}><ShieldAlert size={16} /> Emergency Stop</Button>
          </div>
        </Card>
        {live.phase === 'takeover' && <Notice>
          {live.takeoverRoute === 'local' ? <>
            <p>{humanVerified ? 'You confirmed the caller can hear you.' : 'Your microphone is routed toward Google Voice. Ask the caller to confirm they can hear you.'}</p>
            <Check value={humanVerified} onChange={setHumanVerified}>The caller confirmed they can hear me.</Check>
          </> : <p>{live.takeoverRoute === 'manual' ? 'In Google Voice audio settings, select your physical microphone and headphones. Restore the BlackHole devices before resuming the AI.' : 'Opening your selected physical microphone.'}</p>}
          <p className="muted">The AI audio stays muted. VoicePilot ends the AI session after two minutes on hold.</p>
        </Notice>}
      </div>
      <div className="stack">
        <Card title="Agent briefing" icon={<Mic />}>
          <div className="stack">
            <div><div className="value-label">Objective</div><p>{plan?.objective || 'No objective set'}</p></div>
            {plan?.instructions && <div><div className="value-label">Call instructions</div><p className="pre-line">{plan.instructions}</p></div>}
            {plan?.context && <div><div className="value-label">Context</div><p className="pre-line">{plan.context}</p></div>}
            <details><summary>Agent instructions</summary><p className="pre-line muted small">{settings.instructions}</p></details>
            <Field label="Send to agent"><textarea rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} placeholder="Add an instruction or ask a question…" /></Field>
            <div className="row wrap">
              <Button disabled={!connected || !!live.approval || !text.trim()} onClick={() => { engine.message(text, true); setText('') }}><Send size={14} /> Add Context</Button>
              <Button disabled={!connected || !!live.approval || !text.trim()} onClick={() => { engine.message(text, false); setText('') }}>Send Message</Button>
            </div>
          </div>
        </Card>
        <Card title="Approvals" icon={<ShieldAlert />}>
          {live.approval ? <div className="stack" role="alert">
            <Status tone="warn">Decision needed</Status><strong>{live.approval.action}</strong><p>{live.approval.details}</p>
            <div className="row wrap">{live.approval.authentication
              ? <Button variant="primary" onClick={() => void engine.takeover()}>Take Over</Button>
              : <Button variant="primary" onClick={() => engine.decide(true)}>Approve Terms</Button>}
              <Button onClick={() => engine.decide(false)}>Deny</Button></div>
          </div> : <p className="muted small">No pending requests.</p>}
        </Card>
        <Card title="Audio controls" icon={<Headphones />}>
          <AudioFields audio={gains} gainsOnly={!changeDevices} locked={live.changingAudio}
            onChange={value => { setGains(value); if (!changeDevices) engine.gains(value) }} />
          <div className="row wrap mt-4">
            {changeDevices ? <>
              <Button disabled={live.changingAudio || !!live.approval} onClick={() => {
                setDevicesChanged(true)
                void engine.changeAudio(gains).then(() => setChangeDevices(false))
              }}>{live.changingAudio ? 'Changing devices…' : 'Apply Devices and Pause'}</Button>
              <Button disabled={live.changingAudio} variant="ghost" onClick={() => setChangeDevices(false)}>Cancel</Button>
            </> : <Button disabled={!['active', 'paused'].includes(live.phase) || !!live.approval} onClick={() => setChangeDevices(true)}>Change Devices</Button>}
            <Button onClick={() => go('diagnostics')}>Audio Diagnostics</Button>
          </div>
        </Card>
      </div>
    </div>
  </div>
}
