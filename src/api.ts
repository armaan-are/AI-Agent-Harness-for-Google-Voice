import type { Settings } from '../shared/model.js'

export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api' + path, {
    method, signal, cache: 'no-store',
    headers: { 'x-voicepilot': 'local', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    throw new Error(detail.error || 'VoicePilot request failed (' + response.status + ').')
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export type Bootstrap = { settings: Settings; hasKey: boolean }
export type Health = { ok: boolean; mac: boolean; chrome: boolean; node: string; drivers: boolean[]; port: number }

export class LocalSocket {
  owner = ''
  private socket?: WebSocket
  private retry?: number
  private disposed = false

  constructor(private onStatus: (ready: boolean) => void, private changed: () => void) { this.connect() }

  private connect() {
    const socket = this.socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/events')
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.type === 'ready') {
        this.owner = message.owner
        this.onStatus(true)
      } else if (message.type === 'changed') this.changed()
    }
    socket.onclose = () => {
      this.owner = ''
      if (this.disposed) return
      this.onStatus(false)
      this.retry = window.setTimeout(() => this.connect(), 1500)
    }
  }

  send(message: object) {
    if (!this.owner || this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  close() {
    this.disposed = true
    window.clearTimeout(this.retry)
    this.socket?.close()
  }
}
