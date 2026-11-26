# Prayer Dome Radio — 24/7 automation, AI voices and streaming

This document describes exactly what the radio system does today, what each
piece costs (nothing), what still needs external configuration, and the one
genuine infrastructure limitation that no free service removes.

---

## 1. What is live right now (zero budget, zero servers)

The website and installed PWA carry a complete radio engine
(`assets/pd-radio-live.js`). When a listener presses play on `/radio`:

1. The engine reads the schedule (Firestore `radioSchedule`, falling back to
   the built-in nine-programme timetable in `assets/pd-content-data.js`),
   using **Africa/Lusaka** time, including slots that wrap past midnight.
2. It selects the programme's playlist from the approved library
   (`worshipSongs` where `approved == true`), least-recently-played first.
3. It plays a programme introduction: a **recorded human voice** if the
   administrator uploaded one, otherwise an **AI presenter announcement**
   (see §3), otherwise silence — the music always continues.
4. It updates Now Playing, the continuous ticker, `radioNowPlaying` and a
   best-effort `radioPlaybackHistory` entry.
5. Broken tracks are skipped, failed playlists fall back to the fallback
   audio, and if Firestore is unreachable the engine keeps its last loaded
   schedule and queue.
6. An approved presenter going LIVE takes over the same player via WebRTC;
   when they stop or disconnect, automation resumes automatically.

This is a real broadcast of real, rights-cleared audio. Its only difference
from a classic radio stream is that the playout runs in each listener's
browser rather than on a central encoder.

## 2. Automatic music discovery (free sources only)

`assets/pd-radio-discovery.js` (mirrored to `functions/discovery.js` for the
scheduler — refresh with `npm run sync:radio`) searches:

| Source | Cost | Licence handling |
|---|---|---|
| **Internet Archive** (archive.org) | Free, no key | Public-domain / CC releases; licence read per item |
| **Wikimedia Commons** | Free, no key | Everything is PD or CC by policy; licence read per file |
| **Jamendo** | Free tier (optional `JAMENDO_CLIENT_ID`) | Always imported as *review required* — Jamendo's free tier does not grant broadcast rights automatically |

Rules enforced in code (`isAutoApprovable`):

- **Auto-approved**: public domain, CC0, CC-BY, CC-BY-SA — licences that
  verifiably permit playback. The licence string and source URL are stored
  on every track.
- **Review required**: NC (non-commercial), ND (no-derivatives), unknown or
  missing rights. These import as `approved: false` and never play until an
  administrator approves them.
- **Never touched**: YouTube, Spotify, or any copyrighted platform. No
  scraping, ever.

Discovery runs three ways:

- **Admin → Radio Studio → Automatic music discovery** (on demand, choose a
  category, import selected results).
- **`radioDiscoverySync` callable** (admin-only).
- **`radioDiscoveryScheduler`** — a daily scheduled Firebase function that
  refreshes five categories automatically, so the catalogue grows without
  anyone searching for music.

All 11 requested categories are supported (African, Zambian, South African,
Nigerian, international gospel, CCM, traditional, praise, worship,
instrumental, inspirational). Honest note: the volume of *African* gospel
under verifiable free licences in these catalogues is limited; the system
also accepts direct uploads from local artists who give written permission
(the existing admin upload path records `permissionConfirmed`).

## 3. AI presenter voices (free, open source)

Engine chosen: **Piper TTS** (MIT licence, CPU-only, no API key) with the
browser's built-in Web Speech voices as the automatic fallback.

Six personas, both genders, assignable per programme
(`assets/pd-radio-announcements.js`, `radio/tts/README.md`):
warm female, energetic male, friendly female, calm male, gentle female,
deep male.

Flow:

1. Announcement **text** is generated locally (station name, programme,
   time-of-day greeting, current/next song, varied wording — consecutive
   announcements are never identical).
2. `POST /api/radio?op=announce` (admin/server token only) sends the text to
   the Piper service (`radio/tts/server.py`, env `TTS_SERVICE_URL`) and
   caches the audio in R2 at `radio/announcements/<persona>/<hash>.*` —
   generated **once**, reused forever. No per-song generation.
