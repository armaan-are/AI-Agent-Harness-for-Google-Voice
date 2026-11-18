import express from 'express'
import { homedir } from 'node:os'
import { mkdirSync, lstatSync, chmodSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { ElevenLabs, FileSecrets } from './eleven.js'
import { DatabaseSync } from 'node:sqlite'
import { Store } from './store.js'

const dev = process.argv.includes('--dev')
const root = process.env.VOICEPILOT_DATA_DIR
  ? resolve(process.env.VOICEPILOT_DATA_DIR)
  : join(homedir(), 'Library', 'Application Support', 'VoicePilot')
process.umask(0o077)
mkdirSync(root, { recursive: true, mode: 0o700 })
const directory = lstatSync(root)
if (!directory.isDirectory() || directory.uid !== process.getuid?.()) throw new Error('Use a private data directory that you own.')
if (directory.mode & 0o077) throw new Error('VoicePilot requires mode 0700 on its data directory: ' + root)
const dbPath = join(root, 'voicepilot.sqlite')
if (existsSync(dbPath)) {
  const stat = lstatSync(dbPath)
  if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error('VoicePilot requires a regular database file that you own.')
  chmodSync(dbPath, 0o600)
}
const runtimeLock = new DatabaseSync(join(root, 'runtime-lock.sqlite'))
try {
  runtimeLock.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS runtime_lock (placeholder INTEGER); BEGIN EXCLUSIVE')
} catch (error) {
  runtimeLock.close()
  if (error instanceof Error && /locked/i.test(error.message)) throw new Error('VoicePilot is already using this data directory.')
  throw error
}
const store = new Store(dbPath)
store.prune()
const eleven = new ElevenLabs(new FileSecrets(root))
const readiness = () => ({
  mac: process.platform === 'darwin',
  chrome: ['/Applications', join(homedir(), 'Applications')].some(path => existsSync(join(path, 'Google Chrome.app'))),
  drivers: ['2ch', '16ch'].map(name => existsSync('/Library/Audio/Plug-Ins/HAL/BlackHole' + name + '.driver')),
  port,
})
const port = Number(process.env.PORT || store.getSettings().port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set PORT to a number between 1024 and 65535.')
const local = createApp(store, eleven, readiness)
const vite = dev ? await (await import('vite')).createServer({
  server: { middlewareMode: true, hmr: { server: local.server }, allowedHosts: ['localhost', '127.0.0.1'] },
  appType: 'spa',
}) : undefined
if (vite) local.app.use(vite.middlewares)
else {
  const assets = fileURLToPath(new URL('../../web/', import.meta.url))
  local.app.use((_req, res, next) => {
    res.set('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
      `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port} wss://api.elevenlabs.io`,
    ].join('; '))
    next()
  })
  local.app.use(express.static(assets))
  local.app.get('/{*path}', (_req, res) => res.sendFile(join(assets, 'index.html')))
}
local.app.use(local.handleErrors)
local.server.listen(port, '127.0.0.1', () => {
  const status = readiness()
  console.log(`VoicePilot  http://localhost:${port}\nmacOS: ${status.mac ? 'yes' : 'no'}  Chrome: ${status.chrome ? 'installed' : 'not found'}  BlackHole drivers found: ${status.drivers.filter(Boolean).length}/2\nRun npm run doctor for setup details.`)
})
local.server.once('error', error => {
  console.error('[VoicePilot]', error.message)
  void stop(1)
})
let closing = false
async function stop(code: number) {
  if (closing) return
  closing = true
  await vite?.close()
  await local.close()
  store.db.close()
  runtimeLock.close()
  process.exitCode = code
}
process.once('SIGINT', () => void stop(0))
process.once('SIGTERM', () => void stop(0))
