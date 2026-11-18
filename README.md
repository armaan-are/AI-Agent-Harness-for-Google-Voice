# VoicePilot

VoicePilot connects an ElevenLabs conversational agent to a Google Voice call you place or answer in Chrome on macOS. It routes the two sides of the call through separate BlackHole devices. Use the local dashboard to prepare the agent, watch its transcript, approve specific requests, pause, take over, or end the AI session.

Keep **Terminal, the VoicePilot Chrome tab, and the Google Voice call tab** open during a call. The local Node server stores settings and history. The VoicePilot tab runs the audio session. Google Voice remains responsible for dialing, answering, and hanging up.

## Start on macOS

Install a current version of Google Chrome and Node.js 22.13 or later.

```bash
git clone git@github.com:armaan-are/AI-Agent-Harness-for-Google-Voice.git
cd AI-Agent-Harness-for-Google-Voice
npm install
npm run setup
npm run doctor
npm run dev
```

Open [VoicePilot at localhost:3000](http://localhost:3000). The setup wizard opens on first launch. The doctor exits with status 1 if a required dependency or audio device is missing.

For production, stop the development instance and run these commands.

```bash
npm run build
npm start
```

If port 3000 is occupied, use `PORT=3001 npm start` and open [localhost:3001](http://localhost:3001). `.env.example` shows the optional settings. Use the same localhost origin and port consistently because Chrome scopes device identifiers and microphone permission to the origin.

## Configure the audio paths

1. Install both drivers. The installers require administrator authentication. Restart macOS when installation finishes. [BlackHole installation instructions](https://github.com/ExistentialAudio/BlackHole#installation)

   ```bash
   brew install --cask blackhole-2ch blackhole-16ch
   ```

2. Open **Audio MIDI Setup → Window → Show Audio Devices**. Confirm both devices appear. Start with 48,000 Hz for both and unmuted first channels. Keep macOS system input and output on physical devices so notifications and other apps stay outside the call paths.
3. In **VoicePilot → Audio Diagnostics**, click **Check Permissions**. Allow microphone access at localhost and in **System Settings → Privacy & Security → Microphone** for Google Chrome. Click **Select BlackHole Pair**, select headphones for monitoring and a physical microphone for takeover, and save.
4. In [Google Voice](https://voice.google.com/), open the headset icon in the top-right corner. Choose the following devices. Allow **Microphone** and **Notifications** in Chrome’s site controls. For incoming calls, enable **Web** in **Settings → Calls** if shown. [Google Voice microphone and speaker settings](https://support.google.com/voice/answer/9188701)

| Path | Google Voice setting | VoicePilot setting |
| --- | --- | --- |
| Caller → agent | Speakers · BlackHole 2ch | Caller input · BlackHole 2ch |
| Agent or takeover mic → caller | Microphone · BlackHole 16ch | AI output · BlackHole 16ch |
| Caller → you | | Monitor through · physical headphones |
| Incoming ringtone | Ringing · physical headphones or speakers | |

Run both loopback probes before dialing. Each sends four tones down one route, measures the signature at the intended input, and checks for the same signature on the other route. A local pass covers Chrome and BlackHole. Verify Google Voice delivery with the live test below.

## Configure ElevenLabs

1. In **Agents**, enter your existing agent ID and a display name. Set **Private agent** if the agent requires authentication.
2. Choose **Enter API Key**. A local script-free form saves the key to a file with mode `0600` in the private VoicePilot data directory. Return to VoicePilot, refresh the status if needed, select the agent, and use **Test Connection**. The key needs permission to read the agent and generate signed conversation URLs for private agents. Fetching a provider summary also requires access to conversation history.
3. To customize the startup prompt and greeting, enable **System prompt** and **First message** overrides in your ElevenLabs agent’s security settings. If you keep overrides disabled, configure the disclosure and policy directly in ElevenLabs. VoicePilot sends the call briefing as context after the connection opens. The existing agent controls its voice and model. [ElevenLabs JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script) · [Agent authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication)
4. For interactive approvals, configure an ElevenLabs **Client tool** named `request_human_approval`. Enable waiting for the response, set a response timeout of at least 45 seconds, and require string parameters `action` and `details`. For identity checks, require `action` to be `authentication`. Use a descriptive action such as `accept_charge` otherwise, and include the precise terms in `details`. VoicePilot gates AI audio while a request is pending, rejects authentication approval, and denies unanswered requests after 45 seconds. Keep transaction-capable server tools disabled for this agent. The model must invoke the tool for the workflow to activate. [ElevenLabs client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools)

The default customer-service instructions require AI disclosure, forbid credential sharing and impersonation, and call for human approval or takeover on sensitive actions. Reusable templates are available on the Agents page.

## Use VoicePilot during a call

- **Outgoing** · Prepare the objective, optionally copy the destination number, and dial in Google Voice. Connect before confirming the call in VoicePilot.
- **Incoming** · Answer in Google Voice. Optional **Arm Agent** listens locally for signal and never opens a billable agent session. Confirm the connection yourself, even when VoicePilot detects audio.
- **Start** · Disclose AI participation and obtain applicable consent before confirming and starting the agent. Use physical headphones to hear the caller. The monitor carries the caller only.
- **Pause** · Both AI audio directions are gated. The connection remains open for up to two minutes, so provider usage may continue during the hold.
- **Take over** · VoicePilot gates AI audio and attempts to route the selected physical microphone into the Google Voice microphone path. The meter measures local microphone signal. Have the caller confirm audibility. If automatic routing fails or you need a longer takeover, switch both Google Voice devices to your physical microphone and headphones. Restore the BlackHole pair before resuming the AI.
- **End** · End AI Session and Emergency Stop close the AI path. Hang up separately in Google Voice. If you want to continue talking after ending the AI, select your physical devices in Google Voice.

## Privacy, history, and recovery

VoicePilot stores its own session records in SQLite. The default data directory is `~/Library/Application Support/VoicePilot`; the directory must have mode `0700`. The call transcript stays in memory unless you enable transcript storage in Settings and choose to save it for that call. Session metadata is saved locally under either setting. VoicePilot does not write raw call audio to disk. The ElevenLabs service receives the active AI audio and applies the agent’s own retention settings. Review those settings and confirm applicable notice and consent before starting.

Search saved transcripts and metadata in Call History. Export one call as JSON, Markdown, or text, or export all ended calls as JSON. Local summaries quote representative statements and leave uncertain outcomes for operator review. The optional ElevenLabs summary is shown separately for comparison with the transcript. Use call notes to record an outcome you have verified.

A lost local connection, lost audio device, feedback detection, or provider failure closes the AI audio route. VoicePilot does not reconnect an ended AI session automatically. Chrome and Google Voice do not share a supported call-state interface with VoicePilot. End the AI session when the phone call hangs up or the Google Voice tab closes. Closing or refreshing VoicePilot ends the AI session and the backend finalizes its record.

## Verification

```bash
npm run check
npm test
npm run build
npm run test:browser
```

Automated tests cover local API access, exclusive ownership, SQLite persistence, transcript corrections, agent events and controls with a mock transport, audio device selection, signal detection, and sample-rate conversion. The Chrome integration suite uses a disposable local database, a synthetic microphone signal, and a mocked ElevenLabs WebSocket. It exercises both call workflows, transcript persistence, audio controls, and the native credential form. These tests do not place a call or consume ElevenLabs minutes.

**Manual checks pending** · Install the two BlackHole drivers, test both local probes, then test an ElevenLabs agent with a consenting caller on both an incoming and outgoing Google Voice call. See the [verification and troubleshooting guide](docs/verification.md) for exact steps and expected results.
