import express from 'express'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { z, ZodError } from 'zod'
import { agentId, planSchema, settingsSchema, updateSchema } from '../shared/model.js'
import { ElevenLabs, ServiceError } from './eleven.js'
import { Store } from './store.js'

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const hostPattern = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/
const startSchema = z.object({ owner: z.uuid(), plan: planSchema })

export function createApp(store: Store, eleven: ElevenLabs, readiness: () => object = () => ({})) {
  const app = express()
  const server = createServer(app)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 98304 })
  const clients = new Map<string, WebSocket>()
  let current: { id: string; owner: string; lastSeen: number } | undefined
  const send = (socket: WebSocket, data: object) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data))
  }
  const notify = () => clients.forEach(socket => send(socket, { type: 'changed' }))
  const finish = (reason: string, lastSeen?: number) => {
    if (!current) return
    store.update(current.id, { type: 'ended', reason }, lastSeen)
    current = undefined
    notify()
  }
  const validAddress = (host?: string, address?: string) => Boolean(host && hostPattern.test(host) && address && loopback.has(address))
  const sameOrigin = (host?: string, origin?: string) => origin === 'http://' + host

  app.disable('x-powered-by')
  app.use((req, res, next) => {
    if (!validAddress(req.headers.host, req.socket.remoteAddress)) return res.sendStatus(403)
    res.set({
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self), speaker-selection=(self), camera=()',
    })
    next()
  })
  const api = express.Router()
  app.use('/api', api)
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (req.get('x-voicepilot') !== 'local' ||
      (req.headers.origin && !sameOrigin(req.headers.host, req.headers.origin)) ||
      (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site')!))) return res.sendStatus(403)
    next()
  })
  api.use(express.json({ limit: '1mb' }))
  api.get('/health', (_req, res) => res.json({ ok: true, node: process.versions.node, ...readiness() }))
  api.get('/settings', (_req, res) => res.json({ settings: store.getSettings(), hasKey: Boolean(eleven.secrets.get()) }))
  api.put('/settings', (req, res) => {
    store.setSettings(settingsSchema.parse(req.body))
    notify()
    res.json({ ok: true })
  })
  api.put('/secret', (req, res) => {
    const { key } = z.object({ key: z.string().trim().max(1024).regex(/^[\x21-\x7e]*$/) }).parse(req.body)
    eleven.secrets.set(key)
    res.json({ hasKey: Boolean(key) })
  })
  api.post('/agents/test', async (req, res) => {
    const { id } = z.object({ id: agentId }).parse(req.body)
    res.json(await eleven.test(id))
  })
  api.get('/calls', (req, res) => {
    const search = z.string().max(200).parse(req.query.q ?? '')
    store.prune()
    res.json(store.list(search))
  })
  api.get('/calls/:id', (req, res) => {
    const call = store.get(req.params.id)
    if (!call) return res.sendStatus(404)
    res.json(call)
  })
  api.patch('/calls/:id', (req, res) => {
    const { notes } = z.object({ notes: z.string().max(20000) }).parse(req.body)
    const call = store.notes(req.params.id, notes)
    if (!call) return res.sendStatus(404)
    res.json(call)
  })
  api.post('/calls/:id/summary', async (req, res) => {
    const { id } = req.params
    const call = store.get(id)
    if (!call || !call.conversationId || !call.saveTranscript || call.status !== 'ended') {
      throw new ServiceError('An ended ElevenLabs conversation with transcript storage enabled is required.')
    }
    const summary = await eleven.summary(call.conversationId)
    if (summary.status !== 'done') throw new ServiceError('ElevenLabs summary status: ' + summary.status + '.', 409)
    if (!summary.transcript_summary) throw new ServiceError('ElevenLabs did not provide a summary.')
    const updated = store.setProviderSummary(id, summary.transcript_summary)
    if (!updated) return res.sendStatus(404)
    res.json(updated)
  })
  api.delete('/calls/:id', (req, res) => {
    if (current?.id === req.params.id) throw new ServiceError('End the active session before deleting it.', 409)
    store.remove(req.params.id)
    res.sendStatus(204)
  })
  api.delete('/calls', (_req, res) => {
    store.remove()
    res.sendStatus(204)
  })
  api.post('/sessions', async (req, res) => {
    const { owner, plan } = startSchema.parse(req.body)
    if (clients.get(owner)?.readyState !== WebSocket.OPEN) throw new ServiceError('Connect to the local session server first.', 409)
    if (current) throw new ServiceError('Another VoicePilot session is active or connecting.', 409)
    const settings = store.getSettings()
    const agent = settings.agents.find(item => item.id === plan.agentId)
    if (!agent) throw new ServiceError('Select a saved agent.')
    const call = store.create({ ...plan, saveTranscript: plan.saveTranscript && settings.transcriptStorage })
    current = { id: call.id, owner, lastSeen: Date.now() }
    notify()
    try {
      const authorization = agent.private ? { signedUrl: await eleven.signedUrl(agent.id) } : { agentId: agent.id }
      if (current?.id !== call.id) throw new ServiceError('Session was cancelled.', 409)
      res.status(201).json({ call, authorization })
    } catch (error) {
      if (current?.id === call.id) finish('ElevenLabs authorization failed')
      throw error
    }
  })
  api.post('/sessions/cancel', (req, res) => {
    const { owner } = z.object({ owner: z.uuid() }).parse(req.body)
    if (current?.owner === owner) finish('Cancelled by operator')
    res.sendStatus(204)
  })
  api.use((_req, res) => res.sendStatus(404))

  server.on('upgrade', (req, socket, head) => {
    const { host, origin } = req.headers
    if (req.url !== '/events') return
    if (!validAddress(host, req.socket.remoteAddress) || !sameOrigin(host, origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws))
  })
  sockets.on('connection', (socket: WebSocket) => {
    const owner = randomUUID()
    clients.set(owner, socket)
    send(socket, { type: 'ready', owner })
    socket.on('message', data => {
      if (current?.owner !== owner) return
      let raw: unknown
      try { raw = JSON.parse(String(data)) } catch { return }
      current.lastSeen = Date.now()
      if (typeof raw === 'object' && raw && 'type' in raw && raw.type === 'heartbeat') return
      const event = updateSchema.safeParse(raw)
      if (!event.success) return
      if (event.data.type === 'ended') {
        finish(event.data.reason || 'Ended by operator')
        return
      }
      const updated = store.update(current.id, event.data)
      if (updated && event.data.type !== 'transcript') notify()
    })
    socket.on('error', () => socket.terminate())
    socket.on('close', () => {
      clients.delete(owner)
      if (current?.owner === owner) finish('Browser session disconnected', current.lastSeen)
    })
  })
  const watchdog = setInterval(() => {
    if (!current || Date.now() - current.lastSeen < 20000) return
    const socket = clients.get(current.owner)
    finish('Browser session heartbeat timed out', current.lastSeen)
    socket?.terminate()
  }, 5000).unref()

  const handleErrors: express.ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: error.issues[0].message })
    } else if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message })
    } else if (error instanceof SyntaxError && 'status' in error) {
      res.status(400).json({ error: 'Malformed JSON.' })
    } else {
      if (store.getSettings().debug) console.error('[VoicePilot] Request error:', error?.name)
      res.status(500).json({ error: 'Local server could not complete the request.' })
    }
  }
  function close() {
    clearInterval(watchdog)
    finish('Local server stopped')
    clients.forEach(socket => socket.terminate())
    sockets.close()
    return new Promise<void>(resolve => server.close(() => resolve()))
  }
  return { app, server, handleErrors, close }
}
