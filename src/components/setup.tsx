import { useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, AudioLines, CheckCircle2, Headphones, KeyRound, Mic, Radio, ShieldCheck, Volume2 } from 'lucide-react'
import { api } from '../api.js'
import { requireDevice, standardDevices, validateRoute } from '../audio-routing.js'
import { listen, playTestTone, probe, type Probe } from '../diagnostics.js'
import { errorText, liveSession, routeKey, usePilot } from '../context.js'
import { AudioFields } from './devices.js'
import { VoiceLink } from './calls.js'
import { Button, Card, Check, Level, Notice, Status, Wave } from './ui.js'

export function GoogleVoiceSteps() {
  return <div className="stack">
    <ol className="steps-list">
      <li>Open voice.google.com in Chrome. Allow <strong>Microphone</strong> and <strong>Notifications</strong> from the site controls beside the address bar.</li>
      <li>In Google Voice, open <strong>Settings → Calls</strong> and enable <strong>Web</strong> under incoming calls if shown for your account.</li>
      <li>Open the headset icon in the top-right corner. Select <strong>BlackHole 16ch</strong> for Microphone and <strong>BlackHole 2ch</strong> for Speakers. Set Ringing to your physical speakers or headphones.</li>
      <li>In Chrome at localhost, allow microphone access. If macOS prompts, allow Chrome under <strong>System Settings → Privacy & Security → Microphone</strong>, then reopen Chrome.</li>
    </ol>
    <div className="row wrap"><VoiceLink /><a className="text-button" href="https://support.google.com/voice/answer/9188701" target="_blank" rel="noreferrer">Google Voice audio instructions</a></div>
  </div>
}

