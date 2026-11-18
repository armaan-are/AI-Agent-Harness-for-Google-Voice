import { doctor } from './doctor.mjs'
console.log('VoicePilot setup\n')
doctor()
console.log('\nTo install missing BlackHole drivers on your Mac:\n  brew install --cask blackhole-2ch blackhole-16ch\n')
console.log('Restart Chrome after installing the drivers. Run npm run dev and open http://localhost:3000 to continue setup.')
