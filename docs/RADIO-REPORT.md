# Prayer Dome Radio — implementation and verification report

**Branch:** `arena/e95077f2-prayer-dome`  
**Scope:** extend the existing Prayer Dome Radio page and admin Media area. No second radio system, no second listener player, and no change to the Prayer Dome Live video platform.

## 1. What already existed and what was reused

The repository did **not** contain AzuraCast, Liquidsoap, Icecast or any other streaming server. `radio.html` already had one shared `<audio>` element (`PDApp.radio`), a published nine-programme schedule in `assets/pd-content-data.js`, approved programme briefings, podcasts, a worship library and a station grid. Those features were kept.

The upgrade reuses:

- the existing **`worshipSongs`** Firestore collection and the existing Worship & Music Library for gospel audio (no parallel track library);
- the existing admin console, sidebar, toast/loading patterns and `PDAdmin` bridge;
- the existing `radio.html` design and its single `<audio>` player;
- the existing `radioScripts` briefing review flow;
- the existing `/api/live-ice` STUN/TURN negotiation endpoint;
- the existing Brevo-backed notification/outbox service;
- the existing `Africa/Lusaka` schedule helpers.

`worshipSongs` gains radio metadata on the same record: `genre`, `licenseStatus`, `source`, `sourceUrl`, `permissionConfirmed`, `approved`, `durationSeconds`. It still writes the original `category`, `rights`, `rightsHolder`, `description` and `audioUrl` fields so the public Worship & Music Library continues to work.

## 2. Implemented

### Gospel library and rotation

- Admin **Radio Studio** (`/admin.html#radio`) adds and edits `worshipSongs` rows with title, artist, album, genre, source, licence basis, duration, audio, notes and explicit approval.
- Approved genres: gospel worship, contemporary gospel, African gospel, international gospel, traditional gospel, praise, instrumental worship, other approved Christian music.
- Licence bases: licensed, written permission, public domain, original recording.
- The admin form refuses a YouTube/Spotify/SoundCloud/Apple Music/Deezer/Tidal/Amazon Music URL as a source or stream and explains that Prayer Dome does not scrape or rebroadcast those services. A permission reference or authorised distributor is required.
- Audio is uploaded to Firebase Storage under `radioAudio/tracks/` (metadata only in Firestore), or an existing URL can be used.
- The listener engine reads only rows with `approved === true`, a playable `audioUrl`, and a valid licence basis. Unapproved rows never enter the rotation.
- Rotation is least-recently-played first, then shuffled; the last 12 track IDs are remembered per device so a short library does not open with the same song each time.
- **Now Playing** shows the track title, artist, album and genre, and updates the lock-screen Media Session metadata.
- A licensed fallback stream/recording can be uploaded or configured. If a playlist is empty or two tracks fail, the engine plays the fallback rather than leaving silence.
- A public `radioNowPlaying/current` display document lets the admin dashboard monitor the current track without exposing any credential.

### Recorded human presenter voices

- Admin Radio Studio has a **Recorded presenter voices** library: presenter name, voice label, male/female/mixed, programme assignment, announcement type (programme intro, station identification, transition, closing), audio upload, notes and approval.
- A timetable slot can select a specific approved voice, or the engine falls back to an approved voice for that programme. This is how morning/afternoon/evening/night voices can differ and be changed later.
- The engine plays the approved intro at a programme transition, then the music. A station identification is optional and only plays if a real recording exists.
- Recently used voice IDs are remembered so the same announcement is not played back-to-back.
- **No generated speech is used.** The listener engine contains no `speechSynthesis`, TTS or generated voice path, and Firestore requires `humanRecorded == true` for a voice record.
- The admin form says "Genuine human recordings only"; uploads are audio-only and capped at 50 MB.

**Limitation:** the recording is a fixed file. Dynamic words such as the exact clock time cannot be inserted into a human voice recording without editing audio. Administrators should record the programme name and time in the file; the live programme/time is also displayed on screen. No synthetic voice is used to fill this gap.

### Presenter approval and access window

Server callables in `functions/radio.js` (Admin SDK, `us-central1`):

| Callable | Who | Purpose |
| --- | --- | --- |
| `radioPresenterRequest` | signed-in member | submit name, programme title, proposed start, duration, description; rejects past dates, overlapping/duplicate requests |
| `radioPresenterDecision` | admin only | approve, reject, request changes, revoke; records decision and sends the presenter notification |
| `radioPresenterStart` | request owner | re-checks ownership, approval, 30-minute lead window and end window; creates the session and public LIVE state |
| `radioPresenterHeartbeat` | presenter/admin | keeps the session alive; ends an expired session |
| `radioPresenterEnd` | presenter/admin | ends the session and clears LIVE state |
| `radioAdminStop` | admin only | stops an active presenter and returns listeners to automation |
| `radioPresenterStatus` | signed-in presenter | returns only the caller's requests, active sessions and public live state |
| `radioReportIssue` | signed-in member | writes a health event |
| `radioAdminHealth` | admin only | live state, active sessions, request history, health events, now playing and counts |
| `radioSessionWatchdog` | scheduled | ends expired sessions, stops heartbeat-stale sessions and expires old approvals |