export function Credentials() {
  const { hasKey, setHasKey, setVerifiedAgent, settings, flash } = usePilot()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = async () => {
    setBusy(true)
    setError('')
    try { setHasKey((await api<{ hasKey: boolean }>('/settings')).hasKey) }
    catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return <div className="stack">
    <div className="row wrap"><Status tone={hasKey ? 'good' : 'neutral'}>{hasKey ? 'API key saved' : 'API key not set'}</Status>
      <span className="muted small">Required for private agents and connection checks.</span></div>
    <div className="row wrap">
      <Button asChild><a href="/credentials" target="_blank" rel="noreferrer" onClick={() => setVerifiedAgent('')}><KeyRound size={15} /> {hasKey ? 'Replace API Key' : 'Enter API Key'}</a></Button>
      <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>Refresh Key Status</Button>
      {hasKey && <Button variant="ghost" disabled={busy} onClick={async () => {
        setBusy(true)
        setError('')
        try { await api('/secret', 'DELETE'); setHasKey(false); setVerifiedAgent(''); flash('API key removed') }
        catch (error) { setError(errorText(error)) } finally { setBusy(false) }
      }}>Remove Key</Button>}
      {settings.selectedAgent && <AgentTest id={settings.selectedAgent} />}
    </div>
    {error && <Notice danger>{error}</Notice>}
  </div>
}

export function AgentTest({ id }: { id: string }) {
  const { setVerifiedAgent, flash, verifiedAgent } = usePilot()
  const [busy, setBusy] = useState(false)
  return <Button disabled={busy || !id} onClick={async () => {
    setBusy(true)
    try {
      const agent = await api<{ name: string }>('/agents/test', 'POST', { id })
      setVerifiedAgent(id)
      flash('ElevenLabs verified access to ' + agent.name)
    } catch (error) {
      if (verifiedAgent === id) setVerifiedAgent('')
      flash(errorText(error))
    } finally { setBusy(false) }
  }}>{busy ? 'Testing…' : 'Test Connection'}</Button>
}

type Result = { probe?: Probe; message: string; tone: 'good' | 'bad' | 'neutral' }
export function AudioDiagnostics() {
  const { settings, devices, refreshDevices, save, flash, live, history, armed, disarm, evidence, setEvidence } = usePilot()
  const [audio, setAudio] = useState(settings.audio)
  const [results, setResults] = useState<Record<string, Result>>({})
  const [busy, setBusy] = useState('')
  const [level, setLevel] = useState(0)
  const [wave, setWave] = useState<number[]>([])
  const [permission, setPermission] = useState('')
  const task = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => task.current?.abort(), [])
  const lock = liveSession(live) || history.some(call => call.status !== 'ended')
  const receive = devices.some(device => /BlackHole\s*2ch/i.test(device.label))
  const send = devices.some(device => /BlackHole\s*16ch/i.test(device.label))
  const snapshot = async () => {
    const list = await refreshDevices()
    return { list, ...validateRoute(list, audio) }
  }
  const start = (id: string, action: (signal: AbortSignal) => Promise<Result>) => {
    if (task.current || lock) return
    if (armed) disarm()
    const controller = task.current = new AbortController()
    setBusy(id)
    setLevel(0)
    setWave([])
    void action(controller.signal).then(result => {
      if (!controller.signal.aborted) setResults(previous => ({ ...previous, [id]: result }))
    }).catch(error => {
      if (!controller.signal.aborted) setResults(previous => ({ ...previous, [id]: { tone: 'bad', message: errorText(error) } }))
    }).finally(() => {
      task.current = undefined
      if (!controller.signal.aborted) setBusy('')
    })
  }
  const virtualTest = (id: 'receive' | 'send' | '2ch' | '16ch') => start(id, async signal => {
    const { list, input, output } = await snapshot()
    const incoming = id === 'receive' || id === '2ch'
    const routeId = incoming ? input : output
    const pair = list.find(device => device.kind === (incoming ? 'audiooutput' : 'audioinput') &&
      device.deviceId !== 'default' && device.deviceId !== 'communications' &&
      (device.label === routeId.label || (device.groupId && device.groupId === routeId.groupId)))
    const other = incoming ? list.find(device => device.kind === 'audioinput' && device.deviceId !== 'default' &&
      device.deviceId !== 'communications' && (device.label === output.label || (device.groupId && device.groupId === output.groupId))) : input
    if (!pair || !other) throw new Error('The selected virtual paths must each expose a specific input and output in Chrome.')
    if (id === '2ch' && !/blackhole\s*2ch/i.test(input.label)) throw new Error('Select BlackHole 2ch as Caller input first.')
    if (id === '16ch' && !/blackhole\s*16ch/i.test(output.label)) throw new Error('Select BlackHole 16ch as AI output first.')
    const result = await probe(incoming ? input.deviceId : pair.deviceId, incoming ? pair.deviceId : output.deviceId, other.deviceId, signal)
    const key = audio.input + ':' + audio.output
    const good = result.success && !result.leaked
    setEvidence(previous => ({ key, receive: previous.key === key && previous.receive, send: previous.key === key && previous.send,
      [incoming ? 'receive' : 'send']: good }))
    return {
      probe: result, tone: good ? 'good' : 'bad',
      message: result.leaked ? 'The reference signal also reached the opposite input. Correct the routing before calling.'
        : result.success ? 'All four reference tones arrived on the intended input. The opposite input did not match the probe.'
          : 'No matching tone sequence arrived. Check the corresponding driver, channel levels, sample rate, and device selections in Audio MIDI Setup.',
    }
  })
  const testList = [
    ['receive', 'Test Google Voice → agent', 'Simulate caller audio through the selected virtual output and detect it at VoicePilot’s caller input.'],
    ['send', 'Test agent → Google Voice', 'Inject an audio signature into the AI output and detect it at the virtual input Google Voice should use.'],
    ['2ch', 'Test BlackHole 2ch', 'Verify the configured 2-channel loopback and check for cross-path bleed.'],
    ['16ch', 'Test BlackHole 16ch', 'Verify the configured 16-channel loopback and check for cross-path bleed.'],
  ] as const
  function result(id: string) {
    const value = results[id]
    if (!value) return null
    return <div className="test-result">
      <Status tone={value.tone}>{value.tone === 'good' ? 'Signal verified' : value.tone === 'bad' ? 'Check failed' : 'Playback sent'}</Status>
      <p>{value.message}</p>
      {value.probe && <><Wave data={value.probe.wave} height={55} /><p className="muted small">{value.probe.latency === null ? 'Latency unavailable' : 'Approx. ' + value.probe.latency + ' ms loopback'} · {value.probe.inputRate} Hz input · {value.probe.outputRate} Hz output · {value.probe.cross}/4 tones matched on the opposite path</p></>}
    </div>
  }

  return <div className="page-stack">
    <header className="page-heading"><div><h1>Audio Diagnostics</h1><p>Verify each direction and check for signal bleed before a call.</p></div>
      <Button onClick={async () => {
        try { await refreshDevices(true); setPermission('Chrome microphone access granted.') }
        catch (error) { setPermission(errorText(error)) }
      }} disabled={lock || !!busy}><Mic size={16} /> Check Permissions</Button></header>
    {permission && <Notice danger={!permission.endsWith('granted.')}>{permission}</Notice>}
    {lock && <Notice>End the active AI session before running tone or device tests.</Notice>}
    <div className="status-strip">
      <Status tone={receive ? 'good' : 'warn'}>{receive ? 'BlackHole 2ch detected' : 'BlackHole 2ch missing or hidden'}</Status>
      <Status tone={send ? 'good' : 'warn'}>{send ? 'BlackHole 16ch detected' : 'BlackHole 16ch missing or hidden'}</Status>
      <Status tone={evidence.key === routeKey(settings) && evidence.receive && evidence.send ? 'good' : 'neutral'}>Local isolation {evidence.key === routeKey(settings) && evidence.receive && evidence.send ? 'verified' : 'unverified'}</Status>
    </div>
    {(!receive || !send) && <Notice>Grant microphone permission to reveal device names. Install missing drivers with <code>brew install --cask blackhole-2ch blackhole-16ch</code> and restart macOS.</Notice>}
    <Card title="Audio routing" icon={<Headphones />}>
      <AudioFields audio={audio} onChange={setAudio} locked={lock || !!busy} />
      <div className="row wrap mt-4">
        <Button disabled={lock || !!busy} onClick={() => setAudio({ ...audio, ...standardDevices(devices) })}>Select BlackHole Pair</Button>
        <Button variant="primary" disabled={lock || !!busy} onClick={() => void save({ ...settings, audio }).then(() => flash('Audio settings saved'), e => flash(errorText(e)))}>Save Audio Settings</Button>
      </div>
    </Card>
    <div className="equal-grid">
      {testList.map(([id, label, help], index) => <Card key={id} title={label} icon={index % 2 ? <ArrowUpRight /> : <ArrowDownLeft />}>
        <div className="stack"><p className="muted small">{help}</p><Button disabled={lock || !!busy} onClick={() => virtualTest(id)}>{busy === id ? 'Listening for test signal…' : 'Run Loopback Test'}</Button>{result(id)}</div>
      </Card>)}
      <Card title="Test microphone" icon={<Mic />}>
        <div className="stack"><p className="muted small">Speak into the selected takeover microphone for up to five seconds.</p>
          <Button disabled={lock || !!busy} onClick={() => start('mic', async signal => {
            requireDevice(devices, audio.microphone, 'audioinput', 'Takeover microphone')
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 5000)
            signal.addEventListener('abort', () => controller.abort(), { once: true })
            let peak = 0
            try { await listen(audio.microphone, (value, frame) => { peak = Math.max(peak, value); setLevel(value); setWave(frame) }, controller.signal) }
            finally { clearTimeout(timer) }
            return { tone: peak > 0.006 ? 'good' : 'bad', message: peak > 0.006 ? 'Speech-level signal reached VoicePilot.' : 'No clear signal. Check the selected microphone and macOS input level.' }
          })}>{busy === 'mic' ? 'Listening…' : 'Test Microphone'}</Button>
          {(wave.length > 0 && ['mic', ''].includes(busy)) && <><Wave data={wave} height={60} /><Level label="Mic signal" value={level} /></>}
          {result('mic')}
        </div>
      </Card>
      <Card title="Test speakers" icon={<Volume2 />}>
        <div className="stack"><p className="muted small">Play a short tone through the physical monitoring device.</p>
          <Button disabled={lock || !!busy} onClick={() => start('speaker', async signal => {
            requireDevice(devices, audio.monitor, 'audiooutput', 'Monitoring output')
            await playTestTone(audio.monitor, signal)
            return { tone: 'neutral', message: 'Tone scheduled. Confirm you heard it in your headphones or speakers.' }
          })}>Play Test Tone</Button>
          {result('speaker')}
        </div>
      </Card>
    </div>
    {busy && <Button onClick={() => { task.current?.abort(); setBusy('') }}>Cancel Diagnostic</Button>}
    <Card title="Verify a live Google Voice call" icon={<Radio />}>
      <ol className="steps-list"><li>With a consenting test caller, manually place or answer a call. Have them speak and watch the caller input meter.</li>
        <li>Start the agent. Ask the caller to confirm they hear the greeting and answer a question that the agent can repeat back.</li>
        <li>Repeat for each direction. Check input and output mute, pause and resume, human takeover, and Emergency Stop.</li></ol>
    </Card>
  </div>
}

