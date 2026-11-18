import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { Store } from '../server/store.js'
import { ElevenLabs } from '../server/eleven.js'
import { createApp } from '../server/app.js'
import { defaultInstructions, planSchema, settingsSchema } from '../shared/model.js'

const id = 'agent_customer_service'
const plan = planSchema.parse({
  direction: 'outgoing', label: 'Support', phone: '555-0142', objective: 'Ask about a refund',
  context: '', instructions: defaultInstructions, agentId: id, confirmed: true, consent: true, saveTranscript: true,
})

test('validates consent, devices, agents and settings', () => {
  assert.equal(planSchema.safeParse({ ...plan, consent: false }).success, false)
  assert.equal(planSchema.safeParse({ ...plan, confirmed: false }).success, false)
  assert.equal(settingsSchema.safeParse({ port: 80 }).success, false)
  assert.equal(settingsSchema.safeParse({ audio: { inputGain: 3 } }).success, false)
  assert.equal(settingsSchema.safeParse({ selectedAgent: id }).success, false)
  assert.equal(settingsSchema.parse({}).transcriptStorage, false)
})

test('persists session state, idempotent transcript corrections, search and end summary', () => {
  const store = new Store(':memory:')
  const call = store.create(plan)
  assert.equal(store.update(call.id, { type: 'active' }), undefined)
  store.update(call.id, { type: 'connected', conversationId: 'conv_123' })
  const event = { id: 'turn1', role: 'user', text: 'I will email you about the refund.', at: 100 } as const
  store.update(call.id, { type: 'transcript', row: event })
  store.update(call.id, { type: 'transcript', row: { ...event, text: 'I will email you about the replacement.' } })
  assert.equal(store.get(call.id)?.transcript.length, 1)
  assert.equal(store.list('refund').length, 1)
  assert.equal(store.list('replacement').length, 1)
  assert.equal(store.list('%').length, 0)
  assert.equal(store.update(call.id, { type: 'paused' })?.status, 'paused')
  assert.equal(store.update(call.id, { type: 'takeover' })?.status, 'takeover')
  assert.equal(store.update(call.id, { type: 'active' })?.status, 'active')
  const ended = store.update(call.id, { type: 'ended' })
  assert.match(ended?.summary?.commitments[0] || '', /replacement/)
  assert.equal(store.update(call.id, { type: 'active' }), undefined)
  const ephemeral = store.create({ ...plan, saveTranscript: false })
  store.update(ephemeral.id, { type: 'connected', conversationId: 'conv_456' })
  store.update(ephemeral.id, { type: 'transcript', row: event })
  store.recover()
  assert.equal(store.get(ephemeral.id)?.transcript.length, 0)
  assert.equal(store.get(ephemeral.id)?.status, 'ended')
  store.db.close()
})

test('local API and socket reject foreign origins and enforce exclusive sessions', async () => {
  const store = new Store(':memory:')
  let key = ''
  let deny = false
  const eleven = new ElevenLabs({ get: () => key, set: value => { key = value } }, async (url, options) => {
    assert.match(String(url), /https:\/\/api.elevenlabs.io\/v1\/convai\//)
    assert.equal((options?.headers as Record<string, string>)['xi-api-key'], 'test-secret')
    return deny ? new Response(null, { status: 429 }) : Response.json({
      name: 'Support', signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?signature=test',
    })
  })
  const local = createApp(store, eleven)
  local.app.use(local.handleErrors)
  local.server.listen(0, '127.0.0.1')
  await once(local.server, 'listening')
  const address = local.server.address()
  assert(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const wsUrl = origin.replace('http:', 'ws:') + '/events'
  const typedFetch = (path: string, method = 'GET', data?: object, more?: Record<string, string>) =>
    fetch(origin + '/api' + path, { method, headers: {
      'x-voicepilot': 'local', 'content-type': 'application/json', ...more,
    }, body: data && JSON.stringify(data) })
  try {
    assert.equal((await fetch(origin + '/api/settings')).status, 403)
    assert.equal((await typedFetch('/settings', 'GET', undefined, { origin: 'https://example.com' })).status, 403)
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      get(origin + '/api/settings', { headers: { host: 'example.com', 'x-voicepilot': 'local' } }, res => {
        res.resume()
        resolve(res.statusCode)
      }).on('error', reject)
    })
    assert.equal(foreignHost, 403)
    const foreign = new WebSocket(wsUrl, { origin: 'https://example.com' })
    await assert.rejects(once(foreign, 'open'), /403/)
    assert.equal((await typedFetch('/secret', 'PUT', { key: 'test-secret' })).status, 200)
    assert.equal((await typedFetch('/settings', 'PUT', { agents: [{ id, name: 'Support', private: true }], selectedAgent: id, transcriptStorage: true })).status, 200)
    const settings = await (await typedFetch('/settings')).text()
    assert(!settings.includes('test-secret'))
    assert.equal((await typedFetch('/agents/test', 'POST', { id })).status, 200)
    const socket = new WebSocket(wsUrl, { origin })
    const [message] = await once(socket, 'message')
    const { owner } = JSON.parse(message.toString())
    const start = () => typedFetch('/sessions', 'POST', { owner, plan })
    deny = true
    assert.equal((await start()).status, 502)
    deny = false
    const response = await start()
    assert.equal(response.status, 201)
    const { call, authorization } = await response.json()
    assert.match(authorization.signedUrl, /^wss:/)
    assert.equal((await start()).status, 409)
    const changed = once(socket, 'message')
    socket.send(JSON.stringify({ type: 'connected', conversationId: 'conv_1' }))
    await changed
    assert.equal(store.get(call.id)?.status, 'active')
    const observer = new WebSocket(wsUrl, { origin })
    await once(observer, 'message')
    const ended = once(observer, 'message')
    socket.close()
    await ended
    observer.close()
    assert.equal(store.get(call.id)?.status, 'ended')
  } finally {
    await local.close()
    store.db.close()
  }
})
