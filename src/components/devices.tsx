import { Check, Field } from './ui.js'
import { specific, virtual } from '../audio-routing.js'
import { usePilot } from '../context.js'
import type { AudioSettings } from '../../shared/model.js'

export function DeviceSelect({ label, value, onChange, kind, only, optional = false, disabled = false, hint }:
  { label: string; value: string; onChange(value: string): void; kind: 'audioinput' | 'audiooutput'; only?: 'physical' | 'virtual'; optional?: boolean; disabled?: boolean; hint?: string }) {
  const { devices } = usePilot()
  const options = devices.filter(device => specific(device.deviceId) && device.label && device.kind === kind &&
    (!only || virtual(device) === (only === 'virtual')))
  return <Field label={label} hint={hint}>
    <select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">{optional ? 'Off' : 'Select a device'}</option>
      {value && !options.some(device => device.deviceId === value) && <option value={value}>Unavailable device</option>}
      {options.map(device => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
    </select>
  </Field>
}

export function AudioFields({ audio, onChange, locked = false, gainsOnly = false }:
  { audio: AudioSettings; onChange(value: AudioSettings): void; locked?: boolean; gainsOnly?: boolean }) {
  const set = <K extends keyof AudioSettings,>(key: K, value: AudioSettings[K]) => onChange({ ...audio, [key]: value })
  return <div className="stack">
    {!gainsOnly && <div className="field-grid">
      <DeviceSelect label="Caller input" kind="audioinput" only="virtual" value={audio.input} onChange={value => set('input', value)} disabled={locked} hint="BlackHole 2ch" />
      <DeviceSelect label="AI output to call" kind="audiooutput" only="virtual" value={audio.output} onChange={value => set('output', value)} disabled={locked} hint="BlackHole 16ch" />
      <DeviceSelect label="Monitor through" kind="audiooutput" only="physical" optional value={audio.monitor} onChange={value => set('monitor', value)} disabled={locked} hint="Headphones recommended. Caller audio only." />
      <DeviceSelect label="Takeover microphone" kind="audioinput" only="physical" optional value={audio.microphone} onChange={value => set('microphone', value)} disabled={locked} />
    </div>}
    <div className={gainsOnly ? 'stack compact' : 'field-grid'}>
      {([['inputGain', 'Caller input gain', 2], ['outputGain', 'AI output gain', 2], ['monitorGain', 'Monitoring volume', 1]] as const).map(([key, label, max]) =>
        <Field key={key} label={label + ' · ' + Math.round(audio[key] * 100) + '%'}>
          <input type="range" min={0} max={max} step={0.01} value={audio[key]} onChange={event => set(key, Number(event.target.value))} />
        </Field>)}
    </div>
    <Check value={audio.echoGuard} onChange={value => set('echoGuard', value)}>Stop the AI if sustained audio bleed is detected</Check>
  </div>
}