export function Setup() {
  const { settings, health, hasKey, verifiedAgent, evidence, gvChecklist, setGvChecklist, go, save, flash, devices, refreshDevices } = usePilot()
  const [step, setStep] = useState(0)
  const detected = ['2ch', '16ch'].every(name => devices.some(device => new RegExp('BlackHole\\s*' + name, 'i').test(device.label)))
  const routes = evidence.key === routeKey(settings) && evidence.receive && evidence.send
  const compatible = !!(health?.mac && health?.chrome && /Chrome\//.test(navigator.userAgent) &&
    window.AudioContext && 'setSinkId' in AudioContext.prototype)
  const checks = [compatible, !!health?.ok, detected, detected, hasKey, !!settings.selectedAgent && verifiedAgent === settings.selectedAgent,
    gvChecklist, gvChecklist, routes, false]
  const ready = checks.slice(0, 9).every(Boolean)
  const names = ['macOS and Chrome', 'Local server and Node.js', 'BlackHole devices', 'Install audio drivers', 'ElevenLabs credentials', 'Select and test an agent', 'Google Voice audio devices', 'Chrome permissions and incoming calls', 'Simulated call audio', 'Finish setup']
  return <div className="page-stack">
    <header className="page-heading"><div><h1>Set up VoicePilot</h1><p>Connect the local audio paths and verify your ElevenLabs configuration.</p></div><Button onClick={() => go('dashboard')}>Go to Dashboard</Button></header>
    <div className="content-grid setup-grid">
      <Card><div className="setup-list">{names.map((name, index) => <button key={name} className={step === index ? 'selected' : ''} onClick={() => setStep(index)}>
        {checks[index] || (index === 9 && ready) ? <CheckCircle2 size={17} /> : <span>{index + 1}</span>}{name}
      </button>)}</div></Card>
      <Card title={names[step]} icon={<ShieldCheck />}>
        <div className="stack">
          {step === 0 && <Status tone={compatible ? 'good' : 'warn'}>{compatible ? 'Chrome audio routing available on macOS' : 'Open localhost in a current Chrome release on macOS'}</Status>}
          {step === 1 && <Status tone={health?.ok ? 'good' : 'warn'}>{health?.ok ? 'Local server online · Node.js ' + health.node : 'Local health check unavailable'}</Status>}
          {step === 2 && <><Status tone={detected ? 'good' : 'warn'}>{detected ? 'Both BlackHole devices visible' : 'Chrome has not reported both devices'}</Status><Button onClick={() => void refreshDevices(true).catch(error => flash(errorText(error)))}>Allow Microphone and Scan</Button></>}
          {step === 3 && <><p>Install both virtual audio drivers in Terminal, then restart macOS.</p><pre>brew install --cask blackhole-2ch blackhole-16ch</pre><a href="https://github.com/ExistentialAudio/BlackHole" target="_blank" rel="noreferrer">BlackHole installation instructions</a></>}
          {step === 4 && <Credentials />}
          {step === 5 && <div className="row wrap"><Button onClick={() => go('agents')}><KeyRound size={16} /> Manage Agents</Button>{settings.selectedAgent && <AgentTest id={settings.selectedAgent} />}</div>}
          {(step === 6 || step === 7) && <><GoogleVoiceSteps /><Check value={gvChecklist} onChange={setGvChecklist}>I configured Google Voice devices, web calling, and browser permissions.</Check></>}
          {step === 8 && <><p>Run both local loopback probes. They send and detect audio without connecting to a phone call or ElevenLabs.</p><Button onClick={() => go('diagnostics')}><AudioLines size={16} /> Open Audio Diagnostics</Button>{routes && <Status tone="good">Both local paths verified</Status>}</>}
          {step === 9 && <><Status tone={ready ? 'good' : 'warn'}>{ready ? 'Local setup checks passed' : 'Some setup checks are still open'}</Status>
            <p className="muted">A live incoming and outgoing call with a consenting caller verifies phone audio separately.</p>
            <Button variant="primary" disabled={!ready} onClick={() => void save({ ...settings, setupComplete: true }).then(() => go('dashboard'), e => flash(errorText(e)))}>Finish Setup</Button></>}
          {step < 9 && <Button className="self-start" variant="ghost" onClick={() => setStep(step + 1)}>Next Step <ArrowRight size={15} /></Button>}
        </div>
      </Card>
    </div>
  </div>
}