`firestore.rules` keeps `radioPresenterRequests`, `radioPresenterSessions`, `radioLiveState`, `radioStreamHealth` and the `radioLive` parent server-only for writes. A browser cannot approve itself, create a session or set LIVE state. The request owner can read their own request; only admins read all. Rules deny writes to the public now-playing document except validated display fields.

Approval gives access only from 30 minutes before the proposed start until 15 minutes after the proposed end. The session expires at the approved end. A rejected/changed/revoked request loses access immediately; the callable also ends an active session if an approval is revoked.

### Listener LIVE takeover and automatic return

- The live state is a public Firestore document (`radioLiveState/current`) written only by the server.
- While listening, the listener subscribes to that document. When an approved presenter starts, the listener connects a WebRTC audio receiver and switches the **same** `PDApp.radio` `<audio>` element to the presenter's `MediaStream`. No second player is added and the page does not reload.
- The player shows a red LIVE badge, the presenter name and the programme title. The station status and play button change to "Join live broadcast"/"Pause live".
- When the presenter ends, the server clears the live document and the listener closes the peer connection and resumes scheduled automation automatically.
- If the peer connection fails or the presenter disappears, the listener falls back to automation on the same player and reports the issue through `radioReportIssue` when signed in; the listener is not left in silence.
- A presenter's heartbeat is every 20 seconds. The scheduled watchdog ends a session after 90 seconds without a heartbeat, or at the approved end time, even if the browser was closed without pressing Stop. `pagehide` also attempts an immediate end.
- The admin **Active presenters** card can stop a session immediately; the server clears LIVE state and the listener returns to automation.

### Scheduling and automation

- Admin Radio Studio has a timetable editor (`radioSchedule`) with start/end, title, type (music, Bible teaching, prayer, worship, announcement), playlist, recorded voice, days and enabled flag. Slot overlap is rejected by the browser; Firestore validates times and the day list.
- An administrator creates playlists (`radioPlaylists`) from approved tracks, can mark one default, and assigns a playlist to a timetable slot.
- The listener engine resolves the current slot in **Africa/Lusaka**, starts the assigned recorded voice at the transition, plays the playlist, and rotates tracks. If no custom timetable exists, it follows the existing published nine-programme schedule.
- The timetable is public read-only and is rendered on `/radio` in place of the default schedule when present.
- `radioSettings/main` holds automation enabled, default playlist, fallback audio and public station stream URL. It is admin-write/public-read; no provider secret is stored there.

### Admin dashboard

The Radio Studio view contains:

- broadcast health/live status and current now-playing metadata;
- counts of requests, approved requests, tracks and voices;
- health events (start, end, decision, issue);
- pending/approved/rejected/revoked presenter requests with approve, reject, request-changes and revoke actions;
- active presenter list with "Stop and return to automation";
- gospel library table with preview, edit and delete;
- recorded-voice table with preview, edit and delete, plus programme assignment;
- playlist editor with approved-track checkboxes and default selection;
- timetable editor;
- automation/fallback settings.

All actions use the existing admin authentication. Presenter requests and decisions call the server; track/voice/playlist/timetable writes use the existing admin-only rules.

## 3. Verification performed in this workspace

```text
npm test                 exit 0  (full suite, ~105 s)
tests/radio.test.js      18 passed
tests/admin-auth.test.js 25 assertions passed
tests/icons.test.js      42 passed
tests/layout.test.js     43 pages / 48 static tables
tests/pwa.test.js        85 assertions passed
npm run functions:verify success (functions module loads)
npm run lint             success (icons, nav, 156 JS files, SEO, asset links)
npm run build:vercel     not re-run after the radio assets; run before deploying
```

Structural tests added for:

- one shared listener player (`playUrl`/`playStream`, no `new Audio` in the listener engine);
- approved/licensed-only automation and least-recently-played rotation;
- human-only recorded voice path and no TTS;
- server-authoritative request/decision/start/heartbeat/end and expiry;
- rules denying browser writes to requests, sessions and LIVE state;
- WebRTC signalling restricted to the approved presenter;
- automatic return/fallback wording and watchdog;
- admin Radio Studio wiring, Storage uploads and streaming-platform rejection;
- Storage `radioAudio/` path and audio MIME/size rules;
- the two new notification events;
- presenter/now-playing/LIVE UI IDs and the single-player wording.

