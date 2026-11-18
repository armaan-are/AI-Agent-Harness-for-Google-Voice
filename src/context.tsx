import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'
import type { CallRecord, Settings } from '../shared/model.js'
import type { Health } from './api.js'
import type { Device } from './audio-routing.js'
import type { Meter } from './audio.js'
import type { LiveState, Session } from './session.js'

export type Draft = {
  direction: 'incoming' | 'outgoing'; label: string; phone: string; objective: string;
  instructions: string; context: string; agentId: string; confirmed: boolean; consent: boolean; saveTranscript: boolean
}
export const blankDraft: Draft = {
  direction: 'outgoing', label: '', phone: '', objective: '', instructions: '', context: '',
  agentId: '', confirmed: false, consent: false, saveTranscript: false,
}
export type Page = 'dashboard' | 'active' | 'incoming' | 'outgoing' | 'agents' | 'history' | 'diagnostics' | 'settings' | 'setup'
export type RouteEvidence = { key: string; receive: boolean; send: boolean }
export const routeKey = (settings: Settings) => settings.audio.input + ':' + settings.audio.output
export const liveSession = (live: LiveState) => !['idle', 'ended'].includes(live.phase)
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  return String(minutes).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}
export const dateTime = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

type Pilot = {
  page: Page
  go(page: Page): void
  health?: Health
  ready: boolean
  hasKey: boolean
  setHasKey: Dispatch<SetStateAction<boolean>>
  verifiedAgent: string
  setVerifiedAgent: Dispatch<SetStateAction<string>>
  settings: Settings
  save(settings: Settings): Promise<void>
  devices: Device[]
  refreshDevices(permission?: boolean): Promise<Device[]>
  history: CallRecord[]
  refreshHistory(): void
  draft: Draft
  setDraft: Dispatch<SetStateAction<Draft>>
  engine: Session
  live: LiveState
  meter: Meter
  evidence: RouteEvidence
  setEvidence: Dispatch<SetStateAction<RouteEvidence>>
  gvChecklist: boolean
  setGvChecklist: Dispatch<SetStateAction<boolean>>
  armed: boolean
  possibleAudio: boolean
  arm(): Promise<void>
  disarm(): void
  start(): void
  flash(text: string): void
}
export const PilotContext = createContext<Pilot | null>(null)
export function usePilot() {
  const value = useContext(PilotContext)
  if (!value) throw new Error('VoicePilot context is missing.')
  return value
}
