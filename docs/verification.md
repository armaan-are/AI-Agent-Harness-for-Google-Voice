# Verification and troubleshooting

## Automated verification

Run `npm test` for the Node suite. Run `npm run build` followed by `npm run test:browser` for the Chrome suite. To test the Vite development server, run `npm run test:browser -- --dev`. The browser runner uses an isolated local profile, a temporary database, synthetic device inputs, and a mocked ElevenLabs WebSocket. It uses port 33272 by default. Override with `VOICEPILOT_TEST_PORT` if occupied.

## Record the checks

| Check | Procedure | Pass condition |
| --- | --- | --- |
| Device inventory | Run `npm run doctor`. In Chrome, allow microphone access and reload devices in Audio Diagnostics. | Core Audio and Chrome expose BlackHole 2ch and 16ch. Verify the physical headphones and microphone separately. |
| Local caller path | Save both virtual device selections. Run **Test Google Voice → agent**. | VoicePilot matches four reference tones at the intended input. The other virtual input does not match the signature. |
| Local agent path | Run **Test agent → Google Voice**. | The Google Voice virtual microphone path receives the four-tone signature. The caller input does not match. |
| Physical audio | Run **Test microphone** and **Test speakers** with the selected physical devices. | Speak and see your microphone meter move. Hear the speaker tone in your headphones. |
| ElevenLabs connection | Save the key and run **Test Connection** for the selected agent. | ElevenLabs confirms the agent is readable. A subsequent conversation start verifies conversation permission. |
| Outgoing Google Voice | Place a call to a consenting tester. Confirm it is connected and consent is recorded in VoicePilot. Start AI Agent. Have the tester say a unique phrase. | Tester hears the AI greeting. VoicePilot shows the phrase in the caller transcript. Tester hears a relevant response. |
| Incoming Google Voice | Arm VoicePilot, then have the tester call. Answer in Google Voice. Confirm connection and consent locally, then start AI Agent. | Standby never starts a conversation automatically. Tester hears the AI and VoicePilot receives their speech after manual activation. |
| Barge-in and mute | Tester interrupts the AI midsentence. Cycle input mute, output mute, pause, and resume. | Interruption clears queued speech. With input muted, tester speech does not reach the agent. With output muted, the tester does not hear the AI. Pause gates both directions. |
| Human takeover | Select **Take Over**, speak into your physical mic, and ask the caller if they hear you. | Mic signal appears locally and caller confirms audibility. AI audio stays gated. If manual switching was required, restore the virtual selections before resuming. |
| Sensitive decision | Ask tester to propose a test charge or authentication. Verify the configured ElevenLabs client tool sends the precise details. Test denial first. | The approval is visible while AI audio is gated. Authentication requires human takeover. No acceptance on denial. |
| Emergency stop | Use Emergency Stop while the agent is speaking. | Caller hears the AI stop immediately. The dashboard shows the AI session ended and the Google Voice call can still be hung up manually. |
| History | Enable transcript storage and opt in for one test call. End the AI, open Call History, search for the tester's phrase, and export each format. | The local call ID, direction, timings, transcript, summary, and notes are available. For a second call without the opt-in, verify the stored record has no transcript. |
| Device and tab failure | During a consenting test, disconnect a selected USB monitoring device or reload VoicePilot. | The AI session ends without restarting. Open Google Voice and switch to physical devices if you need to keep talking. |

Do the local tone tests before a live call. Diagnostics play audio into the selected outputs and should not run during a Google Voice call. Report the observed results for each test direction. A route selection or moving local meter cannot prove what the tester hears.

## When something fails

### Chrome cannot see BlackHole

- Check the two devices in Audio MIDI Setup and restart macOS after installing the drivers. In Chrome, grant microphone access at the exact VoicePilot address and port and enumerate again.
- Match the Google Voice and VoicePilot selections. Chrome may issue new per-origin IDs after site data, permissions, or the URL change. Reselect the named devices.
- Use specific device entries. The default audio sink can change when headphones connect or a driver disappears.

### The test fails or the caller cannot hear the agent

- Use both 48 kHz BlackHole devices, check channels 1–2 in Audio MIDI Setup and confirm they are unmuted. The bridge sends a mono voice signal over Chrome's selected device.
- Use Google Voice's headset menu to check its microphone and speaker selections. While VoicePilot is transmitting on the agent route, Google Voice's microphone activity indicator should react. Have the tester confirm actual audibility.
- If the local agent path passes but Google Voice does not offer the virtual microphone or speaker, restart Chrome and recheck the supported device selectors. The app cannot force a site to accept a virtual device. Verify in that Chrome and Google Voice account before relying on the integration.
- If the AI cannot hear the tester, check the caller input meter and Google Voice speaker selection. For audible monitoring, select physical headphones in VoicePilot.

### The same tone is detected on both paths

- Use the two different BlackHole devices. Check for monitoring software or macOS aggregate and multi-output devices that mirror one path into the other.
- Keep ringing and system sounds on physical output. Use headphones for takeover and monitoring to reduce acoustic pickup.
- The live safeguard uses sustained spectral similarity to flag likely bleed. Retest with the tone probe after a suspected echo incident. Device routing and peer confirmation determine whether the path is clean.

### ElevenLabs refuses to connect or the greeting is unexpected

- Validate the agent ID, access mode and permissions with Test Connection. Private agents require a key authorized to generate signed URLs. Start again for a fresh signed URL.
- Verify the agent allows prompt and first-message overrides when they are enabled. With overrides disabled the platform agent must already have the disclosure greeting and approval instructions.
- Review ElevenLabs plan limits, agent origin restrictions, enabled client events, and agent audio formats. VoicePilot's WebSocket audio path accepts PCM and μ-law. The provider may close a session during a longer silence or hold based on its timeout configuration.
- The ElevenLabs summary endpoint may report processing for a short period after the call. Retry when the provider has finished. Local evidence summaries are available immediately.

### Server won't start or audio stops when Chrome goes away

- If the port is taken, leave the other process alone and choose another port. If the data-directory lock is held, stop the other VoicePilot process or choose a separate private `VOICEPILOT_DATA_DIR`.
- VoicePilot's Chrome tab owns the audio contexts, microphone streams and ElevenLabs WebSocket. Keep it open and keep the Mac awake. The server owns SQLite and finalizes an abandoned session when its browser lease disappears.
- VoicePilot cannot reliably observe a separate Google Voice tab shutting down or hanging up. End the AI yourself immediately when the phone call ends.
- During device replacement the agent is paused. Verify Google Voice uses the matching endpoints before resuming. If opening the replacement fails, the previous route remains paused. An unplugged active device ends the session.

## Component notes

- **Browser** · React app, Chrome MediaDevices for exact inputs, Web Audio sink routing, AudioWorklet for capture and sample-rate conversion. Each received audio chunk is scheduled to a dedicated Web Audio output. The monitoring path is separate and carries the caller only.
- **ElevenLabs** · Official SDK WebSocket transport, negotiated audio formats and documented conversation events. VoicePilot handles audio directly to enforce synchronous mute, interruption and emergency audio gating. The browser receives only the signed URL for a private session. The SDK cannot abort a handshake in progress. VoicePilot closes late connections as soon as they are returned and never opens their audio gates after cancellation.
- **Local backend** · Express bound to IPv4 loopback, same-origin HTTP controls and WebSocket owner leases, SQLite with a private directory. Only one VoicePilot process can use a given data directory. API keys are handled through a server-rendered password form and never included in settings responses, SQLite, or request logs. Local processes with access to your macOS user account can read user-owned storage.