3. The player tries the cached R2 file → browser voice → silence. A TTS
   failure never interrupts music.
4. The administrator can disable announcements entirely and set the station
   ID frequency (Admin → Radio Studio → AI presenter voices).

Limitation: Vercel's serverless runtime cannot host Piper (no persistent
process). Until the Piper service runs on an always-on machine (see §5),
announcements use the browser voices — still free, still male/female.

## 4. Cloudflare R2 (configured bucket: `prayer-dome`)

Server-side only (`functions/r2.js`, SigV4 signed with Node's crypto — no
SDK dependency). Prefixes enforced: `radio/music/`, `radio/announcements/`,
`radio/sermons/`, `radio/bible-readings/`, `radio/prayers/`,
`radio/archives/`. Audio-only content types, 50 MB cap, overwrite
protection via unique keys.

Set these **private** Vercel environment variables (never in the repo):

```
R2_ACCOUNT_ID=0ccc7e18ae8b624a22d75984a4859ab6
R2_ACCESS_KEY_ID=<your key>
R2_SECRET_ACCESS_KEY=<your secret>
R2_BUCKET_NAME=prayer-dome
R2_ENDPOINT=https://0ccc7e18ae8b624a22d75984a4859ab6.r2.cloudflarestorage.com
R2_PUBLIC_BASE_URL=<optional public/custom domain for playback>
RADIO_ADMIN_TOKEN=<random string, shared only with the TTS/stream machine>
TTS_SERVICE_URL=<optional, e.g. http://host:5005>
JAMENDO_CLIENT_ID=<optional, free registration>
```

Without the R2 keys, studio audio uploads still work through the existing Cloudinary media service — R2 simply stays "not configured" in the admin panel.

## 5. The honest 24/7 streaming limitation

**No free serverless platform can run a permanent radio encoder.** Vercel
functions stop after each request; R2 is storage, not a streamer; Firebase
functions are request/schedule-scoped. Anyone claiming a free "forever
24/7 Icecast on Vercel" is pretending.

What this repo ships instead:

1. **Working today**: listener-side automation (§1). Every listener hears
   the scheduled programmes 24/7 the moment they press play. No server.
2. **Ready when a machine exists**: a complete self-hosted stack in
   `radio/server/` — Icecast + Liquidsoap via Docker Compose, the full
   Lusaka schedule in `station.liq`, announcement rotation, live presenter
   harbor input with automatic return to AutoDJ, and `sync-r2.sh` (rclone)
   to mirror approved audio from R2. Point **Admin → Station stream URL**
   at `http://host:8000/prayerdome` and the website player switches from
   browser automation to the true central stream — no code change.

Free machine options: a church PC that stays on, or an Oracle Cloud
"Always Free" VM (no SLA, but sufficient and genuinely free). Both are
documented in `radio/server/README.md`.

## 6. Security summary

- Public: listen only. Authenticated: may apply as presenter.
- Presenter approval, session windows, heartbeat and watchdog are
  server-authoritative (existing `functions/radio.js` callables).
- R2 credentials, `RADIO_ADMIN_TOKEN`, and the Icecast source password never
  reach the browser or the repository.
- `r2-upload` and `announce` (POST) require a Firebase admin ID token or the
  private server token; `discover` is rate-limited per IP.
- Firestore rules added (no existing rule weakened): `radioPlaybackHistory`
  (signed-in create, admin read), `radioProgrammes` / `radioCategories` /
  `radioArtists` / `radioAnnouncements` (admin write, public read),
  `radioStreamStatus` / `radioActivityLogs` (server-only writes).

## 7. What was tested here

- Full repository test suite (1,000+ assertions across all suites) and
  lint: **pass**, including 23 radio structural tests covering licence
  gating, AI-voice gating, cache keys, ticker, history, rules and the
  streaming stack.
- Firebase Functions module load check: **pass**.
- Not testable from this environment (no outbound internet, no Docker):
  live calls to archive.org/Commons, actual Piper synthesis, and a running
  Icecast stream. These are configuration steps (§4–§5), and the code
  degrades gracefully until they are completed — that behaviour *is*
  tested.
