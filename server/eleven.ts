import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'

export interface Secrets {
  get(): string
  set(value: string): void
}

// A private local file keeps secrets out of SQLite, shell arguments and browser storage.
export class FileSecrets implements Secrets {
  constructor(private directory: string) {}

  get() {
    const path = join(this.directory, 'elevenlabs.key')
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) {
        throw new Error('VoicePilot secret file must be owned by you and have mode 0600.')
      }
      return readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  set(value: string) {
    const path = join(this.directory, 'elevenlabs.key')
    if (!value) {
      rmSync(path, { force: true })
      return
    }
    const temporary = join(this.directory, 'key-' + randomUUID())
    try {
      writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

export class ServiceError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export class ElevenLabs {
  constructor(readonly secrets: Secrets, private request = fetch) {}

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const key = this.secrets.get()
    if (!key) throw new ServiceError('Set an ElevenLabs API key in Settings first.')
    let response: Response
    try {
      response = await this.request('https://api.elevenlabs.io/v1/convai/' + path, {
        headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(12000), redirect: 'error',
      })
    } catch {
      throw new ServiceError('ElevenLabs is unreachable. Check your internet connection.', 502)
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'ElevenLabs rejected the API key. Check its validity and permissions.',
        402: 'ElevenLabs billing or usage limits blocked this request.',
        403: 'The API key cannot access this agent or resource.',
        404: 'ElevenLabs could not find this agent or conversation.',
        429: 'ElevenLabs rate or usage limit reached. Try again later.',
      }
      throw new ServiceError(messages[response.status] ?? ('ElevenLabs returned HTTP ' + response.status + '.'), 502)
    }
    const data = schema.safeParse(await response.json().catch(() => null))
    if (!data.success) throw new ServiceError('ElevenLabs returned an unexpected response.', 502)
    return data.data
  }

  test(id: string) {
    return this.get('agents/' + encodeURIComponent(id), z.object({ name: z.string() }))
  }

  async signedUrl(id: string) {
    const { signed_url } = await this.get('conversation/get-signed-url?agent_id=' + encodeURIComponent(id),
      z.object({ signed_url: z.url().refine(value => {
        const url = new URL(value)
        return url.origin === 'wss://api.elevenlabs.io' && url.pathname === '/v1/convai/conversation'
      }) }))
    return signed_url
  }

  summary(id: string) {
    return this.get('conversations/' + encodeURIComponent(id) + '/summary',
      z.object({ status: z.string(), transcript_summary: z.string().max(30000).nullish() }))
  }
}
