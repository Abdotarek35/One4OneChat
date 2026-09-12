# One4One — WebRTC PoC

Minimal proof that two strangers can be matched and connected — video, audio, and text — before we spend time on anything else.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000` in **two separate browser tabs** (or two devices on the same network). Click **Start** in both. You should see your own camera, the other tab's camera, and be able to send text messages between them.

## What this proves

- The in-memory matching queue works (first-in-first-out pairing)
- WebRTC signaling relay (offer / answer / ICE candidates) over Socket.IO works
- A direct peer-to-peer video/audio connection can be established using Google's public STUN server
- Text messages are relayed **through the server**, not peer-to-peer — this matches the architecture decision to keep text moderatable

## What's intentionally missing (next steps, in rough priority order)

1. ~~**TURN server**~~ — done.
2. **Redis-backed queue** — state (queues, sessions, reports) still lives in one server's memory, so it only works on a single process and resets on restart. This is the next big piece — needs its own external service, same as TURN/moderation did.
3. **`recentPartners` exclusion** — right now you can get re-matched with the same tab you just skipped.
4. ~~**Age gate, text moderation, reporting**~~ — basic versions done. **Still missing: real ID-based age verification, video/image moderation, and CSAM hash-matching — see caveats.**
5. ~~**Voice-only mode, responsive layout**~~ — done.
6. ~~**IP privacy, reconnect resilience, accessibility**~~ — done, see below.

## Reliability, privacy & accessibility fixes

- **TURN-relay-only when available.** If Cloudflare TURN credentials are configured, every call is forced through the relay (`iceTransportPolicy: 'relay'`) so two strangers never see each other's IP address. Falls back to `'all'` (with a console warning) if TURN isn't set up yet — otherwise every call would simply fail outright.
- **Automatic reconnect.** If the connection state hits `failed`, the app calls `pc.restartIce()` once and tries to recover before asking the person to hit Skip.
- **TURN credential fetch has a 5s timeout** so a stalled network can't leave the UI stuck on "Connecting…" forever.
- **Screen reader support:** the status line and chat log are now `aria-live="polite"` regions, and each video tile has both a visible "You"/"Stranger" label and an `aria-label` (previously color was the only cue).


## Voice mode & responsive layout

- A **Text / Video / Voice** toggle appears before Start.
  - **Text**: no camera or mic requested at all, and no WebRTC connection is made — the chat is relayed purely through the server (Socket.IO), matching the moderation design.
  - **Voice**: only requests the microphone, hides the video tiles, shows a pulsing avatar with a waveform that reacts to the **real** incoming audio level via the Web Audio API.
  - **Video**: full camera + mic.
- Matching is **mode-aware** across all three: text-, voice-, and video-seekers each wait in their own queue, so you're never paired across modes.
- Layout adapts at three breakpoints: **mobile** (stacked, default), **tablet** ≥700px (video/controls beside a sticky chat panel), **desktop** ≥1100px (same layout, more breathing room).
- The report-reason list is now tappable rows instead of a native `<select>`, and chat messages render as colored bubbles (you = coral, stranger = teal) instead of plain text lines.

## Age gate, moderation & reporting (what's done, what isn't)

**Done, PoC-grade:**
- Age gate on first visit — a self-attestation checkbox, remembered via `localStorage`.
- Text chat is checked against OpenAI's free Moderation endpoint before being relayed; flagged messages are silently dropped.
- A working Report button — logs the report server-side and ends the session for both people.

**Setup:** get an API key at platform.openai.com, then in Replit **Secrets** add `OPENAI_API_KEY`. Without it, chat still works but is **unmoderated** — a console warning says so.

**NOT done — and these are not just "more code," they need real decisions before launch:**
- **Real age verification.** The checkbox proves nothing; anyone can tap it. Production needs an ID-based age-assurance vendor (e.g. Persona, Yoti) — a legal/compliance decision, not just an integration.
- **Video/image moderation.** Nobody is scanning camera frames yet. That needs a vendor (Hive, Azure Content Safety, AWS Rekognition) and a real budget line.
- **CSAM hash-matching.** This is the single most important missing piece and it is *not* something to casually wire up — access to hash-matching databases (Microsoft PhotoDNA, Thorn Safer) is only granted to vetted organizations, specifically to prevent abuse of the system itself. That means registering as an organization and applying through the provider, and separately setting up mandatory reporting (e.g. NCMEC's CyberTipline in the US) with legal counsel. **Do not open this app to real strangers before this exists.**
- **Persistent bans.** The report log is in-memory and tied to a socket ID that resets on refresh — a real "reported user never matches you again" needs the persistent identity from the Redis/DB step.

## TURN setup (Cloudflare Realtime)

Needed so two people on hard networks (corporate wifi, some mobile carriers) can still connect — STUN alone only covers easier networks like most home wifi.

1. In the Cloudflare dashboard, open **Realtime** (may still show as "Calls") → create a **TURN key**. Copy the `TURN_KEY_ID` and the `API_TOKEN` shown — the token is only shown once.
2. In Replit, open **Secrets** (the padlock icon in the left sidebar) and add:
   - `CF_TURN_KEY_ID` = the key ID
   - `CF_TURN_KEY_API_TOKEN` = the API token
3. Re-run the app. `/turn-credentials` will now hand out real TURN servers instead of the STUN-only fallback.
4. If the secrets aren't set, the app still works — it just quietly falls back to STUN-only, same as before.


## Moving off Replit (Render)

Replit's free tier runs into usage limits fast. Render's free web service tier doesn't require a credit card and supports WebSockets, so it's a solid next home for this project.

**1. Push this project to GitHub from inside Replit (no computer needed):**
- Open the **Tools** panel → `+` → add **Git**
- In the Git pane, connect your GitHub account
- Create a **new repository** and push

**2. Deploy on Render:**
- Go to render.com, sign up (GitHub login is easiest since it's already connected)
- **New** → **Web Service** → pick the repo you just pushed
- Render reads `render.yaml` automatically and sets the build/start commands for you
- It will prompt for the three environment variables below — add the same values you used in Replit Secrets:
  - `CF_TURN_KEY_ID`
  - `CF_TURN_KEY_API_TOKEN`
  - `OPENAI_API_KEY`
- Deploy — Render gives you an `https://<name>.onrender.com` URL, HTTPS included automatically

**One honest heads-up:** Render's free tier "spins down" a service after ~15 minutes with no traffic. The first request after that takes 30–50 seconds to wake back up — this is normal, not a bug. If that becomes a problem, Render's paid tier ($7/mo) keeps it always-on.

## Files

- `server.js` — Express + Socket.IO signaling server
- `public/index.html`, `public/app.js` — the client
- `render.yaml` — Render Blueprint, so deployment there is close to one-click
- `.gitignore` — keeps `node_modules` and any `.env` file out of GitHub
