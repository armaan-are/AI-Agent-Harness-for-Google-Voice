import { ArrowDownLeft, ArrowRight, ArrowUpRight, AudioLines, Bot, Clock3, Headphones, History, Phone, Radio, ShieldCheck } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { clock, dateTime, liveSession, routeKey, usePilot } from '../context.js'
import { VoiceLink } from './calls.js'
import { Button, Card, Status, Wave } from './ui.js'

export function Dashboard() {
  const { ready, settings, verifiedAgent, hasKey, history, evidence, gvChecklist, go, live, meter } = usePilot()
  const ended = history.filter(call => call.status === 'ended')
  const latest = ended[0]
  const total = ended.reduce((sum, call) => sum + call.duration, 0)
  const agent = settings.agents.find(item => item.id === settings.selectedAgent)
  const audioReady = evidence.key === routeKey(settings) && evidence.receive && evidence.send
  const data = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - 6 + index)
    const minutes = ended.filter(call => new Date(call.startedAt).toDateString() === date.toDateString()).reduce((sum, call) => sum + call.duration / 60, 0)
    return { day: date.toLocaleDateString(undefined, { weekday: 'short' }), minutes: Math.round(minutes * 10) / 10 }
  })
  return <div className="page-stack">
    <header className="page-heading"><div><h1>Dashboard</h1><p>Run your ElevenLabs agent on a Google Voice call.</p></div><VoiceLink /></header>
    <div className="hero">
      <div className="hero-copy"><div className="hero-icon"><Phone size={21} /></div>
        <h2>{liveSession(live) ? 'Call in progress' : 'Call workspace'}</h2>
        <p>{liveSession(live) ? 'Open the active call to monitor the conversation or take over.' : 'Choose a call direction. You’ll dial or answer in Google Voice before starting the agent.'}</p>
        <div className="row wrap">{liveSession(live) ? <Button variant="primary" onClick={() => go('active')}>Open Active Call <ArrowRight size={16} /></Button> :
          <><Button variant="primary" onClick={() => go('outgoing')}><ArrowUpRight size={16} /> Outgoing Call</Button><Button onClick={() => go('incoming')}><ArrowDownLeft size={16} /> Incoming Call</Button></>}</div>
      </div>
      <div className="hero-monitor"><div className="row between"><span><AudioLines size={17} /> Audio bridge</span><Status tone={liveSession(live) ? 'good' : 'neutral'}>{liveSession(live) ? 'Session open' : 'Standby'}</Status></div>
        <Wave data={meter.wave} height={112} /><div className="row between muted small"><span>Caller input</span><span>{meter.input > 0.005 ? 'Signal detected' : 'No signal'}</span></div></div>
    </div>
    <div className="metrics">
      <Card><span className="metric-icon"><Bot size={18} /></span><small>Selected agent</small><strong>{agent?.name || 'No agent selected'}</strong><button className="text-button" onClick={() => go('agents')}>Manage agents <ArrowRight size={13} /></button></Card>
      <Card><span className="metric-icon"><Clock3 size={18} /></span><small>AI minutes used</small><strong>{(total / 60).toFixed(1)} <span>min</span></strong><span className="muted small">From local session duration</span></Card>
      <Card><span className="metric-icon"><History size={18} /></span><small>Ended sessions</small><strong>{ended.length}</strong><button className="text-button" onClick={() => go('history')}>Call history <ArrowRight size={13} /></button></Card>
    </div>
    <div className="content-grid">
      <Card title="AI session time" icon={<Radio />} action={<span className="muted small">Last 7 days</span>}>
        <div className="chart"><ResponsiveContainer width="100%" height={190}>
          <AreaChart data={data} margin={{ left: -25, right: 12, top: 10, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="day" stroke="var(--muted)" axisLine={false} tickLine={false} fontSize={12} />
            <YAxis allowDecimals={false} stroke="var(--muted)" axisLine={false} tickLine={false} fontSize={12} domain={[0, Math.max(1, Math.ceil(Math.max(...data.map(entry => entry.minutes))))]} />
            <Tooltip contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)', borderRadius: 8, color: 'var(--text)' }} />
            <Area type="monotone" dataKey="minutes" stroke="var(--accent)" fill="var(--accent-soft)" strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer></div>
      </Card>
      <Card title="Readiness" icon={<ShieldCheck />} action={<button className="text-button" onClick={() => go('setup')}>Setup</button>}>
        <div className="readiness">
          <div><span>Local server</span><Status tone={ready ? 'good' : 'warn'}>{ready ? 'Online' : 'Disconnected'}</Status></div>
          <div><span>ElevenLabs</span><Status tone={verifiedAgent && verifiedAgent === settings.selectedAgent ? 'good' : 'neutral'}>{verifiedAgent && verifiedAgent === settings.selectedAgent ? 'Access verified' : hasKey ? 'Key saved' : 'Needs setup'}</Status></div>
          <div><span>Google Voice configuration</span><Status tone={gvChecklist ? 'good' : 'neutral'}>{gvChecklist ? 'Confirmed by you' : 'Check required'}</Status></div>
          <div><span>Local audio isolation</span><Status tone={audioReady ? 'good' : 'neutral'}>{audioReady ? 'Verified' : 'Unverified'}</Status></div>
        </div>
      </Card>
      <Card title="Recent sessions" icon={<History />} action={<button className="text-button" onClick={() => go('history')}>View all <ArrowRight size={13} /></button>}>
        {ended.length ? <div className="readiness">{ended.slice(0, 4).map(item => <button className="session-row" key={item.id} onClick={() => go('history')}>
          <span className="row">{item.direction === 'incoming' ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}<span><strong>{item.label || item.direction + ' call'}</strong><small>{dateTime(item.startedAt)}</small></span></span>
          <span className="mono">{clock(item.duration)}</span>
        </button>)}</div> : <div className="empty"><History size={23} /><p>No ended sessions yet.</p></div>}
      </Card>
      <Card title="Last call summary" icon={<Headphones />}>
        {latest ? <div className="stack"><strong>{latest.label || latest.direction + ' call'}</strong><p className="muted small">{latest.providerSummary || latest.notes || latest.summary?.mainPoints[0] || latest.endReason}</p><Button onClick={() => go('history')}>Review Session</Button></div>
          : <div className="empty"><AudioLines size={23} /><p>Summaries appear after a session ends.</p></div>}
      </Card>
    </div>
  </div>
}
