# Prayer Dome Radio — Phase 1 infrastructure audit

**Date:** 22 November 2026  
**Branch:** `arena/e95077f2-prayer-dome`  
**Scope:** inspect the existing radio implementation before adding TiDB, R2, AzuraCast, AI voices or automatic music discovery.

## 1. What already exists

| Area | Existing implementation | Reusable? |
| --- | --- | --- |
| Listener page | `radio.html`, one shared `<audio>` in `assets/pd-app.js`, programme schedule, presenter studio | Yes |
| Automation | `assets/pd-radio-live.js` builds a least-recently-played queue in the listener browser | Partly — not a server-side 24/7 stream |
| Library | `worshipSongs` in Firestore, with rights/licence fields and explicit approval | Yes as metadata source |
| Storage | Firebase Storage `radioAudio/{tracks,voices,announcements,fallback}` | Can be migrated to R2; not R2 today |
| Presenter approval | `functions/radio.js` callables, Firestore rules, email/outbox notifications, 90-second heartbeat watchdog | Yes |
| LIVE takeover | Per-listener WebRTC peer connection, same `<audio>` element, auto-return to automation | Partial; not an Icecast broadcast |
| Ticker | Static decorative verse strip | Replaced this phase with a live station/programme/Now Playing ticker |
| Admin console | `admin.html#radio` Radio Studio: requests, tracks, voices, playlists, timetable, settings | Yes |
| Public API | `api/radio.js` returns the static station/podcast catalogue | Extended with secret-free configuration status |

## 2. What is not present

The repository and this workspace contain **no**:

- TiDB connection string or `TIDB_DATABASE_URL` / `DATABASE_URL`;
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` values;
- AzuraCast, Liquidsoap, Icecast or any always-on streaming host;
- station stream URL or source password;
- TTS provider, key or self-hosted voice server;
- licensed music-discovery provider or API key;
- database migration directory for radio.

The supplied R2 endpoint identifies the account but contains no credential. The bucket name `prayer-dome` and the WEUR endpoint can be configured, but nothing can be uploaded or served until the access key pair and public media domain exist.

## 3. Blocking facts

1. **Vercel cannot be the 24/7 radio server.** It serves static pages and short-lived functions. It cannot keep Liquidsoap/Icecast running when nobody has a browser open, and it cannot accept a continuous presenter encoder stream. A separate host is mandatory for genuine continuous broadcasting.
2. **TiDB is MySQL-compatible.** TiDB Cloud speaks the MySQL protocol, not PostgreSQL. The brief calls it “PostgreSQL-compatible”. A `postgres://` URL will not work with a TiDB driver. Confirm the actual service before migrations are written; the preflight now reports this conflict.
3. **The current LIVE path is WebRTC mesh.** It works only while an approved presenter and each listener are connected to the page. It is not a station takeover on a server-side stream. AzuraCast/SHOUTcast source credentials or a WebRTC-to-Icecast gateway are required for a true same-stream takeover.
4. **Music discovery is a licensing decision, not a crawler.** No catalogue or API is connected. The existing admin form correctly rejects YouTube/Spotify/SoundCloud/Apple/Deezer/Tidal/Amazon URLs. Automatic discovery cannot be enabled until a source’s terms expressly allow internet-radio broadcast.
5. **AI voices need a provider decision.** No TTS provider is approved. A paid provider must not be enabled before pricing and monthly usage are accepted.
6. **No production playback test is possible without a stream host.** A file in R2 is storage, not an Icecast source.

## 4. Target architecture

```
Listener browser / PWA
        │  HTTPS stream (MP3/AAC or HLS)
        ▼
Cloudflare DNS  ──►  AzuraCast on a small VPS
                     ├── Liquidsoap AutoDJ
                     ├── Icecast output (same listener URL)
                     ├── approved live presenter source
                     └── fallback playlist / silence detection

Radio worker on the same VPS (Node service)
        ├── TiDB: programmes, schedules, tracks, playlists, history, health
        ├── R2: audio objects + generated announcements (S3 API)
        ├── R2 public custom media domain for non-stream assets
        ├── approved TTS provider (Piper local or paid, after approval)
        ├── approved music-discovery provider (after licence review)
        └── AzuraCast API: playlists, media sync, now-playing, streamer control

Vercel
        ├── public site + PWA + one listener player
        ├── /api/radio (public catalogue + secret-free configuration status)
        └── admin UI; no stream or storage secret reaches the browser
```

R2 is **not** the streaming server. The worker reads approved objects from R2 and Liquidsoap queues them; listeners receive the Icecast stream, not R2 object URLs, except for non-live downloads/archives.

## 5. Implemented in Phase 1 (this branch)

