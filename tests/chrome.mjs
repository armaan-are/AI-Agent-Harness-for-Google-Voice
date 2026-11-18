import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright-core'

const data = await mkdtemp(join(tmpdir(), 'voicepilot-chrome-'))
const port = Number(process.env.VOICEPILOT_TEST_PORT || 33272)
const dev = process.argv.includes('--dev')
const args = dev ? ['--import', 'tsx', 'server/index.ts', '--dev'] : ['dist/server/server/index.js']
const origin = 'http://localhost:' + port
const server = spawn(process.execPath, args, { env: { ...process.env, PORT: String(port), VOICEPILOT_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit'] })
const output = []
server.stdout.on('data', data => output.push(String(data)))
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const settingsApi = (method, body) => fetch(origin + '/api/settings', {
  method, headers: { 'x-voicepilot': 'local', 'content-type': 'application/json' }, body: body && JSON.stringify(body),
})
const nav = (page, name) => page.getByRole('navigation').getByRole('link', { name, exact: true }).click()
const button = (page, name) => page.getByRole('button', { name, exact: true })
const text = (page, value) => page.getByText(value, { exact: typeof value === 'string' })
const chrome = process.env.VOICEPILOT_CHROME || [
  '/Applications', join(homedir(), 'Applications'),
].map(root => join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')).find(existsSync)
let browser

async function verifyWorkspace() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 990 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(origin)
  await page.getByRole('heading', { name: 'Set up VoicePilot', exact: true }).waitFor()
  await text(page, 'Local server online').waitFor()
  await button(page, 'Go to Dashboard').click()
  await page.getByRole('heading', { name: 'Call workspace' }).waitFor()
  await nav(page, 'Agents')
  await page.getByLabel('Display name').fill('Chrome test agent')
  await page.getByLabel('Agent ID', { exact: true }).fill('agent_chrome_test')
  await button(page, 'Save Agent').click()
  await text(page, 'Agent saved').waitFor()
  const popup = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Enter API Key' }).click()
  const credentials = await popup
  await credentials.getByLabel('API key', { exact: true }).fill('local-test-key')
  const posted = credentials.waitForResponse(response => response.request().method() === 'POST')
  await button(credentials, 'Save API Key').click()
  assert.equal((await posted).status(), 303)
  await credentials.getByRole('status').waitFor()
  assert.equal(await credentials.locator('script').count(), 0)
  assert.equal(await readFile(join(data, 'elevenlabs.key'), 'utf8'), 'local-test-key')
  assert.equal((await stat(join(data, 'elevenlabs.key'))).mode & 0o777, 0o600)
  await credentials.close()
  await button(page, 'Refresh Key Status').click()
  await text(page, 'API key saved').waitFor()
  await nav(page, 'Outgoing Calls')
  assert(await button(page, 'Start AI Agent').isDisabled())
  await text(page, 'The Google Voice call is connected.').click()
  assert(await button(page, 'Start AI Agent').isDisabled())
  await text(page, /I disclosed AI participation/).click()
  await button(page, 'Start AI Agent').click()
  await text(page, /Caller input is unavailable/).waitFor()
  await nav(page, 'Audio Diagnostics')
  await button(page, 'Run Loopback Test').first().click()
  await text(page, 'Check failed').waitFor()
  await nav(page, 'Call History')
  await page.getByRole('searchbox').fill('No results')
  await text(page, 'No matching sessions.').waitFor()
  await button(page, 'Switch to light mode').click()
  await page.locator('html[data-theme=light]').waitFor()
  await page.reload()
  await page.locator('html[data-theme=light]').waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await button(page, 'Open navigation').click()
  await nav(page, 'Dashboard')
  await page.getByRole('heading', { name: 'Call workspace' }).waitFor()
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.deepEqual(errors, [])
  await context.close()
}

async function verifySimulatedCalls() {
  const { settings } = await (await settingsApi('GET')).json()
  assert((await settingsApi('PUT', {
    ...settings, transcriptStorage: true,
    agents: [{ id: 'agent_chrome_test', name: 'Chrome test agent', private: false }],
    audio: { ...settings.audio, input: 'caller-in', output: 'agent-out', microphone: 'human-mic' },
  })).ok)

  const context = await browser.newContext()
  await context.addInitScript(() => {
    const devices = [
      { deviceId: 'caller-in', groupId: 'caller', kind: 'audioinput', label: 'BlackHole 2ch (simulated)' },
      { deviceId: 'agent-out', groupId: 'agent', kind: 'audiooutput', label: 'BlackHole 16ch (simulated)' },
      { deviceId: 'human-mic', groupId: 'physical', kind: 'audioinput', label: 'Test headset microphone' },
    ]
    const selectSink = AudioContext.prototype.setSinkId
    const sinks = new WeakMap()
    AudioContext.prototype.setSinkId = async function (id) {
      const simulated = typeof id === 'string'
      if (simulated) sinks.set(this, id)
      await selectSink.call(this, simulated ? { type: 'none' } : id)
    }
    const sink = Object.getOwnPropertyDescriptor(AudioContext.prototype, 'sinkId')
    Object.defineProperty(AudioContext.prototype, 'sinkId', {
      get() { return sinks.get(this) ?? sink?.get?.call(this) },
    })
    navigator.mediaDevices.enumerateDevices = async () => devices
    navigator.mediaDevices.getUserMedia = async ({ audio }) => {
      const deviceId = audio?.deviceId?.exact || 'caller-in'
      const source = new AudioContext({ sampleRate: 48000 })
      await source.setSinkId({ type: 'none' })
      await source.resume()
      const oscillator = source.createOscillator()
      oscillator.frequency.value = deviceId === 'human-mic' ? 440 : 880
      const gain = source.createGain()
      gain.gain.value = 0.02
      const destination = source.createMediaStreamDestination()
      oscillator.connect(gain).connect(destination)
      oscillator.start()
      const track = destination.stream.getAudioTracks()[0]
      const stop = track.stop.bind(track)
      track.stop = () => { stop(); oscillator.stop(); void source.close() }
      return destination.stream
    }
  })
  let provider
  let connections = 0
  let chunks = 0
  const incoming = []
  await context.routeWebSocket('wss://api.elevenlabs.io/**', ws => {
    provider = ws
    const id = ++connections
    ws.onMessage(raw => {
      const event = JSON.parse(String(raw))
      if (event.type === 'conversation_initiation_client_data') ws.send(JSON.stringify({
        type: 'conversation_initiation_metadata',
        conversation_initiation_metadata_event: {
          conversation_id: 'conv_simulated_' + id, agent_output_audio_format: 'pcm_24000', user_input_audio_format: 'pcm_16000',
        },
      }))
      if (event.user_audio_chunk) {
        const decoded = Buffer.from(event.user_audio_chunk, 'base64')
        if (decoded.length === 800 && decoded.some(sample => sample !== 0)) chunks++
      } else incoming.push(event)
    })
  })
  const event = (type, payload) => provider.send(JSON.stringify({ type, ...payload }))
  const confirm = async page => {
    await text(page, 'The Google Voice call is connected.').click()
    await text(page, /I disclosed AI participation/).click()
    await text(page, 'Save the transcript and summary on this Mac.').click()
    await button(page, 'Start AI Agent').click()
    await page.getByText(/Agent listening|Agent speaking/).waitFor()
  }
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/#/outgoing')
  await text(page, 'Local server online').waitFor()
  await page.getByLabel('Destination name').fill('Synthetic support call')
  await confirm(page)
  for (let i = 0; i < 25 && chunks < 5; i++) await delay(100)
  assert(chunks >= 5, 'Chrome AudioWorklet should stream 25 ms of PCM with a nonzero signal')
  event('user_transcript', { user_transcription_event: { event_id: 1, user_transcript: 'Test reference 412.' } })
  event('agent_response', { agent_response_event: { event_id: 2, agent_response: 'I can check that.' } })
  const pcm = Buffer.alloc(24000 * 2 / 2)
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(6000 * Math.sin(offset / 18)), offset)
  event('audio', { audio_event: { audio_base_64: pcm.toString('base64'), event_id: 2 } })
  await text(page, 'Test reference 412.').waitFor()
  await text(page, 'I can check that.').waitFor()
  await text(page, 'Agent speaking').waitFor()
  event('interruption', { interruption_event: { event_id: 3 } })
  await text(page, 'Agent listening').waitFor()
  await button(page, 'Pause Agent').click()
  await text(page, 'Agent paused').waitFor()
  await delay(100)
  const count = chunks
  await delay(200)
  assert.equal(chunks, count, 'Paused bridge should gate caller audio')
  await button(page, 'Take Over').click()
  await text(page, /Your microphone is routed toward Google Voice/).waitFor()
  await button(page, 'Resume Agent').click()
  event('client_tool_call', { client_tool_call: {
    tool_name: 'request_human_approval', tool_call_id: 'tool_1', parameters: { action: 'test charge', details: 'Confirm the exact test terms' },
  } })
  await text(page, 'Confirm the exact test terms').waitFor()
  await button(page, 'Deny').click()
  for (let i = 0; i < 10 && !incoming.some(item => item.type === 'client_tool_result'); i++) await delay(40)
  assert(incoming.some(item => item.type === 'client_tool_result' && item.result.startsWith('Denied')))
  await button(page, 'End AI Session').click()
  await text(page, 'Session ended').waitFor()
  await nav(page, 'Call History')
  await text(page, 'Synthetic support call').waitFor()
  await button(page, 'View').click()
  await text(page, 'Test reference 412.').waitFor()

  await nav(page, 'Incoming Calls')
  await button(page, 'Arm Agent').click()
  await text(page, 'Possible call audio detected').waitFor()
  assert.equal(connections, 1, 'Standby must not start ElevenLabs')
  assert(await button(page, 'Start AI Agent').isDisabled())
  await confirm(page)
  await button(page, 'Emergency Stop').first().click()
  await text(page, 'Session ended').waitFor()
  assert.equal(connections, 2)
  assert.deepEqual(errors, [])
  await context.close()
}

try {
  for (let index = 0; index < 80 && server.exitCode === null && !output.join('').includes('VoicePilot  http://'); index++) await delay(125)
  assert(output.join('').includes('VoicePilot  http://'), 'VoicePilot did not start. Build first and check the test port.')
  assert(chrome, 'Install Google Chrome or set VOICEPILOT_CHROME to its executable path.')
  browser = await chromium.launch({ executablePath: chrome, headless: true })
  await verifyWorkspace()
  await verifySimulatedCalls()
  console.log('Chrome verified setup, credentials, diagnostics, responsive layout, and simulated incoming and outgoing call workflows.')
} finally {
  await browser?.close()
  if (server.exitCode === null && !server.killed) {
    const exit = once(server, 'exit')
    server.kill('SIGTERM')
    await exit
  }
  await rm(data, { recursive: true, force: true })
}
