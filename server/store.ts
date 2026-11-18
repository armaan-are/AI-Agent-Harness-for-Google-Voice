import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { settingsSchema, type CallRecord, type Plan, type SessionUpdate, type Settings, type Summary, type Transcript } from '../shared/model.js'

const transitions: Record<CallRecord['status'], CallRecord['status'][]> = {
  connecting: ['active', 'ended'],
  active: ['paused', 'takeover', 'ended'],
  paused: ['active', 'takeover', 'ended'],
  takeover: ['active', 'paused', 'ended'],
  ended: [],
}

export function summarize(call: CallRecord): Summary {
  const representative = call.transcript.filter(row => row.role === 'user')
  const quote = (row: Transcript) => 'Representative said: “' + row.text + '”'
  const matches = (pattern: RegExp) => representative.filter(row => pattern.test(row.text)).slice(-4).map(quote)
  return {
    reason: call.objective || 'No objective entered.',
    mainPoints: representative.slice(0, 8).map(quote),
    outcome: 'Outcome requires human review.',
    refund: 'No refund or credit independently confirmed. ' + matches(/\b(refund|credit|reimburse)\b/i).join(' '),
    reference: matches(/\b(case|reference|ticket|confirmation)\b/i).join(' ') || 'No reference identified in the saved transcript.',
    commitments: matches(/\b(I will|we will|we can|I can|we’ll|I’ll)\b/i),
    followUp: matches(/\b(next step|follow.up|email|call back|business days)\b/i),
    unresolved: 'Review the transcript and confirm any outstanding actions.',
  }
}

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript (
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (call_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS calls_started ON calls(started DESC);
    `)
    if (!this.db.prepare('PRAGMA table_info(calls)').all().some(column => column.name === 'last_seen')) {
      this.db.exec('ALTER TABLE calls ADD COLUMN last_seen INTEGER')
    }
    this.recover()
  }

  getSettings(): Settings {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get()
    return settingsSchema.parse(row ? JSON.parse(String(row.data)) : {})
  }

  setSettings(settings: Settings) {
    this.db.prepare('INSERT INTO settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(settings))
    this.prune()
  }

  private save(call: CallRecord) {
    const { transcript: _transcript, ...data } = call
    this.db.prepare(`
      INSERT INTO calls (id, started, ended, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ended = excluded.ended, data = excluded.data
    `).run(call.id, call.startedAt, call.endedAt, JSON.stringify(data))
  }

  create(plan: Plan) {
    const call: CallRecord = {
      id: randomUUID(), direction: plan.direction, label: plan.label, phone: plan.phone,
      objective: plan.objective, agentId: plan.agentId, startedAt: Date.now(), connectedAt: null,
      endedAt: null, conversationId: null, duration: 0, status: 'connecting', endReason: '',
      saveTranscript: plan.saveTranscript, notes: '', summary: null, providerSummary: '', transcript: [],
    }
    this.save(call)
    return call
  }

  get(id: string, includeTranscript = true): CallRecord | undefined {
    const row = this.db.prepare('SELECT data FROM calls WHERE id = ?').get(id)
    if (!row) return
    const call = JSON.parse(String(row.data)) as CallRecord
    call.transcript = includeTranscript
      ? this.db.prepare('SELECT data FROM transcript WHERE call_id = ? ORDER BY rowid').all(id)
        .map(entry => JSON.parse(String(entry.data)) as Transcript)
      : []
    return call
  }

  list(search = '') {
    const pattern = '%' + search.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%'
    const rows = this.db.prepare(`
      SELECT data FROM calls WHERE ? = '' OR lower(data) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM transcript WHERE call_id = calls.id AND lower(transcript.data) LIKE ? ESCAPE '\\')
      ORDER BY started DESC
    `).all(search, pattern, pattern)
    return rows.map(row => ({ ...JSON.parse(String(row.data)), transcript: [] }) as CallRecord)
  }

  update(id: string, event: SessionUpdate, lastSeen = Date.now()) {
    const call = this.get(id, event.type === 'ended')
    if (!call || call.status === 'ended') return
    if (event.type === 'transcript') {
      if (call.saveTranscript && call.connectedAt) {
        this.db.prepare('INSERT INTO transcript VALUES (?, ?, ?) ON CONFLICT(call_id, event_id) DO UPDATE SET data = excluded.data')
          .run(id, event.row.id, JSON.stringify(event.row))
      }
      return call
    }
    const status = event.type === 'connected' ? 'active' : event.type
    if (!transitions[call.status].includes(status) || (event.type === 'active' && !call.connectedAt)) return
    call.status = status
    if (event.type === 'connected') {
      call.connectedAt = Date.now()
      call.conversationId = event.conversationId
    }
    if (event.type === 'ended') {
      call.endedAt = Math.max(lastSeen, call.connectedAt ?? call.startedAt)
      call.duration = call.connectedAt ? Math.round((call.endedAt - call.connectedAt) / 1000) : 0
      call.endReason = event.reason || 'Ended'
      call.summary = summarize(call)
    }
    this.save(call)
    return call
  }

  notes(id: string, notes: string) {
    const call = this.get(id)
    if (call?.status !== 'ended') return
    call.notes = notes
    this.save(call)
    return call
  }

  setProviderSummary(id: string, summary: string) {
    const call = this.get(id)
    if (!call || call.status !== 'ended' || !call.saveTranscript) return
    call.providerSummary = summary
    this.save(call)
    return call
  }

  remove(id?: string) {
    if (id) this.db.prepare('DELETE FROM calls WHERE id = ? AND ended IS NOT NULL').run(id)
    else this.db.exec('DELETE FROM calls WHERE ended IS NOT NULL')
  }

  prune() {
    const days = this.getSettings().retentionDays
    if (days) this.db.prepare('DELETE FROM calls WHERE ended < ?').run(Date.now() - days * 86400000)
  }

  markAlive(id: string, time: number) {
    this.db.prepare('UPDATE calls SET last_seen = ? WHERE id = ? AND ended IS NULL').run(time, id)
  }

  recover() {
    for (const row of this.db.prepare('SELECT id, coalesce(last_seen, started) AS known_until FROM calls WHERE ended IS NULL').all()) {
      this.update(String(row.id), { type: 'ended', reason: 'Local server interrupted' }, Number(row.known_until))
    }
  }
}