- `server/radio/config.js` — secret-free validation of database, R2, streaming, voice and discovery configuration; rejects `r2.dev` as the production public base; flags the PostgreSQL/TiDB mismatch.
- `scripts/radio-preflight.mjs` — runnable `npm run radio:preflight` check with `--json` and `--strict`.
- `GET /api/radio?view=status` — private, `no-store` deployment status containing only environment names and missing items.
- Admin **Radio Studio → Broadcast infrastructure** panel — shows exactly which groups are configured or missing; explicitly says this is not a connection test.
- Continuous listener ticker — station, programme, LIVE presenter/programme and Now Playing, repeated for a seamless marquee; static under `prefers-reduced-motion`; never hides after a timeout.
- `tests/radio-infra.test.js` — 20 checks covering the preflight, no-secret status endpoint, admin panel and ticker.

The existing Firestore/WebRTC radio remains functional. Nothing claims that TiDB, R2, AzuraCast or AI voices are live.

## 6. Acceptance status

| Requirement | Status |
| --- | --- |
| Server-side continuous 24/7 stream | **Blocked** — no AzuraCast/Icecast host |
| Automatic music discovery | **Blocked** — no licensed source/API |
| Multiple AI male/female voices | **Blocked** — no approved TTS provider |
| Cached generated announcements | **Blocked** — no TTS or R2 credentials |
| TiDB metadata | **Blocked** — no TiDB URL; engine ambiguity |
| R2 storage | **Blocked** — endpoint known, keys/public domain missing |
| Presenter request/approval | Implemented in existing `functions/radio.js`; needs live deployment/device test |
| Same-stream presenter takeover | **Blocked** — current path is WebRTC mesh, not server stream |
| Automatic return to AutoDJ | Present in WebRTC/watchdog path; true stream recovery needs AzuraCast |
| Listener player / ticker / Now Playing | Implemented and structurally tested |
| Mobile/PWA/background playback | Existing player supports it; physical-device test still required |
| Security/rules | Existing rules deny browser writes to requests/sessions/LIVE state; TiDB/R2 rules not created yet |

## 7. Required decisions / credentials

Set these in the deployment environment, never in Git or chat:

```text
TIDB_DATABASE_URL=mysql://...
RADIO_DB_ENGINE=mysql
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=prayer-dome
R2_ENDPOINT=https://0ccc7e18ae8b624a22d75984a4859ab6.r2.cloudflarestorage.com
R2_PUBLIC_BASE_URL=https://media.prayerdome.net
AZURACAST_BASE_URL=https://radio.prayerdome.net
AZURACAST_API_KEY=...
AZURACAST_STATION_ID=...
RADIO_STREAM_URL=https://radio.prayerdome.net/listen/prayerdome/stream.mp3
RADIO_TTS_PROVIDER=piper
RADIO_TTS_ENDPOINT=http://127.0.0.1:5000/synthesize
RADIO_DISCOVERY_PROVIDER=manual
```

A verified custom media domain (for example `media.prayerdome.net`) must be connected to the R2 bucket. A separate radio host (for example `radio.prayerdome.net`) must point to the AzuraCast server.

## 8. Estimated monthly operating cost

These are planning estimates, not quotes. Verify current vendor pricing before purchase.

| Item | Estimate | Notes |
| --- | --- | --- |
| VPS for AzuraCast + worker | **$6–24 / month** | 2 vCPU / 2 GB is the documented AzuraCast minimum; 4 GB recommended. Bandwidth is the variable. |
| AzuraCast / Liquidsoap / Icecast | **$0** | Open source; you pay for the host. |
| TiDB Cloud Starter | **$0** within free quota** | Free tier is limited; paid storage/RU charges apply above it. |
| Cloudflare R2 | **$0–1 / month** for a small library | 10 GB free, then about $0.015/GB-month; egress is free. |
| Custom media domain | **$0** if DNS is already on Cloudflare | TLS is included. |
| AI voices — Piper self-hosted | **$0 licence** | Uses worker CPU/RAM; quality is below premium cloud voices. |
| AI voices — ElevenLabs | **$6–22 / month** (2026 published Starter/Creator ranges) | Only if approved; character quotas limit announcements. |
| Music discovery API | **$0 API** for some catalogues | **Licensing for broadcast may cost extra** and must be reviewed. |
| Listener bandwidth | Included in VPS allowance up to its limit | 128 kbps × 100 concurrent ≈ 4.2 TB/month; check the host’s fair-use cap. |

**Expected bare launch:** roughly **$6–25/month** with a small VPS and self-hosted voice. Adding a paid cloud voice takes it to roughly **$12–47/month**, excluding music licensing and any TURN/SFU for the separate video platform.

## 9. What happens next

1. Confirm the database service/engine and provide the TiDB connection in the deployment environment.
2. Confirm whether an AzuraCast/Icecast host already exists. If not, approve a VPS and radio hostname.
3. Approve a voice path: self-hosted Piper (free) or a paid provider with a stated monthly cap.
4. Approve a music source and its broadcast licence, or keep the station on the existing manually approved library.
5. Once 1–4 are true, implement the SQL migrations, R2 upload/sync, schedule/playlist worker, TTS cache, AzuraCast API integration and real playback tests.

Until then, the correct state is **not configured**. The dashboard and `/api/radio?view=status` now say so rather than showing a false “online” indicator.
