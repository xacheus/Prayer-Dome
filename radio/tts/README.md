# Prayer Dome Radio — AI presenter voices (Piper TTS)

Free, open-source neural text-to-speech for the station's six presenter
personas. No API keys, no subscriptions, CPU-only.

| Persona | Gender | Piper model | Programmes (default) |
|---|---|---|---|
| Warm female | F | `en_GB-amy-medium` | Morning worship / prayer |
| Energetic male | M | `en_GB-ryan-high` | Morning praise |
| Friendly female | F | `en_US-lessac-medium` | Afternoon gospel |
| Calm male | M | `en_GB-alan-medium` | Evening worship |
| Gentle female | F | `en_US-amy-medium` | Night prayer |
| Deep male | M | `en_GB-northern_english_male-medium` | Special programmes |

Assignments are editable per programme in Admin → Radio Studio.

## How audio flows

1. `assets/pd-radio-announcements.js` generates the announcement **text**
   (varied greetings, programme intros, station IDs — never identical twice
   in a row) and a deterministic cache key.
2. `/api/radio?op=announce` (POST, admin-only) sends the text to this Piper
   service (`TTS_SERVICE_URL`), then stores the audio in Cloudflare R2 at
   `radio/announcements/<persona>/<hash>.wav` — generated **once**, reused
   forever.
3. The website player tries the cached R2 audio first; if it does not exist
   yet it uses the browser's built-in free speech voices; if that also fails
   **the music simply continues**. TTS can never stop the broadcast.

## Run it (free)

```sh
pip install piper-tts flask
python -m piper.download_voices en_GB-amy-medium en_GB-ryan-high \
    en_US-lessac-medium en_GB-alan-medium en_US-amy-medium \
    en_GB-northern_english_male-medium
PD_RADIO_TOKEN=<same as Vercel RADIO_ADMIN_TOKEN> python server.py
```

Then set in Vercel: `TTS_SERVICE_URL=http://YOUR_HOST:5005` and
`RADIO_ADMIN_TOKEN=<token>`.

## Limitation (honest)

Vercel's serverless runtime cannot run Piper itself (no persistent process,
size limits), so this service needs the same always-on machine as the
streaming stack — or any free-tier VM. Until it runs, announcements use the
browser's built-in voices, which already differ by male/female persona.
