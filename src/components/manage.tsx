import { useEffect, useState } from 'react'
import { AudioLines, Bot, Database, FileDown, KeyRound, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import { defaultInstructions, type CallRecord, type Settings as SettingsType } from '../../shared/model.js'
import { api } from '../api.js'
import { dateTime, clock, errorText, liveSession, usePilot } from '../context.js'
import { AudioFields } from './devices.js'
import { AgentTest, Credentials, GoogleVoiceSteps } from './setup.js'
import { TranscriptList } from './calls.js'
import { Button, Card, Check, Field, Notice, Status } from './ui.js'

export function Agents() {
  const { settings, save, verifiedAgent, flash } = usePilot()
  const [form, setForm] = useState(settings)
  const [agent, setAgent] = useState({ id: '', name: '', private: true })
  const [template, setTemplate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const persist = async (updated: SettingsType, notice: string) => {
    setError('')
    setBusy(true)
    try { await save(updated); setForm(updated); flash(notice); return true }
    catch (error) { setError(errorText(error)); return false } finally { setBusy(false) }
  }
  return <div className="page-stack">
    <header className="page-heading"><div><h1>Agents</h1><p>Manage ElevenLabs agents and reusable conversation instructions.</p></div></header>
    {error && <Notice danger>{error}</Notice>}
    <div className="content-grid">
      <div className="stack">
        <Card title="Agent library" icon={<Bot />}>
          {form.agents.length ? <div className="stack compact">{form.agents.map(item => <div className="agent-row" key={item.id}>
            <div><strong>{item.name}</strong><div className="small muted">{item.private ? 'Private' : 'Public'} · {item.id}</div></div>
            <div className="row wrap">
              {item.id === form.selectedAgent ? <Status tone="good">Selected</Status> : <Button disabled={busy} onClick={() => void persist({ ...form, selectedAgent: item.id }, 'Default agent updated')}>Select</Button>}
              <Button variant="ghost" aria-label={'Edit ' + item.name} onClick={() => setAgent(item)}>Edit</Button>
              <Button variant="ghost" aria-label={'Remove ' + item.name} onClick={() => void persist({ ...form,
                agents: form.agents.filter(agent => agent.id !== item.id),
                selectedAgent: item.id === form.selectedAgent ? '' : form.selectedAgent,
              }, 'Agent removed')}><Trash2 size={15} /></Button>
            </div>
          </div>)}</div> : <p className="muted">Add an existing agent from your ElevenLabs workspace.</p>}
        </Card>
        <Card title="Instructions and greeting" icon={<AudioLines />}>
          <div className="stack">
            <Field label="Instruction template"><select value="" onChange={event => {
              const value = form.templates[Number(event.target.value)]
              if (value) setForm({ ...form, instructions: value.text })
            }}><option value="" disabled>Load a template</option>{form.templates.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></Field>
            <Field label="Agent instructions"><textarea rows={12} maxLength={16000} value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} /></Field>
            <Field label="Initial greeting"><input maxLength={1000} value={form.greeting} onChange={e => setForm({ ...form, greeting: e.target.value })} /></Field>
            <Check value={form.overrides} onChange={overrides => setForm({ ...form, overrides })}>Apply prompt and first-message overrides at session start</Check>
            <p className="muted small">Enable System prompt and First message overrides in the ElevenLabs agent’s security settings. With overrides disabled, set the AI disclosure and approval policy directly on the agent. VoicePilot sends the briefing as a contextual update after connecting.</p>
            <details><summary>Configure sensitive decisions</summary>
              <p className="muted small">Add a Client tool named <code>request_human_approval</code> to your ElevenLabs agent. Set it to wait for a response and require two string fields, <code>action</code> and <code>details</code>. The agent should call it for exact terms before committing and use action <code>authentication</code> when the operator must take over. Keep transaction-capable server tools disabled.</p>
            </details>
            <div className="row wrap"><Button variant="primary" disabled={busy} onClick={() => void persist(form, 'Agent instructions saved')}>Save Instructions</Button><Button variant="ghost" onClick={() => setForm({ ...form, instructions: defaultInstructions })}>Restore Default</Button></div>
            <div className="input-action"><input aria-label="New template name" maxLength={80} placeholder="New template name" value={template} onChange={e => setTemplate(e.target.value)} />
              <Button disabled={busy || !template.trim() || !form.instructions.trim()} onClick={() => void persist({ ...form, templates: [...form.templates.filter(item => item.name !== template.trim()), {
                name: template.trim(), text: form.instructions.trim(),
              }] }, 'Template saved').then(ok => { if (ok) setTemplate('') })}>Save as Template</Button></div>
          </div>
        </Card>
      </div>
      <div className="stack">
        <Card title={form.agents.some(item => item.id === agent.id) ? 'Edit agent' : 'Add agent'} icon={<Plus />}>
          <form className="stack" onSubmit={async event => {
            event.preventDefault()
            const id = agent.id.trim()
            const updated = { ...form, agents: [...form.agents.filter(item => item.id !== id), { ...agent, id, name: agent.name.trim() }],
              selectedAgent: form.selectedAgent || id }
            if (await persist(updated, 'Agent saved')) setAgent({ id: '', name: '', private: true })
          }}>
            <Field label="Display name"><input required maxLength={100} value={agent.name} onChange={e => setAgent({ ...agent, name: e.target.value })} placeholder="Customer Service" /></Field>
            <Field label="Agent ID"><input required maxLength={100} value={agent.id} onChange={e => setAgent({ ...agent, id: e.target.value })} placeholder="agent_…" /></Field>
            <Check value={agent.private} onChange={value => setAgent({ ...agent, private: value })}>Private agent requires a signed URL</Check>
            <div className="row wrap"><Button type="submit" variant="primary" disabled={busy}>Save Agent</Button>{agent.id && <AgentTest id={agent.id.trim()} />}</div>
            {verifiedAgent && verifiedAgent === agent.id.trim() && <Status tone="good">Access verified</Status>}
          </form>
        </Card>
        <Card title="ElevenLabs credentials" icon={<KeyRound />}><Credentials /></Card>
      </div>
    </div>
  </div>
}

export function SettingsPage() {
  const { settings, save, health, live, go, refreshDevices, refreshHistory, flash } = usePilot()
  const [form, setForm] = useState(settings)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = liveSession(live)
  const set = <K extends keyof SettingsType,>(key: K, value: SettingsType[K]) => setForm({ ...form, [key]: value })
  const persist = async () => {
    setError('')
    setBusy(true)
    try { await save(form); refreshHistory(); flash('Settings saved') }
    catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return <div className="page-stack">
    <header className="page-heading"><div><h1>Settings</h1><p>Configure audio devices, credentials, and local data preferences.</p></div>
      <Button variant="primary" disabled={busy} onClick={() => void persist()}>Save Settings</Button></header>
    {error && <Notice danger>{error}</Notice>}
    <div className="equal-grid">
      <Card title="ElevenLabs" icon={<KeyRound />}>
        <div className="stack">
          <Credentials />
          <Field label="Default agent"><select value={form.selectedAgent} onChange={e => set('selectedAgent', e.target.value)}>
            <option value="">Select an agent</option>{form.agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></Field>
          <Button onClick={() => go('agents')}>Manage Agents</Button>
        </div>
      </Card>
      <Card title="Google Voice" icon={<AudioLines />}><GoogleVoiceSteps /></Card>
    </div>
    <Card title="Audio" icon={<AudioLines />}>
      <AudioFields audio={form.audio} onChange={value => set('audio', value)} locked={active} />
      <div className="row wrap mt-4"><Button disabled={active} onClick={() => void refreshDevices(true).then(() => flash('Audio devices refreshed'), e => flash(errorText(e)))}>Load Devices</Button>
        <Button onClick={() => go('diagnostics')}>Run Audio Diagnostics</Button></div>
    </Card>
    <div className="equal-grid">
      <Card title="Application" icon={<Settings2 />}>
        <div className="stack">
          <div className="field-grid">
            <Field label="Theme"><select value={form.theme} onChange={e => set('theme', e.target.value as SettingsType['theme'])}><option value="dark">Dark</option><option value="light">Light</option></select></Field>
            <Field label="Open on startup"><select value={form.startup} onChange={e => set('startup', e.target.value as SettingsType['startup'])}><option value="dashboard">Dashboard</option><option value="incoming">Incoming Calls</option></select></Field>
            <Field label="Server port" hint={'Restart Node to apply. PORT in .env takes precedence. Current: ' + (health?.port || 'unknown')}><input type="number" min={1024} max={65535} value={form.port} onChange={e => set('port', Number(e.target.value))} /></Field>
          </div>
          <Check value={form.debug} onChange={value => set('debug', value)}>Print sanitized request error types to Terminal</Check>
          <Button onClick={() => go('setup')}>Open Setup Wizard</Button>
        </div>
      </Card>
      <Card title="Local data and privacy" icon={<Database />}>
        <div className="stack">
          <Field label="Delete call data after (days)" hint="Use 0 to retain history until you delete it."><input type="number" min={0} max={3650} value={form.retentionDays} onChange={e => set('retentionDays', Number(e.target.value))} /></Field>
          <Check value={form.transcriptStorage} onChange={value => set('transcriptStorage', value)}>Allow per-call transcript and summary storage</Check>
          <p className="muted small">ElevenLabs receives live speech while the AI is active. Review the agent’s ElevenLabs retention and audio-saving settings separately. VoicePilot stores session metadata on this Mac and does not record raw audio.</p>
          <div className="row wrap"><Button onClick={() => go('history')}>Export Call Data</Button>
            <Button variant="danger" onClick={async () => {
              if (!window.confirm('Permanently delete all ended VoicePilot sessions on this Mac?')) return
              try { await api('/calls', 'DELETE'); refreshHistory(); flash('Local call history deleted') }
              catch (error) { setError(errorText(error)) }
            }}><Trash2 size={15} /> Delete Local History</Button></div>
        </div>
      </Card>
    </div>
  </div>
}

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function exportCall(call: CallRecord, format: 'json' | 'md' | 'txt') {
  const title = call.label || call.direction + ' call'
  const heading = (text: string) => (format === 'md' ? '## ' : '') + text
  const fields = call.summary ? Object.entries(call.summary).map(([key, value]) =>
    [heading(key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase())), Array.isArray(value) ? value.join('\n') : value].join('\n')) : []
  const lines = [
    (format === 'md' ? '# ' : '') + title,
    dateTime(call.startedAt) + ' · ' + clock(call.duration) + (call.phone ? ' · ' + call.phone : ''),
    call.conversationId ? 'Conversation ID ' + call.conversationId : '',
    call.endReason, ...fields,
    ...(call.providerSummary ? [heading('ElevenLabs summary'), call.providerSummary] : []),
    ...(call.notes ? [heading('Notes'), call.notes] : []),
    heading('Transcript'),
    call.transcript.map(row => '[' + new Date(row.at).toISOString() + '] ' + (row.role === 'agent' ? 'AI Agent' : 'Caller') + ' — ' + row.text).join('\n'),
  ].filter(Boolean).join('\n\n')
  download(format === 'json' ? JSON.stringify(call, null, 2) : lines, 'voicepilot-' + call.id + '.' + format,
    format === 'json' ? 'application/json' : format === 'md' ? 'text/markdown' : 'text/plain')
}

export function History() {
  const { history, refreshHistory, flash } = usePilot()
  const [search, setSearch] = useState('')
  const [filtered, setFiltered] = useState<CallRecord[]>([])
  const [searchError, setSearchError] = useState('')
  const [call, setCall] = useState<CallRecord>()
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const detail = (item?: CallRecord) => { setCall(item); setNotes(item?.notes || '') }
  useEffect(() => {
    if (!search.trim()) return
    const controller = new AbortController()
    const timer = setTimeout(() => void api<CallRecord[]>('/calls?q=' + encodeURIComponent(search.trim()), 'GET', undefined, controller.signal)
      .then(items => { setFiltered(items); setSearchError('') }, error => { if (!controller.signal.aborted) setSearchError(errorText(error)) }), 230)
    return () => { clearTimeout(timer); controller.abort() }
  }, [search, history])
  const items = (search.trim() ? filtered : history).filter(item => item.status === 'ended')
  return <div className="page-stack">
    <header className="page-heading"><div><h1>Call History</h1><p>Review VoicePilot sessions, transcripts, and follow-up notes.</p></div>
      <Button disabled={!history.some(item => item.status === 'ended') || busy} onClick={async () => {
        setBusy(true)
        try {
          const ended = history.filter(item => item.status === 'ended')
          const data = []
          for (const item of ended) data.push(await api<CallRecord>('/calls/' + item.id))
          download(JSON.stringify(data, null, 2), 'voicepilot-history.json', 'application/json')
        } catch (error) { flash(errorText(error)) } finally { setBusy(false) }
      }}><FileDown size={16} /> Export History</Button></header>
    {searchError && <Notice danger>{searchError}</Notice>}
    <Card>
      <div className="search"><Search size={17} /><input type="search" aria-label="Search calls and transcripts" placeholder="Search calls and transcripts…" maxLength={200} value={search} onChange={e => { setFiltered([]); setSearch(e.target.value) }} /></div>
      {items.length ? <div className="history-table"><table>
        <thead><tr><th>Call</th><th>Direction</th><th>Started</th><th>AI duration</th><th /></tr></thead>
        <tbody>{items.map(item => <tr key={item.id}>
          <td><strong>{item.label || (item.direction === 'incoming' ? 'Incoming caller' : 'Outgoing call')}</strong><small>{item.phone || item.endReason}</small></td>
          <td className="capitalize">{item.direction}</td><td>{dateTime(item.startedAt)}</td><td className="mono">{clock(item.duration)}</td>
          <td><Button variant="ghost" onClick={() => void api<CallRecord>('/calls/' + item.id).then(detail, e => flash(errorText(e)))}>View</Button></td>
        </tr>)}</tbody>
      </table></div> : <div className="empty"><Database size={23} /><p>{search.trim() ? 'No matching sessions.' : 'Your ended VoicePilot sessions will appear here.'}</p></div>}
    </Card>
    {call && <Card title={call.label || 'Call details'} action={<Button variant="ghost" onClick={() => detail()}>Close</Button>}>
      <div className="stack">
        <p className="muted small">{dateTime(call.startedAt)} · {clock(call.duration)} · {call.endReason} {call.conversationId && ' · ' + call.conversationId}</p>
        <div className="row wrap"><FileDown size={16} />{(['json', 'md', 'txt'] as const).map(format => <Button key={format} onClick={() => exportCall(call, format)}>{format === 'md' ? 'Markdown' : format.toUpperCase()}</Button>)}
          <Button variant="danger" onClick={async () => {
            if (!window.confirm('Delete this local session and its transcript?')) return
            try { await api('/calls/' + call.id, 'DELETE'); detail(); refreshHistory(); flash('Session deleted') } catch (error) { flash(errorText(error)) }
          }}><Trash2 size={15} /> Delete</Button></div>
        {call.summary && <dl className="summary">
          {Object.entries(call.summary).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
            <dd>{Array.isArray(value) ? (value.length ? <ul>{value.map((text, index) => <li key={index}>{text}</li>)}</ul> : 'No matching evidence') : value}</dd></div>)}
        </dl>}
        {call.providerSummary && <div className="notice pre-line"><strong>ElevenLabs summary · review against transcript</strong><p>{call.providerSummary}</p></div>}
        {call.saveTranscript && call.conversationId && <Button className="self-start" disabled={busy} onClick={async () => {
          setBusy(true)
          try { setCall(await api<CallRecord>('/calls/' + call.id + '/summary', 'POST')); flash('ElevenLabs summary saved') }
          catch (error) { flash(errorText(error)) } finally { setBusy(false) }
        }}>Fetch ElevenLabs Summary</Button>}
        <TranscriptList rows={call.transcript} />
        <Field label="Notes and verified outcome"><textarea rows={3} maxLength={20000} value={notes} onChange={event => setNotes(event.target.value)} /></Field>
        <Button className="self-start" onClick={() => void api<CallRecord>('/calls/' + call.id, 'PATCH', { notes }).then(updated => { detail(updated); flash('Notes saved') }, e => flash(errorText(e)))}>Save Notes</Button>
      </div>
    </Card>}
  </div>
}
