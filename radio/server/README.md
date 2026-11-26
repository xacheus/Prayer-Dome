# Prayer Dome Radio — self-hosted streaming stack

This folder contains the complete, free, open-source 24/7 streaming server:
**Icecast** (public stream) + **Liquidsoap** (AutoDJ), with audio synced from
the existing Cloudflare R2 bucket.

## The honest limitation

**Vercel cannot host this.** Serverless functions stop after each request —
no free serverless platform can keep an audio encoder running day and night.
A real 24/7 stream needs one machine that stays on:

| Option | Cost | Notes |
|---|---|---|
| Church PC / old laptop + home internet | Free (electricity) | Works today; stream URL via dynamic DNS |
| Oracle Cloud "Always Free" VM | Free tier | 4 ARM cores / 24 GB RAM; no guaranteed SLA, but widely used for small radio stations |
| Any existing VPS | Already paid | Best reliability |

**Until a machine is available, the radio still works**: the website's
listener-side automation (`assets/pd-radio-live.js`) plays the same scheduled
programmes, announcements and playlists directly in every listener's browser
and PWA. That is the zero-budget broadcast that is live right now.

## Setup (on the always-on machine)

```sh
cp .env.example .env     # set strong passwords
mkdir -p music announcements fallback
./sync-r2.sh             # pull approved audio from R2 (needs rclone + R2 keys)
docker compose up -d
```

Then in **Admin → Radio Studio → Automation & fallback**, set the
**Station stream URL** to `http://YOUR_HOST:8000/prayerdome`. The website
player switches from browser automation to the real stream automatically.

## Live presenters

Approved presenters connect a free source client (BUTT, Mixxx) to
`YOUR_HOST:8005`, mount `live`, using the per-session credentials the
administrator issues privately. Liquidsoap switches the station to the live
input immediately and returns to AutoDJ the moment they disconnect. The main
Icecast source password is never shared with presenters.

## Keeping it in sync

Add a cron entry for `sync-r2.sh` (hourly is plenty). New tracks approved in
the admin console and new cached AI announcements appear on the stream after
the next sync and playlist reload (≤30 min).