**Not verified in this sandbox:** real Firebase authentication, Firestore, Storage uploads, Brevo email delivery, two-device WebRTC audio and installed-PWA audio. Those need the user's Firebase project and devices. The code paths are present; they should be exercised after deploying the rules/functions. `npm test` cannot prove audio actually reaches a second device.

## 4. Deployment needed

```bash
firebase deploy --only firestore:rules,storage --project <project-id>
firebase deploy --only functions --project <project-id>
```

The listener page loads Firebase modular SDKs directly from gstatic (already the project pattern). No new API function was added, so the Vercel Hobby 12-function limit is unchanged. No new environment variable is required for the radio engine; Brevo uses the existing `BREVO_API_KEY`.

After deployment:

1. Upload/approve licensed gospel audio in **Admin → Radio Studio**.
2. Create a playlist and mark it default (or assign it to timetable slots).
3. Upload genuine human programme intros, mark them approved, and assign them to programmes/timetable slots.
4. Publish the timetable (or leave it empty to use the existing schedule).
5. Submit a presenter request from `/radio.html#presenter-studio` with a second account; approve it as admin; start inside the approved window.

## 5. Costs and limitations requiring approval

- **No new paid vendor was added.** Audio is in the existing Firebase Storage bucket; functions use the existing Firebase project. The repository already deploys scheduled Firebase functions (billing expiry, reminders, email retry), so the radio watchdog adds one more schedule to that existing setup; it does not create a new billing account.
- **No AzuraCast/Liquidsoap/Icecast server was added.** A true always-on server-side 24/7 stream would need a media server (or a paid managed streaming provider) and a recurring hosting bill. This implementation runs the schedule and rotation in each listener's page and uses WebRTC for live presenters; it is continuous while a listener has the page open, but it is not a single server-side stream when nobody is listening. This is the main limitation to discuss before claiming a full broadcast station.
- **WebRTC is peer-to-peer mesh.** It is suitable for a small number of simultaneous listeners. The reception path has a 30-peer cap and falls back to automation if a connection fails. A larger audience or listeners behind restrictive mobile NATs need a TURN relay and/or an SFU/HLS media server. `/api/live-ice` can mint TURN credentials when configured, but a TURN service is a recurring cost and must be approved before it is added. No TURN secret is committed.
- **Recorded announcements are fixed audio.** Dynamic time insertion would require editing/recording per slot or a TTS service; generated voices are deliberately not used. The programme/time is displayed on screen and must be spoken in the human recording.
- **No browser/device test was possible here.** The 14 acceptance scenarios are implemented and covered structurally, but real two-device audio, mobile Safari/Chrome and installed-PWA audio need the user's deploy and devices.

## 6. Acceptance scenarios — status

| # | Scenario | Status |
| --- | --- | --- |
| 1 | Continuous approved gospel automation | Implemented (listener engine); needs deployed Firestore audio to hear |
| 2 | Different male/female voices per programme | Implemented via voice library + slot/programme assignment |
| 3 | Announcements at correct times | Implemented at programme transitions; recording must name the programme/time |
| 4 | Ordinary user cannot go live | Server callable + rules deny; structural tests pass |
| 5 | Presenter submits request | Presenter Studio form + callable |
| 6 | Admin notified | In-app + email event `radio_presenter_request` |
| 7 | Approve/reject/request changes | Admin dashboard actions + decision event |
| 8 | Approved presenter goes live | `radioPresenterStart` creates session/LIVE state; mic captured |
| 9 | Takes over existing stream/player | Same `PDApp.radio` `<audio>` switched to MediaStream; no second player |
| 10 | Presenter can end session | Stop button + `radioPresenterEnd` |
| 11 | Auto-return to automation | Live-state listener + `leaveLive` |
| 12 | Disconnect leaves no silence | Listener peer failure fallback + watchdog ends stale LIVE state |
| 13 | Multiple simultaneous listeners | Per-viewer offer/answer mesh, 30-peer cap; needs real multi-device test |
| 14 | Mobile browser + installed PWA | Shared responsive player and precached engine; needs device test |

## 7. Known risks / follow-ups before a public launch

1. Deploy and test the rules; `npm run test:rules` needs Java 21 in this environment.
2. Use two real devices on different networks to verify the WebRTC path, especially mobile carrier NAT. If it fails, configure TURN (cost approval) rather than claiming success.
3. Decide whether the ministry wants a true server-side 24/7 stream. That requires a media server and a recurring bill; the current implementation is listener-side automation.
4. Record and approve enough voices to avoid repeating one announcement; the engine avoids immediate repeats but a single recording cannot sound varied.
5. Verify Brevo sender/domain settings; an accepted email is not proof of delivery, and the existing outbox status wording remains authoritative.
