import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function doctor() {
  const mac = process.platform === 'darwin'
  const chrome = ['/Applications', join(homedir(), 'Applications')]
    .map(root => join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
    .find(existsSync)
  const [major, minor] = process.versions.node.split('.').map(Number)
  const node = major > 22 || major === 22 && minor >= 13
  const dependencies = existsSync('node_modules/@elevenlabs/client/package.json')
  const audio = mac ? spawnSync('/usr/sbin/system_profiler', ['SPAudioDataType'], { encoding: 'utf8', timeout: 8000 }).stdout || '' : ''
  const results = [
    [mac, 'macOS', mac ? process.arch : 'Run audio on a Mac.'],
    [node, 'Node.js', process.version + ' (minimum v22.13)'],
    [dependencies, 'Dependencies', dependencies ? 'Installed' : 'Run npm install.'],
    [Boolean(chrome), 'Google Chrome', chrome || 'Install or update Google Chrome.'],
    ...['2ch', '16ch'].map(channels => {
      const name = 'BlackHole ' + channels
      const installed = existsSync('/Library/Audio/Plug-Ins/HAL/BlackHole' + channels + '.driver')
      return [audio.includes(name), name, audio.includes(name) ? 'Visible to Core Audio' : installed
        ? 'Driver installed. Restart macOS, then check Audio MIDI Setup.' : 'Install with brew install --cask blackhole-' + channels]
    }),
  ]
  for (const [ok, label, details] of results) console.log(`${ok ? '✓' : '!'}  ${label}  ${details}`)
  console.log('Chrome microphone permission, device isolation, and phone-call audio must be checked in the dashboard.')
  return results.every(([ok]) => ok)
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) process.exitCode = doctor() ? 0 : 1
