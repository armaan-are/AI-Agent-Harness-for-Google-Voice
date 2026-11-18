import type { Response } from 'express'

export function credentialPage(res: Response, options: { saved?: boolean; invalid?: boolean } = {}) {
  const { saved = false, invalid = false } = options
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  })
  res.type('html').send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ElevenLabs credentials · VoicePilot</title>
<style>
  :root { color-scheme: dark; font: 16px -apple-system, BlinkMacSystemFont, sans-serif; background: #101216; color: #eff1f3; }
  main { max-width: 480px; margin: 10vh auto; background: #171b21; padding: 28px; border: 1px solid #2a3039; border-radius: 14px; }
  body { padding: 0 12px; } p { color: #a9b5c2; line-height: 1.5; }
  h1 { font-size: 27px; margin-top: 0; letter-spacing: -.03em; }
  label, input { display: block; } input { box-sizing: border-box; width: 100%; margin: 8px 0 16px; border-radius: 8px; padding: 10px; border: 1px solid #46535f; background: #12161c; color: #eff1f3; }
  button { border: 0; font: inherit; font-weight: 650; border-radius: 8px; background: #a5ead9; color: #122823; padding: 9px 13px; cursor: pointer; }
  a { color: #a5ead9; } [role=alert] { color: #f3a6ad; }
</style>
<main>
  <h1>ElevenLabs API key</h1>
  ${saved ? '<p role="status">Key saved on this Mac. Close this tab and return to your VoicePilot workspace.</p>' :
    `<p>VoicePilot uses this key to verify access and obtain temporary signed URLs for private agents.</p>
  ${invalid ? '<p role="alert">Enter a valid, nonempty key.</p>' : ''}
  <form method="post" action="/credentials" autocomplete="off">
    <label for="key">API key</label>
    <input id="key" name="key" type="password" required maxlength="1024" autocomplete="off" spellcheck="false">
    <button type="submit">Save API Key</button>
  </form>`}
  <p><a href="/#/settings">Open VoicePilot Settings</a></p>
</main>
</html>`)
}
