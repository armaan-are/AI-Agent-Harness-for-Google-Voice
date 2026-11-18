import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowDownLeft, ArrowUpRight, AudioLines, Bot, ChevronRight, CircleStop, Headphones, History, LayoutDashboard,
  Menu, Moon, Phone, Settings2, Sun, X,
} from 'lucide-react'
import { planSchema, settingsSchema, type CallRecord, type Settings } from '../shared/model.js'
import { api, LocalSocket, type Bootstrap, type Health } from './api.js'
import { AudioBridge, emptyMeter, enumerate, type Meter } from './audio.js'
import { requireDevice, validateRoute, type Device } from './audio-routing.js'
import { blankDraft, errorText, liveSession, PilotContext, type Draft, type Page, type RouteEvidence } from './context.js'
import { listen } from './diagnostics.js'
import { initialLive, Session, type Authorization, type LiveState } from './session.js'
import { ActiveCall, CallForm } from './components/calls.js'
import { Agents, History as CallHistory, SettingsPage } from './components/manage.js'
import { AudioDiagnostics, Setup } from './components/setup.js'
import { Button, Notice, Status } from './components/ui.js'
import './styles.css'

const Dashboard = lazy(() => import('./components/dashboard.js').then(module => ({ default: module.Dashboard })))

const nav = [
  ['dashboard', 'Dashboard', LayoutDashboard], ['active', 'Active Call', AudioLines], ['incoming', 'Incoming Calls', ArrowDownLeft],
  ['outgoing', 'Outgoing Calls', ArrowUpRight], ['agents', 'Agents', Bot], ['history', 'Call History', History],
  ['diagnostics', 'Audio Diagnostics', Activity], ['settings', 'Settings', Settings2],
] as const
const allPages = new Set<string>([...nav.map(item => item[0]), 'setup'])
const readHash = (): Page | undefined => {
  const value = location.hash.replace(/^#\/?/, '')
  return allPages.has(value) ? value as Page : undefined
}

function App() {
  const [page, setPage] = useState<Page>(readHash() || 'dashboard')
  const [health, setHealth] = useState<Health>()
  const [settings, setSettings] = useState<Settings>(() => settingsSchema.parse({}))
  const [loaded, setLoaded] = useState(false)
  const [bootError, setBootError] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [verifiedAgent, setVerifiedAgent] = useState('')
  const [ready, setReady] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [history, setHistory] = useState<CallRecord[]>([])
  const [draft, setDraft] = useState<Draft>(blankDraft)
  const [live, setLive] = useState<LiveState>(initialLive)
  const [meter, setMeter] = useState<Meter>(emptyMeter)
  const [evidence, setEvidence] = useState<RouteEvidence>({ key: '', receive: false, send: false })
  const [gvChecklist, setGvChecklist] = useState(false)
  const [armed, setArmed] = useState(false)
  const [possibleAudio, setPossibleAudio] = useState(false)
  const [toast, setToast] = useState('')
  const [menu, setMenu] = useState(false)
  const standby = useRef<AbortController | undefined>(undefined)
  const connection = useRef<LocalSocket | undefined>(undefined)

  const refreshHistory = useCallback(() => {
    void api<CallRecord[]>('/calls').then(setHistory, () => undefined)
  }, [])
  const [engine] = useState(() => new Session({
    reserve: plan => api<{ call: CallRecord; authorization: Authorization }>('/sessions', 'POST', { owner: connection.current?.owner, plan }),
    cancel: () => { void api('/sessions/cancel', 'POST', { owner: connection.current?.owner }).catch(() => undefined) },
    publish: event => connection.current?.send(event) || false,
    audio: (config, update, fail) => new AudioBridge(config, update, fail),
    update: state => {
      setLive(state)
      if (state.phase === 'ended') setMeter(emptyMeter)
    },
    meter: setMeter,
  }))
  const go = useCallback((next: Page) => {
    location.hash = '/' + next
    setPage(next)
    setMenu(false)
  }, [])
  const load = useCallback(async () => {
    setBootError('')
    try {
      const [bootstrap, status] = await Promise.all([api<Bootstrap>('/settings'), api<Health>('/health')])
      setHasKey(bootstrap.hasKey)
      setSettings(bootstrap.settings)
      setHealth(status)
      if (!readHash()) go(bootstrap.settings.setupComplete ? bootstrap.settings.startup : 'setup')
      setLoaded(true)
    } catch (error) { setBootError(errorText(error)) }
  }, [go])

  const refreshDevices = useCallback(async (permission = false) => {
    const list = await enumerate(permission)
    setDevices(list)
    return list
  }, [])

  const flash = useCallback((text: string) => setToast(text), [])
  const disarm = useCallback(() => {
    standby.current?.abort()
    standby.current = undefined
    setArmed(false)
    setPossibleAudio(false)
  }, [])

  useEffect(() => {
    void load()
    refreshHistory()
    void refreshDevices().catch(() => undefined)
    const hashChange = () => { setPage(readHash() || 'dashboard'); setMenu(false) }
    const deviceChange = () => {
      setEvidence({ key: '', receive: false, send: false })
      void refreshDevices().catch(() => undefined)
    }
    const socket = new LocalSocket(ok => {
      setReady(ok)
      if (!ok && liveSession(engine.state)) engine.fail('Lost the local session server. AI audio was stopped.')
      if (ok) refreshHistory()
    }, refreshHistory)
    connection.current = socket
    const updateKey = () => {
      if (document.visibilityState === 'visible') void api<Bootstrap>('/settings').then(value => setHasKey(value.hasKey), () => undefined)
    }
    document.addEventListener('visibilitychange', updateKey)
    const offline = () => { if (liveSession(engine.state)) engine.fail('Chrome reported a network disconnection.') }
    const exit = () => { engine.end('VoicePilot page closed'); disarm() }
    const restore = (event: PageTransitionEvent) => { if (event.persisted) location.reload() }
    window.addEventListener('hashchange', hashChange)
    window.addEventListener('offline', offline)
    window.addEventListener('pagehide', exit)
    window.addEventListener('pageshow', restore)
    navigator.mediaDevices?.addEventListener('devicechange', deviceChange)
    return () => {
      exit()
      socket.close()
      document.removeEventListener('visibilitychange', updateKey)
      window.removeEventListener('hashchange', hashChange)
      window.removeEventListener('offline', offline)
      window.removeEventListener('pagehide', exit)
      window.removeEventListener('pageshow', restore)
      navigator.mediaDevices?.removeEventListener('devicechange', deviceChange)
    }
  }, [engine, load, refreshHistory, refreshDevices, disarm])
  useEffect(() => { document.documentElement.dataset.theme = settings.theme }, [settings.theme])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), 5200)
    return () => clearTimeout(id)
  }, [toast])
  useEffect(() => {
    window.scrollTo(0, 0)
    if (page === 'incoming' || page === 'outgoing') {
      setDraft(previous => previous.direction === page ? previous : { ...previous, direction: page, confirmed: false, consent: false })
    }
  }, [page])

  const save = async (next: Settings) => {
    const parsed = settingsSchema.parse(next)
    await api('/settings', 'PUT', parsed)
    if (settings.audio.input !== parsed.audio.input) disarm()
    setSettings(parsed)
    if (liveSession(engine.state)) engine.gains(parsed.audio)
    if (draft.agentId && !parsed.agents.some(agent => agent.id === draft.agentId)) {
      setDraft(previous => ({ ...previous, agentId: '' }))
    }
  }
  const arm = async () => {
    if (standby.current || liveSession(engine.state)) return
    if (history.some(call => call.status !== 'ended')) throw new Error('An AI session is active in another tab.')
    requireDevice(devices, settings.audio.input, 'audioinput', 'Caller input')
    const controller = standby.current = new AbortController()
    let recent = 0
    let lastSignal = 0
    setArmed(true)
    void listen(settings.audio.input, value => {
      recent = value > 0.009 ? recent + 1 : Math.max(0, recent - 1)
      if (recent >= 4) lastSignal = Date.now()
      setPossibleAudio(Date.now() - lastSignal < 1800)
    }, controller.signal).catch(error => {
      if (!controller.signal.aborted) flash(errorText(error))
    }).finally(() => { if (standby.current === controller) disarm() })
  }

  const start = () => {
    try {
      if (!ready) throw new Error('Wait for the local server to connect.')
      if (history.some(call => call.status !== 'ended')) throw new Error('An AI session is already in progress.')
      const selected = draft.agentId || settings.selectedAgent
      const agent = settings.agents.find(item => item.id === selected)
      if (!agent) throw new Error('Select a saved ElevenLabs agent.')
      if (agent.private && !hasKey) throw new Error('Save an ElevenLabs API key for the private agent.')
      const plan = planSchema.parse({ ...draft, agentId: selected, saveTranscript: settings.transcriptStorage && draft.saveTranscript })
      validateRoute(devices, settings.audio)
      disarm()
      go('active')
      setDraft(previous => ({ ...previous, confirmed: false, consent: false, saveTranscript: false }))
      void engine.start(plan, settings)
    } catch (error) { flash(errorText(error)) }
  }

  const active = liveSession(live)
  return <PilotContext.Provider value={{ page, go, health, ready, hasKey, setHasKey, verifiedAgent, setVerifiedAgent, settings,
    save, devices, refreshDevices, history, refreshHistory, draft, setDraft, engine, live, meter, evidence, setEvidence,
    gvChecklist, setGvChecklist, armed, possibleAudio, arm, disarm, start, flash }}>
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
    <div className="shell">
      <aside className={'sidebar ' + (menu ? 'sidebar-open' : '')} aria-label="VoicePilot">
        <div className="brand"><button onClick={() => go('dashboard')}><span className="brand-mark"><AudioLines size={23} /></span><span>VoicePilot<small>Local call assistant</small></span></button>
          <Button className="mobile-close" variant="ghost" aria-label="Close navigation" onClick={() => setMenu(false)}><X size={19} /></Button></div>
        <nav aria-label="Main navigation">{nav.map(([id, name, Icon]) => <a href={'#/' + id} key={id} aria-current={page === id ? 'page' : undefined}
          className={'nav-link ' + (page === id ? 'nav-active' : '')} onClick={event => { event.preventDefault(); go(id) }}>
          <Icon size={18} /><span>{name}</span>{id === 'active' && active && <span className="nav-dot" />}
          {page === id && <ChevronRight className="nav-arrow" size={14} />}
        </a>)}</nav>
        <div className="sidebar-footer"><div className="local-card"><div className="local-icon"><Headphones size={17} /></div><div><strong>Local workspace</strong><span><i className={ready ? 'online' : ''} />{ready ? 'Server connected' : 'Server disconnected'}</span></div></div></div>
      </aside>
      {menu && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenu(false)} />}
      <div className="workspace">
        <header className="topbar"><div className="row">
          <Button className="mobile-menu" variant="ghost" aria-label="Open navigation" onClick={() => setMenu(true)}><Menu size={20} /></Button>
          <span className="crumb"><Phone size={15} /> Workspace <ChevronRight size={13} /> <strong>{nav.find(item => item[0] === page)?.[1] || 'Setup'}</strong></span>
        </div><div className="row">
          {active && <Button variant="danger" onClick={() => engine.end('Emergency stop')}><CircleStop size={15} /> Emergency Stop</Button>}
          {!active && <Status tone={ready ? 'good' : 'warn'}>{ready ? 'Local server online' : 'Connecting to local server'}</Status>}
          <Button className="theme-button" variant="ghost" disabled={!loaded} aria-label={'Switch to ' + (settings.theme === 'dark' ? 'light' : 'dark') + ' mode'} onClick={() => void save({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' }).catch(e => flash(errorText(e)))}>
            {settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
        </div></header>
        <main id="main-content" tabIndex={-1}>
          {bootError ? <Notice danger>{bootError} <Button variant="ghost" onClick={() => void load()}>Retry</Button></Notice> : !loaded ? <Status>Loading workspace</Status> :
            <>
              {page === 'dashboard' && <Suspense fallback={<Status>Loading dashboard</Status>}><Dashboard /></Suspense>}
              {page === 'active' && <ActiveCall />}
              {(page === 'incoming' || page === 'outgoing') && <CallForm direction={page} key={page} />}
              {page === 'agents' && <Agents />}
              {page === 'diagnostics' && <AudioDiagnostics />}
              {page === 'history' && <CallHistory />}
              {page === 'settings' && <SettingsPage />}
              {page === 'setup' && <Setup />}
            </>}
        </main>
      </div>
    </div>
    {toast && <div className="toast"><span role="status">{toast}</span><Button variant="ghost" aria-label="Dismiss message" onClick={() => setToast('')}><X size={17} /></Button></div>}
  </PilotContext.Provider>
}
createRoot(document.getElementById('root')!).render(<App />)
