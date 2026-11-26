# Prayer Dome — Complete Application, Functionality and Technical Audit

**Audit date:** 2026-11-26  
**Branch:** `arena/48bae998-prayer-dome` (from `f05ff848a32bcce3752d4bbaf733f53a43b75b88`)  
**Repository:** `xacheus/Prayer-Dome` at `/home/user/Prayer-Dome`  
**Mode:** Read-only investigation. No application source, database, or production configuration was changed.

---

**External sources cited**

- `[1]` Live read-only production health check: `https://www.prayerdome.net/api/health`.
- `[2]` Google Android Developers Blog, *Widgets on lock screen: FAQ* — https://android-developers.googleblog.com/2025/03/widgets-on-lock-screen-faq.html.
- `[3]` web.dev, *Displaying a notification* — https://web.dev/articles/push-notifications-display-a-notification.

## Evidence key and limits of this audit

| Evidence level | What it means |
| --- | --- |
| **Verified — source** | Read the actual implementation, configuration, rules and routes in this repository. File paths are given. |
| **Verified — automated** | Existing test/lint suites were executed locally and passed. These are structural/jsdom contract tests, not browser or backend integration tests. |
| **Verified — live read-only** | A public GET to the deployed `/api/health` endpoint succeeded. |
| **Needs testing** | Code exists, but no real device, real payment, real FCM delivery, real broadcast or browser E2E test was possible here. |

**Tests actually run**

- `npm ci --ignore-scripts --no-audit --no-fund` and `npm --prefix functions ci --ignore-scripts ...` installed dependencies into gitignored `node_modules/` only (needed because many test files use `jsdom` and `firebase-functions`).
- `npm test` — **exit 0**, **1,967 `PASS` assertions and 0 failures**, including all `node:test` suites (e.g. radio 23/23). The first run failed only because the `postinstall` hook had been skipped; after installing `functions/` dependencies the full suite passed. This was an environment issue, not an application defect.
- `npm run lint` — **exit 0**: 286 icons consistent, navigation markup matches all 42 pages, 165 JS files/executable inline scripts valid, 32 SEO files current, widget verse bundle matches source with 48 checkpoints, `assetlinks.json` valid.
- `npm run functions:verify` — **exit 0**: Firebase Functions module loads.
- `GET https://www.prayerdome.net/api/health` — returned `{"ok":true,...,"revision":"f05ff848a32b","environment":"production","region":"iad1"}`. The production revision matches this branch's base commit.
- **Not run:** `npm run test:rules` (Firebase emulator/Java unavailable), Android Gradle build (no Java/Android SDK), Lighthouse/Core Web Vitals, real browser E2E, real device widget/FCM test, real payment/broadcast test. Nothing here should be read as a claim that those were verified.

`git status` remained clean with respect to tracked application files. The existing `vercel.test.js` regenerates the gitignored `dist/` output as part of `npm test`; no source file was edited.

---

# A. Application Overview

Prayer Dome is a **multi-page static web application with serverless APIs**, not a single-page framework app. The website source lives at the repository root; 42 HTML pages share a JavaScript/CSS layer in `assets/`. A Capacitor 8 Android shell wraps the same web assets, and a native Android `AppWidget` provides the Daily Verse card.

## A.1 Technology stack (verified)

| Layer | Technology / evidence |
| --- | --- |
| Frontend | Plain HTML/CSS/vanilla JavaScript. Modular Firebase SDK imported from `https://www.gstatic.com/firebasejs/10.8.0/...` directly in page scripts. `assets/pd-app.js` (3,520 lines) is the shared application layer. |
| Styling | `assets/pd-brand.css`, `assets/pd-icons.css`, page-local `<style>` blocks, `assets/pd-responsive-fix.css`; Google Fonts (Poppins, Inter, Lora, Great Vibes). |
| Backend (Vercel) | 12 serverless functions in `api/*.js`; `vercel.json` rewrites `/api/health`, `/api/billing`, `/api/newsletter`, `/api/live-ice`, `/api/payment-webhook`, share routes and pretty page URLs. `scripts/build-vercel.mjs` copies an allowlisted public bundle to `dist/`. |
| Backend (Firebase) | Cloud Functions in `functions/index.js` plus modules for notifications, billing, radio, verification, Brevo email, sharing, translation, R2, Cloudinary and discovery. Scheduled functions use `Africa/Lusaka`. |
| Database | Cloud Firestore (`firestore.rules`, `firestore.indexes.json`). ~70 collections were observed, including `users`, `memberships`, `prayers`, `events`, `offerings`, `wallets`, `paymentRequests`, `userTokens`, `radio*`, `live*`, `certificates`, `emailOutbox`. |
| Authentication | Firebase Auth (email/password, Google popup on the account page), Firebase email-verification callables and six-digit registration codes delivered by Brevo. Role resolution reads `memberships/{uid}` then `users/{uid}`; a 7-day localStorage session mirrors the role for UI continuity. |
| File/storage | Firebase Storage with restrictive `storage.rules` for giving evidence, billing evidence and radio audio; Cloudinary unsigned uploads for images/video; optional Cloudflare R2 for radio media. |
| Notifications | Firebase Cloud Messaging via browser Web Push and the Capacitor Push Notifications plugin; root service worker `sw.js` draws branded notifications and handles clicks. `firebase-messaging-sw.js` is a fallback worker. |
| Android | Capacitor 8.5.2 (`capacitor.config.json`, `android/`), `net.prayerdome.app`, min SDK 24 / target SDK 36, native `VerseWidget*` Java classes, adaptive launcher icons, splash resources, monochrome notification icon, FileProvider, App Links for `www.prayerdome.net`. |
| Hosting | Vercel (`vercel.json`) and Firebase Hosting (`firebase.json`, public `dist`) are both configured. Vercel Hobby constraints are explicitly respected: exactly 12 API function files, 20-second maximum duration. |

## A.2 Architecture summary

```
Browser / installed PWA / Capacitor WebView
  ├── pages (*.html) + shared assets/pd-app.js
  ├── Firebase Web SDK ──> Auth, Firestore, Storage, FCM token
  ├── fetch('/api/...') ──> Vercel functions
  │      /api/billing, /api/radio, /api/bible, /api/share, /api/live-ice,
  │      /api/newsletter, /api/system (health/payment webhook)
  └── service worker sw.js ──> precache, offline shell, push UI, click routing

Firebase project "prayer-dome"
  ├── Firestore + security rules
  ├── Storage + security rules
  ├── Cloud Functions (Gen 1) ──> FCM fan-out, scheduled verses/devotionals,
  │   verification codes, Brevo email, radio presenter control, certificates,
  │   membership verification, payments/subscriptions/admin notifications
  └── FCM ──> Android devices / Chrome Web Push

External services (configuration-dependent)
  Cloudinary, Cloudflare R2, Brevo, api.bible / GetBible / Bolls,
  BigDataCloud + ipapi.co, exchange-rate APIs, hls.js CDN, three.ws Domey widget
```

## A.3 Executive summary

The application is **broad and unusually complete for a static site**: most user-facing areas have real Firestore-backed behaviour, security rules, tests and admin tooling. The main weaknesses are not missing screens but **configuration dependence, three declared-but-unimplemented PWA capabilities, one verified verse-data inconsistency between website widget and server push, several small dead/inconsistent controls, and a mobile hero override that prevents the requested full-bleed design**.

The requested lock-screen verse feature is **already largely implemented natively** in this repository (`VerseWidgetProvider.java`, `VerseWidgetRenderer.java`, four daily alarms, preferences bridge and `/widgets.html` studio). The work needed is parity/verification and polish, not a greenfield build. Android lock-screen widgets are OS/platform-dependent; notifications remain the universal fallback.

---

# B. Complete Feature Inventory

Each row below states what the feature does, how the user reaches it, what happens on interaction, the backend used, status, limitations and source files. "Working" here means the implementation is present and covered by structural tests; it does **not** mean a live backend transaction was executed during this audit.

## B.1 Homepage, discovery and personalisation

| Feature | Access & intended behaviour | Implementation / backend | Status | Problems / improvements | Source |
| --- | --- | --- | --- | --- | --- |
| Homepage | `/` is the hub: hero, featured scripture, daily devotional, daily prayer challenge, founder card, event/news cards, quick links, announcements, install card. | Static HTML plus `PDApp` modules; Firestore-backed live state for events/prayers/news; `PD_CONTENT` seeds for static cards. | **Working** | See Section F.3 for hero redesign. Some cards use static content when Firestore is empty. | `index.html`, `assets/pd-app.js`, `assets/pd-content-data.js` |
| Splash screen | A themed opening overlay with logo, wordmark and theme verse, dismissed automatically/click. | Local markup/CSS; `pd-motion.js` and `PDApp.appShell.splash()`. Native splash also exists in `android/app/src/main/res/drawable*/splash.png`. | **Working** | Splash is web-only on PWA; native splash uses separate artwork (`mobile/splash.png`, 1080×1920). | `index.html:674-680`, `assets/pd-app.js:560-568`, `styles.xml` |
| Daily devotional | Home page shows morning/afternoon/evening devotional in Africa/Lusaka, with countdown and period change every minute. | Bundled `devotional-data.js` (365-day library, morning/afternoon/evening/seasonal arrays and helpers). No backend. | **Working** | Browser timezone is detected but the product decision documented in source is to use Lusaka period logic; verify with users in other countries. | `index.html` (`initDevotionalSystem`), `devotional-data.js`, `tests/devotional.test.js` |
| Daily prayer challenge | Home card with weekday/date/check-in key, streak/points. | `assets/pd-daily-challenge.js`, Firestore `dailyPrayerCheckins`, deterministic `<uid>_<YYYY-MM-DD>` ID, rules enforce one per day. | **Working** | Requires sign-in for persistence; guest mode is local. | `index.html:820-828`, `firestore.rules` (`dailyPrayerCheckins`) |
| Featured/theme Scripture | `[data-pd-scripture]` placeholders on many pages are filled with the Mark 7:37 theme verse; language changes re-render. | `PDApp.scripture.render()` using `PD_CONTENT.THEME_SCRIPTURE` and `pd-i18n`. | **Working** | Copy varies between "He hath done all things well" and "He does everything blamelessly"; standardise translation wording. | `assets/pd-app.js:2432-2460`, drawer footer in all pages |
| Location card | Browser geolocation, reverse geocoding, IP enrichment, retry, branch cards. | BigDataCloud reverse geocode, `ipapi.co`/`ipwho.is` fallbacks, `assets/pd-locations-data.js`. | **Partially Working** | Depends on third-party free APIs and user permission; no fallback to cached location offline. | `assets/pd-app.js:885-975`, `index.html:751-760` |
| Announcement marquee | Scrolling "News" bar on top of pages; admin can publish notices. | Marquee reads `PDApp.store('announcements')` from localStorage/seeded content and listens for local events. Admin writes Firestore `announcements` and separately updates only **its own** local marquee. | **Partially Working** | A notice published by an admin does **not** reach other open pages' marquee through Firestore. The in-app bell does receive a public mirror. Subscribe the marquee to `announcements` or `publicNotifications`. | `assets/pd-app.js:978-1008`, `admin.html:5255-5257`, `firestore.rules` |
| Settings | No dedicated settings page. Notification switches, verse alerts, profile details, password/account controls and app appearance are spread across the bell, account page and OS. | Firestore `userNotificationPrefs`, `userVerseSettings`, Firebase Auth profile methods, OS `prefers-color-scheme` plus an optional `data-pd-theme` override. | **Partially Working** | Theme toggle is inconsistent (Section G.4). README's claim of a top-bar language selector is outdated: the selector was deliberately removed from the header. | `account.html:1266-1410`, `assets/pd-app.js:429-434, 570-600, 772-798` |
| Global search | No global site search exists. Users navigate by menu; page-specific search exists in Bible, translation, sermons, resources and news filters. | Local data search helpers (`pdSearchVerses`, `pdSearchSermons`) and per-page inputs. | **Partially Working** | A global search across pages/content would be a new feature, not a repair. | `translation-data.js:993`, `sermons-data.js:397`, `bible.html:486` |

## B.2 Bible and scripture

| Feature | Access & intended behaviour | Implementation / backend | Status | Problems / improvements | Source |
| --- | --- | --- | --- | --- | --- |
| Bible reader | `/bible` → book/chapter list, verse rendering, text size, translation selector. | Bundled public-domain BSB JSON (66 files in `assets/bible/bsb/`); other versions via `/api/bible?action=...`; localStorage chapter cache. | **Working** | Chapter fetches are network-dependent for non-BSB versions; no subscription should be assumed. | `bible.html`, `api/bible.js`, `docs/BIBLE-LICENSING.md` |
| Bible search | Search tab → query → results → jump to verse. | `/api/bible?action=search` for server versions; local `searchBsb()` for BSB. | **Working** | Search results are version-specific; KJV/NLT/ESV providers are third-party mirrors with rights caveats in `docs/BIBLE-LICENSING.md`. | `bible.html:1213`, `api/bible.js:1131-1158` |
| Notes and bookmarks | Note button on verse → modal → save; Notebook tab lists notes. | Signed-in: Firestore `bibleNotes/{uid}/notes`; guests: `localStorage.bible_notes`. | **Partially Working** | Guest notes do not sync after sign-in. | `bible.html:1133-1200`, `firestore.rules` (`bibleNotes`) |
| Reading progress | Mark chapters read; overall and per-book progress bars. | Firestore `bibleProgress/{uid}` when signed in; `localStorage.bible_read_chapters` otherwise. | **Working** | Guest progress is not migrated into the signed-in document. | `bible.html:623-695` |
| Audio Bible | Player bar with play/pause, skip, speed. | **Browser `speechSynthesis` reading the rendered text**, not recorded audio files. | **Partially Working** | Voice quality and pause behaviour vary by OS; no audio backend. Describe it as " spoken Scripture" rather than a recorded audio Bible, or add licensed recorded audio. | `bible.html:1307-1365` |
| Translation page | `/translate` shows English, Tumbuka, siSwati with search/share. | Bundled `translation-data.js`; no API key. Admin can manage `translations` in Firestore. | **Working** | Editorial workflow needed for new languages. | `translate.html`, `translation-data.js`, `firestore.rules` |
| Daily Bible verse | `/widgets`, notifications, widget, wallpaper studio, site splash. | `assets/pd-verse-data.js`: 80 NIV verses, 4 slots (morning/midday/afternoon/evening), deterministic rotation by day-of-year. Native widget bundle is generated by `scripts/build-widget-verses.mjs`. | **Partially Working** | Site, service worker and native widget agree; **server push uses a different 20-verse bank and rotation** (Section G.1). | `assets/pd-verse-data.js`, `functions/verse-bank.js`, `scripts/build-widget-verses.mjs` |
| Verse wallpaper studio | `/widgets` → choose device/theme → download or share wallpaper; pin a verse. | Canvas rendering in the browser; Web Share API with files where supported. | **Working** | Wallpaper is static: it must be regenerated for a new verse; daily notifications are the automatic lock-screen fallback. | `widgets.html:880-930`, `assets/pd-widget.js` |
| Daily verse notifications | `/widgets` → "Send me daily verses", choose times; admin can override a date. | `userVerseSettings/{uid}`, scheduled `dailyVerseDispatch` every 15 minutes in `Africa/Lusaka`, FCM; local SW periodic/background sync and catch-up. | **Partially Working** | Same verse-bank mismatch; delivery requires a valid device token and server configuration. | `functions/index.js:1061-1180`, `assets/pd-verse-alerts.js`, `sw.js:469-478` |

## B.3 Prayer, community and pastoral care

| Feature | Access & intended behaviour | Implementation / backend | Status | Problems / improvements | Source |
| --- | --- | --- | --- | --- | --- |
| Prayer Wall | `/prayer` → submit request, see approved requests, pray (count), follow, mark answered, delete own. | Firestore `prayers`; `status: 'approved'` gating in rules; `prayedBy` array with `increment`; admin moderation. | **Working** | Live moderation state untested; page uses snapshot queries which can be read-costly at scale. | `prayer.html:745-1127`, `firestore.rules:151-163` |
| AI Prayer Assistant | `/ai-prayer` → type a concern → curated verses/prayer points/share; Domey iframe companion. | `ai-prayer-data.js` topic matching in browser; no LLM API and no per-request cost; third-party `three.ws` widget for talking host. | **Partially Working** | Name "AI" is generous: it is a deterministic topic matcher plus an external hosted widget. The third-party iframe is an availability/privacy dependency. | `ai-prayer.html`, `ai-prayer-data.js` |
| Community chat | `/chat` → rooms, messages, typing indicators, read receipts, private chats, user search, media upload, voice/video call, statuses. | Firestore `privateChats`, dynamic `groupMessages_*`/`privateMessages_*`, `statuses`, `callHistory`; Cloudinary uploads; WebRTC call peer. | **Working (structurally)** | Dynamic collections are not all explicitly covered by rules; rule coverage should be audited with emulator tests. No real call/media test here. | `chat.html:1841-2600`, `firestore.rules` |
| Testimonies | `/testimony` → submit, browse approved, like, share, admin approval. | Firestore `testimonies`, status gating, share links via `/testimony/:id`. | **Working** | Images use Cloudinary/remote URLs; validate MIME/size at upload boundary. | `testimony.html:1006-1185`, `functions/share.js` |
| Gallery | `/gallery` → browse approved photos, admin upload/approve. | Firestore `gallery`; image uploads through `PDUpload` to Cloudinary. | **Working** | Same remote-host dependency. | `gallery.html`, `assets/pd-upload.js` |
| Member care | `/membership` and admin → member care requests. | Firestore `memberCareRequests`, admin review. | **Working** | Not publicly visible; needs staff SLA/process rather than code. | `membership.html:1588-1660`, `admin.html` |
| Support / member wallet | `/support` → support plans, giving, claims, wallet balance, transactions, deposits/withdrawals. | Firestore `supportPlans`, `supportProgrammes`, `supportClaims`, `wallets`, `walletTransactions`, `paymentRequests`, `subscriptions`; Vercel billing API; Firebase Storage receipts. | **Working (structurally)** | Real payment confirmation depends on provider/webhook configuration; no live transaction tested. | `support.html:1200-2300`, `functions/billing.js`, `lib/billing-server.js` |
| Membership & digital card | `/membership` → application, documents, signature, card preview, QR, verification. | Firestore `memberships`, `users`, callable `reserveMembershipNumber`, `ensureMyCard`, `verifyMembership`; signed QR projection `membershipVerification`. | **Working** | Requires Play/finance operational processes; card templates stored in Firestore. | `membership.html`, `functions/verification.js`, `verify.html` |

## B.4 Media, live and radio

| Feature | Access & intended behaviour | Implementation / backend | Status | Problems / improvements | Source |
| --- | --- | --- | --- | --- | --- |
| Live service page | `/live` → player, viewer count, reactions, chat, schedule, sermon link, "watch last service". | Firestore `liveStatus`, `liveChat`, `liveSignals`, `scheduledLives`, `liveRecordings`; HLS via `hls.js`; WebRTC via `assets/pd-live-webrtc.js`; `/api/live-ice` mints TURN credentials. | **Needs Testing** | Implementation is detailed and tests cover wiring/server-authoritative presenter sessions, but no real broadcast/viewer session was run. TURN provider keys are required for reliable mobile/carrier viewing. | `live.html`, `assets/pd-live-webrtc.js`, `api/system.js:70-160` |
| Live lounge / Domey | Waiting-room host greets, prays and reads the verse. | Local mascot assets (`three.module.min.js`, VRM/GLB), speech synthesis, local question bank (~1,248 entries). | **Partially Working** | Visual/WebGL quality and real speech behaviour are unverified without a browser/device. | `live.html`, `assets/pd-domey3d.js`, `assets/pd-domey-lady.js` |
| Sermons | `/sermons` → list, search, reader with Scripture/reflection/prayer, narration and share. | `sermons-data.js` local library, `speechSynthesis`, Firestore `sermons` for admin-managed entries. | **Working** | Narration is TTS, not recorded audio. | `sermons.html`, `sermons-data.js` |
| Video / media archive | `/video` → live status, past recordings, AI video library, share. | Firestore `liveRecordings`, `aiVideos`, Cloudinary-hosted video, HLS playback. | **Partially Working** | Content depends on admin-published records and Cloudinary configuration. | `video.html:1071-1160`, `assets/pd-cloud-video.js` |
| Scripture Studio (AI Video) | `/scripture-studio` → script, canvas render, narration, MediaRecorder export, submit for admin review. | Browser canvas + MediaRecorder; Firestore `aiVideos`; no server-side video generation or paid AI API. | **Working (structurally)** | Browser codec support varies; exported video size/quality untested. | `ai-video.html:636-830` |
| Radio player and podcasts | `/radio` → station list, schedule, briefing, worship songs, play/pause via shared player. | Firestore `radioSchedule`, `worshipSongs`, `radioScripts`, `radioVoices`; `assets/pd-radio-live.js`; `api/radio.js`. | **Working** | Stations with no `streamUrl` are disabled; actual audio depends on admin-approved licensed tracks. | `radio.html`, `api/radio.js`, `assets/pd-radio-live.js` |
| 24/7 radio automation | Listener-side playout: schedule → approved playlist → intro → music → now playing → history; presenter takeover and fallback. | Firestore + optional Cloudflare R2 + TTS announcements; self-hosted Icecast/Liquidsoap stack in `radio/server/` for a true central stream. | **Partially Working** | The repository itself honestly documents that **no free serverless platform can run a permanent encoder**. Browser-side automation starts only when a listener presses play; a central 24/7 stream needs `RADIO_STREAM_URL` and a machine. | `docs/RADIO-24-7.md:9-33, 125-146`, `radio/server/`, `functions/radio.js` |
| Radio Studio / presenter | Admin approves scripts/voices/tracks; members request presenter slots; server-authoritative start/heartbeat/end/watchdog. | Cloud Functions `radioPresenter*`, `radioAdmin*`, `radioSessionWatchdog`, `radioDiscovery*`; Firestore rules `write: false` for server-owned state. | **Working (structurally)** | Discovery licences are review-gated; R2 keys and admin token required for some endpoints. No live broadcast test. | `functions/radio.js`, `admin.html` Radio Studio, `tests/radio.test.js` |

## B.5 Finance, admin and operations

| Feature | Access & intended behaviour | Implementation / backend | Status | Problems / improvements | Source |
| --- | --- | --- | --- | --- | --- |
| Giving | `/give` → amount, currency conversion, purpose, official method, copy number, WhatsApp proof, receipt upload, transaction reference, submit. | Official methods from Firestore `settings/payments` (public read, admin write); receipt upload to Firebase Storage `givingEvidence/{uid}`; pending record in `offerings` with strict rules; admin finance approval. | **Working (structurally)** | No gift is "confirmed" until finance approves. Hosted-checkout link is only as good as the configured URL; card processing happens off-site. Live payment not tested. | `give.html:900-1310`, `firestore.rules:237-301`, `storage.rules` |
| Finance portal | `/finance` → role check, branch reports, historical reports, descriptions. | Firebase Auth + `financeRoleFromSnap`, Firestore `financialReports`; session in `pd_finance_session`. | **Working** | Client role caching should be replaced with/verified by server claims; see Section H. | `finance.html:922-1160` |
| Admin console | `/admin` → ~35 views: dashboard, members, team, locations, care, certificates, live control/analytics/schedule, events, devotionals, verses, sermons, notices, gallery, media, radio, AI video, content, news, hero banners, documents, finance, giving, payment verification, subscriptions, wallets, withdrawals, support plans, notifications, email, Facebook campaign, languages/translations, data audit. | Firestore CRUD, Cloud Functions callables, Cloudinary/R2, Brevo, server-side audit collections. Strong Firestore rules gate admin writes. | **Working (structurally)** | Extremely large single file (`admin.html` ~694 KB). Client UI gating plus localStorage role session is weaker than custom claims. Testing covered wiring, not every admin action against production data. | `admin.html:1129-1188`, `assets/pd-admin-extras.js` |
| Notifications center | Bell on every page → in-app list, mark read, clear, announcements; device-alert prompt; per-category toggles. | `PDApp.notifications`, Firestore `publicNotifications` mirror, FCM tokens in `userTokens`, preferences in `userNotificationPrefs`, SW messages. | **Partially Working** | Legacy `notificationList` in `index.html` reads restricted `notifications` directly and silently fails for ordinary members; two lists coexist. | `assets/pd-app.js:1240-1300`, `index.html:1533-1565`, `firestore.rules` |
| Email delivery | Admin → Email Delivery: templates, settings, outbox, test mail; account/security/membership/payment events. | Brevo API via Cloud Functions/Vercel, `emailTemplates`, `emailSettings`, `emailOutbox`, `functions/brevo.js`, `functions/email-design.js`. | **Partially Working** | Requires real Brevo key, verified sender/domain, SPF/DKIM/DMARC. Newsletter welcome on Vercel does not write an outbox row (documented). | `functions/brevo.js`, `functions/index.js:575-710`, `docs/FINAL-REPORT.md` |
| Events / RSVP | `/events`, `/event` → calendar, filters, details, RSVP/cancel, add event, add to calendar, my events. | Firestore `events`, `userEvents`; admin/public read; image upload via Cloudinary. | **Working** | Client-side event seeding when collection is empty; RSVP counters can drift under concurrent writes (use transactions). | `events.html:745-930`, `event.html:850-1335` |
| News / announcements | `/news` → categories, story links, share cards with OG metadata. | Firestore `news`, `/api/share` route for `/news/:id`. | **Working** | Rules allow public read of all `news`, including unpublished docs; the app filters visually. Move filtering into rules or query. | `news.html`, `functions/share.js`, `firestore.rules:60-68` |
| Documents / resources | `/resources`, `/documents`, `/resource-view` → PDF library and legacy Markdown reader. | Bundled PDFs; static viewer; SW precaches PDFs. | **Working** | `file_handlers` declaration is not implemented in `resource-view.html` (Section E). | `resources.html`, `documents/index.html`, `resource-view.html` |
| Team / about / contact / privacy | Static informational pages; contact form and support requests. | Firestore `contactMessages`, `teamMembers`, `teamMemberContacts`; public-safe projection. | **Working** | Contact-message create is public by rule; add rate limiting/captcha to control abuse. | `about.html`, `team.html`, `contact.html`, `privacy.html` |
| Locations | `/locations` → branch cards/maps; home page detects nearest branches. | `assets/pd-locations-data.js`, Firestore `churchLocations` admin-managed. | **Working** | Map links are external. | `locations.html`, `assets/pd-locations.js`, `firestore.rules` |
| Academy, quizzes, certificates | `/lessons`, `/lesson*`, `/quiz` → lessons, audio, PDF, quiz, progress, certificate at ≥80%. | Local academy data, Firestore `userQuiz`, `certificates`, `finalExamSubmissions`; `assets/pd-certificate.js`. | **Working** | Certificate name comes from profile; stale profile names can produce old names. | `assets/pd-academy.js`, `quiz.html`, `certificates.html`, `assets/pd-certificate.js` |
| Bible game / Domey | `/game` → XP, badges, streaks, leaderboard, voice quiz with Domey. | Local state + Firestore `leaderboard`, `users/{uid}/game/progress`; bundled 3D/VRM assets and question bank. | **Partially Working** | Visual quality/frame rate on low-end Android unverified; `assets/pd-domey-scan.js` is unwired. | `game.html`, `assets/pd-domey3d.js`, `assets/pd-domey-questions.js` |
| Sharing | Buttons on news, sermons, prayers, testimonies, lessons, team, translate, widgets; Web Share API, clipboard, WhatsApp/Facebook/X links; OG/Twitter/share metadata. | `PDApp.share`, `/share/:type/:id` server-rendered metadata cards. | **Working** | PWA `share_target` is declared but not implemented (Section E). | `assets/pd-app.js:2710-2770`, `functions/share.js`, `vercel.json` |
| Offline | Installed PWA precaches 93 URLs (~6.24 MiB), network-first HTML, network-first JS/CSS, stale-while-revalidate other assets, offline shell, Bible chapter cache in localStorage, verse catch-up. | `sw.js` (713 lines), `offline.html`, page-local caches. | **Partially Working** | Firestore features, payments, live/radio, uploads and FCM require network; 6.24 MiB precache is a notable first-install cost; admin is correctly excluded. | `sw.js:88-215, 240-345`, `offline.html` |
| PWA installation | Manifest, install banner, `beforeinstallprompt` capture, iOS instructions, update bar. | `manifest.json`, `PDApp.pwa`, `PDApp.appShell`. | **Working** | Browser-installed PWA and Play-store Capacitor APK are two distinct distribution paths with different notification behaviour. | `manifest.json`, `assets/pd-app.js:3196-3390`, `index.html:817` |

---

# C. Feature Status Table

| Feature | Status | Basis / caveat |
| --- | --- | --- |
| Homepage layout, cards, navigation, drawer | **Working** | 42-page nav/icon/lint tests pass; no real browser visual test. |
| Homepage hero visual redesign (desired) | **Needs Testing** / redesign required | Current implementation understood; mobile CSS conflicts with requested full-bleed design. |
| Splash screen (web + native assets) | **Working** | Source and assets verified; native splash not rendered here. |
| Daily devotional / daily challenge | **Working** | Local library and Firestore check-in rules verified; tests pass. |
| Bible reader, BSB offline text, translations | **Working** | 66 BSB JSON files, API handler and tests verified. |
| Bible search | **Working** | Local and server paths verified. |
| Bible notes / progress | **Partially Working** | Guest data does not migrate to signed-in account. |
| Audio Bible | **Partially Working** | Browser TTS only; no recorded audio. |
| Daily verse site/widget/wallpaper | **Partially Working** | Site and native widget parity tested; server push bank differs. |
| Daily verse push notifications | **Partially Working** | Code complete; mismatch above; no live FCM test. |
| Prayer Wall | **Working** | Firestore operations and rules verified; no live moderation test. |
| AI Prayer Assistant | **Partially Working** | Curated local matcher; third-party iframe dependency. |
| Live streaming | **Needs Testing** | WebRTC/HLS/signalling implemented; no real broadcast, TURN credentials or device test. |
| Live chat/reactions/viewers | **Working (structurally)** | Firestore wiring/rules tested; no load test. |
| Sermons / narration | **Working** | TTS narration verified in source. |
| Video archive / Scripture Studio | **Partially Working** | Depends on Cloudinary/Firestore content; MediaRecorder support varies. |
| Radio player / automation | **Partially Working** | Listener-side automation implemented; central 24/7 stream needs external server config. |
| Radio presenter/admin studio | **Working (structurally)** | Server-authoritative callables and rules tested. |
| Giving flow | **Partially Working** | Record/proof workflow complete; confirmation is manual/admin; no live payment. |
| Support/wallet/subscriptions | **Partially Working** | Extensive implementation; webhook/provider config required. |
| Finance portal | **Working (structurally)** | Role checks and reports verified in source. |
| Admin console | **Working (structurally)** | ~35 views; server rules protect data; no production action tested. |
| Events / RSVP | **Working** | Firestore and rules verified. |
| News / announcements | **Partially Working** | News works; marquee is local-only across devices. |
| Testimonies / gallery | **Working** | Firestore/Cloudinary paths verified. |
| Community chat / calls | **Working (structurally)** | Complex Firestore usage; rules coverage for dynamic collections needs emulator tests. |
| Membership card / verification | **Working (structurally)** | Callables and QR projection verified; tests pass. |
| Certificates | **Working** | Firestore and generation code tested. |
| Academy / quizzes / game | **Working (structurally)** | Tests pass; 3D visual quality unverified. |
| Translation / languages | **Working** | Local data and admin translation review. |
| Notifications center | **Partially Working** | Shared mirror works; legacy list path is broken for ordinary members. |
| Notification branding (web) | **Partially Working** | Branded icon/badge/title present; Chrome-origin label cannot be removed. |
| Notification branding (native) | **Partially Working** | Assets/channels/payload config present; needs `google-services.json` and device verification. |
| Search | **Partially Working** | Search exists per feature; no global search. |
| Sharing (user-facing buttons/OG) | **Working** | Web Share/clipboard/social links and `/share/:type/:id` verified. |
| PWA share target | **Not Implemented** | Declared in manifest; no `/share?title...` handler. |
| PWA file handler | **Not Implemented** | Declared for PDF; `resource-view.html` has no file-launch API code. |
| Protocol handler | **Not Implemented** | Not declared in manifest. |
| Offline shell | **Partially Working** | Precache/caching strategies verified; backend features need network. |
| PWA installation / updates | **Working** | Manifest, SW registration, install banner and update bar verified. |
| Android Capacitor shell | **Partially Working** | Native project present; no build/device run here; push config external. |
| Native Daily Verse widget | **Working (code)/Needs device test** | Full Java implementation and bridge verified; no Android SDK here. |
| Lock-screen widget on supported Android | **Needs Testing** | OS-gated (Android 16 QPR1+ phones; Android 15 QPR1+ tablets/Pixel Tablet). |
| Theme toggle | **Broken / inconsistent** | Button is a no-op on 7 pages; on the other pages the local function adds `dark-mode` but cannot remove it. |
| Legacy announcements list in bell | **Broken** | Reads token-bearing docs that members cannot read by rule. |

---

# D. Technical Architecture

## D.1 Frontend

- 42 root HTML pages plus `documents/index.html` and `404.html`.
- No bundler/framework; `pd-app.js` exposes a single `window.PDApp` namespace with modules: `tables`, `layout`, `appShell`, `pwa`, `ui`, `i18n`, `location`, `announcements`, `notifications`, `banners`, `stats`, `live`, `scripture`, `radio`, `activity`, `academyNav`, `share`, `roles`.
- Each module `init()` is wrapped in try/catch so one failure cannot take down the whole shell (`assets/pd-app.js:3496-3512`).
- Icons are locally generated SVG/CSS (`pd-icons.js`, `pd-icons.css`; 286 icons verified by lint), which avoids an icon-font CDN dependency.
- Third-party browser libraries: `moment.js`, `canvas-confetti`, `hls.js`, `three.module.min.js` (vendored), one external `three.ws` Domey iframe.

## D.2 Backend services

**Vercel serverless functions (`api/`)**

| Endpoint | Function | Purpose |
| --- | --- | --- |
| `/api/health` | `system.js` | Dependency-free deployment probe. |
| `/api/newsletter` | `system.js` → `functions/brevo.js` | Newsletter subscription/welcome with validation, consent and rate limiting. |
| `/api/live-ice` | `system.js` | Mints short-lived STUN/TURN credentials (Cloudflare or Metered/custom). |
| `/api/billing` | `system.js` → `lib/billing-server.js` → `functions/billing.js` | Checkout, evidence, subscriptions, withdrawals, wallet actions. Requires Firebase ID token (`verifyIdToken(..., true)`). |
| `/api/payment-webhook` | `system.js` → `lib/billing-server.js` | HMAC-verified provider confirmation. |
| `/api/share` | `share.js` → `functions/share.js` | Server-rendered OG cards for `/news/:id`, `/testimony/:id`, etc. |
| `/api/bible`, `/api/radio`, `/api/translate`, `/academy`, `/lessons`, `/progress`, `/quizzes`, `/resources`, `/stories` | corresponding `api/*.js` | Public read APIs and admin-gated operations. |

There are exactly 12 API files, matching the Hobby-plan function budget noted in `api/system.js`. `vercel.json` sets `maxDuration: 20` and `includeFiles` for shared server modules.

**Firebase Cloud Functions (`functions/index.js`, ~1,230 lines)** include:

- Registration verification (`sendRegistrationVerificationCode`, `verifyRegistrationCode`, cleanup).
- Brevo newsletter, password reset, login/password-change notices.
- Cloudinary signature.
- Scheduled daily devotional, prayer reminders, daily verse dispatch, expiring subscriptions, email retry.
- Firestore-triggered push fan-out (`sendPushNotification`, `sendTestNotification`).
- Membership verification, card numbering, email admin, payment/subscription/giving/announcement notifications.
- Radio presenter callables, watchdog and discovery scheduler.
- Facebook campaign generation/scheduler.
- Billing functions are present in `functions/billing.js` but the Vercel path uses `lib/billing-server.js`.

## D.3 Database and rules

- Firestore is the source of truth for users, roles, content, finance state, notifications and operational settings.
- `firestore.rules` is extensive and mostly well-scoped: admin-only writes for news/events/devotionals/radio settings, owner-only private data, server-only payment collections, validation for high-risk collections (team, locations, offerings, gifts, daily check-ins, certificates).
- Notable permissive rules: `liveSignals/{liveId}/{document=**}` is public read/create/update; `contactMessages` allow public create; `news` allow public read of unpublished entries; `liveChat` allows guest writes; `deposits` allow any signed-in create. These are deliberate trade-offs but need monitoring/rate limits.
- `storage.rules` is restrictive: giving/billing evidence owner-or-admin, radio audio admin-write/public-read, default deny.
- No Firestore offline persistence is enabled; offline behaviour relies on the service worker and page-local caches.

## D.4 Authentication and authorisation

- Firebase Auth with email/password plus Google popup in `account.html`.
- Registration requires a six-digit email code with rate limits and verification records (`functions/index.js:273-540`).
- Password reset goes through a callable using Brevo, with a Firebase SDK fallback.
- Admin/finance UI role comes from Firestore role documents with a localStorage mirror (`pd_admin_session`, `pd_finance_session`, TTL 7 days).
- Server-side enforcement is primarily Firestore rules, not custom claims. This is workable but should be hardened (Section H).

## D.5 Storage, media and payments

- Firebase Storage: private evidence and radio audio (rules above).
- Cloudinary: unsigned upload presets (`profile_photos`, `gallery_uploads`, `donation_proofs`, `news_images`, `financial_reports`, `live_streams`, `signatures`) via `assets/pd-upload.js`; signed URLs require server secret.
- Cloudflare R2: optional radio media mirror; credentials server-side only (`functions/r2.js`).
- Payments: no card data enters Firestore. Official payment methods are configured by finance in `settings/payments`; givers submit a reference plus uploaded proof; admins approve. Hosted-checkout links can be configured externally. Webhook signature verification uses `PAYMENT_WEBHOOK_SECRET`.

## D.6 Environment variables and deployment

Environment variable **names** observed (values never included here): `BIBLE_API_KEY`/`NIV_API_KEY`/`API_BIBLE_KEY`, `MSG_BIBLE_ID`, `NIV_BIBLE_ID`, `NLT_BIBLE_ID`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL/NAME`, `BREVO_REPLY_TO`, `BREVO_LIST_ID`, `BREVO_DOI_TEMPLATE_ID`, `PD_SITE_URL`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`, `PAYMENT_WEBHOOK_SECRET`, `CLOUDINARY_*`, `R2` configuration in `functions/r2.js`, `RADIO_STREAM_URL`, `RADIO_ADMIN_TOKEN`, `TURN_PROVIDER`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `METERED_TURN_API_KEY`, `TURN_*`, `JAMENDO_CLIENT_ID`, `TTS_SERVICE_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIRESTORE_EMULATOR_HOST`, plus CI signing variables (`ANDROID_KEYSTORE_*`, `PLAY_UPLOAD_KEY_SHA1`, `GOOGLE_SERVICES_JSON` base64).

Deployment:

- `npm run build:vercel` → `dist/` with only public files; Vercel serves static pages and `api/*` handlers.
- Firebase Hosting `predeploy` runs the same build and serves `dist`, with rewrites, cleanUrls, HSTS/CSP/CORP-style headers, long-lived asset caching and `no-cache` HTML/service workers.
- Codemagic/GitHub workflows build the Capacitor Android app and inject `google-services.json` and signing secrets when configured.
- `.well-known/assetlinks.json` contains the current app fingerprint and a legacy Median build fingerprint.

## D.7 Cost-sensitive services

| Service | Current usage | Cost implication |
| --- | --- | --- |
| Vercel | 12 functions, static hosting | Hobby plan budget explicitly respected; adding more API files requires consolidation or a paid plan. |
| Firebase | Auth, Firestore, Storage, Hosting, Functions, FCM | Spark may cover light usage; Cloud Functions needing outbound network and Secret Manager normally require Blaze. Set budgets/alerts. |
| Brevo | Verification, security, membership, payment and newsletter mail | Free tier has daily caps; deliverability requires verified domain and DNS. |
| Cloudinary | Images/video/uploads | Free tier likely sufficient initially; watch transformation/bandwidth. |
| Cloudflare R2 | Optional radio media | Generous free tier; no egress charge model, but credentials must be configured. |
| TURN | `/api/live-ice` supports Cloudflare or Metered | Metered is paid; Cloudflare TURN has its own limits. Without TURN, WebRTC fails on many mobile networks. |
| api.bible | NIV/MSG/NLT | Free Starter key can be enough if the account is entitled to those translations; no fallback for licensed editions. |
| Google Play | Native distribution | One-time developer fee; Play App Signing key must be reflected in `assetlinks.json`. |
| Third-party free APIs | BigDataCloud, ipapi.co, exchange rates | No contract/SLA; add caching and graceful fallbacks. |

No hard-coded private secrets were found in tracked source. The Firebase **web** API key is present in several pages; that value is public by design but should be restricted to authorised origins/APIs.

---

# E. Android and PWA Audit

## E.1 Manifest (`manifest.json`)

**Implemented and correct:**

- `name`, `short_name`, `description`, `id: "/"`, `start_url: "/?source=pwa"`, `scope: "/"`, `display: standalone`, `display_override`, `orientation: portrait`, theme/background colours, `lang`, categories.
- Four real PNG icons: `logo-192.png` (192²), `logo.png` (512²), maskable 192² and 512². Sizes were verified.
- Ten launch shortcuts (Admin, Bible, Prayer, Assistant, Live, Sermons, Translate, Lessons, Games, Certificates), all pointing to valid routes.
- Screenshots: wide `hero-worship.jpg` (1672×941, matches declaration); narrow screenshot is the 512² logo, not a phone-shaped screenshot — weak install UI.
- `handle_links: preferred`, `launch_handler: navigate-existing`, `edge_to_edge: preferred`, `scope_extensions` for `https://prayerdome.net` are progressive enhancements; support varies by browser/OS.

**Declared but not implemented:**

- `share_target`: `{ action: "/share", method: "GET", params: title/text/url }`. Deployment config only rewrites `/share/:type/:id`; `functions/share.js` parses `type`/`id` and falls back to `news`, ignoring shared `title`, `text` and `url`. A live read-only fetch of `/share` failed, while `/share/news/test` worked. **A share sent from Android to the installed PWA is therefore not handled.** Either implement a `/share` intake page or remove the declaration.
- `file_handlers` for PDF → `/resource-view.html`. That page only loads legacy `/documents/*.md?file=` and contains no `launchQueue`/File System Access code. **Declared only.**
- `protocol_handlers`: **not declared** and not implemented.
- Installability itself is real: `PDApp.pwa` registers `/sw.js`, captures `beforeinstallprompt`, shows an install card, hides it after dismissal/installation, and offers an update bar.

## E.2 Service worker (`sw.js`)

- Cache name `prayer-dome-v56`; 93 precache URLs totalling **6.24 MiB** (measured), all present in the repository.
- Install: `skipWaiting`; activate: clean old caches and `clients.claim`.
- Fetch strategy: HTML network-first → cache → `/offline.html`; JS/CSS network-first with cache fallback; other same-origin assets stale-while-revalidate; Firebase/Cloudinary hosts never cached; range requests bypass the worker; `/admin` and `/admin.html` are network-only and never cached.
- Background verse catch-up on navigation (throttled to 30 minutes), `periodicsync` and `sync` tags for verse alerts, push and notification-click handlers, `notificationclose` read-state message, and a `message` handler for SKIP_WAITING/verse settings.
- `firebase-messaging-sw.js` is a fallback worker; the root worker imports the vendored Firebase Messaging SDK and avoids double-drawing notifications.

## E.3 Installation, icons and splash

- Web install: manifest + SW + install banner + iOS Share→Add to Home Screen instructions.
- Splash: web overlay with theme verse in `index.html`; native Android splash theme in `styles.xml` and drawable splash PNGs; `mobile/splash.png` is 1080×1920.
- Launcher icons: adaptive XML + PNG densities in `android/app/src/main/res/mipmap-*`; `mobile/app-icon.png` is 1024². Monochrome notification icon is `drawable/ic_notification.xml` (white dome/cross vector, 24dp).
- The Daily Verse widget has its own preview and four theme backgrounds.

## E.4 Notifications and channels

**Implemented in code:**

- Seven Android channels in `assets/pd-app.js:1101-1113`: general, verse, live, prayer, news, sermon, events; importance, vibration, lights and default sound are set; `bindNativePush()` calls `push.createChannel()`.
- Matching seven channel IDs in the FCM payload (`functions/index.js:103-114, 117-165`) with `android.notification.icon: ic_notification`, `color`, `sound: default`, priority high, TTL one day, webpush icon/badge/tag/vibrate/actions, and APNS sound.
- Manifest meta-data declares default notification icon, colour and channel.
- Web/root SW draws branded notifications with `icon`, `badge`, `tag`, actions and click routing; `fcmOptions.link` and data payloads drive deep links.

**Gaps:**

- `assets/pd-app.js` calls `Capacitor.Plugins.LocalNotifications` in `showNative()`, but `@capacitor/local-notifications` is **not** in `package.json` and not installed. That path is dead; foreground native notifications rely on the FCM plugin instead.
- Native push requires `android/app/google-services.json`, injected by CI from `GOOGLE_SERVICES_JSON`. The file is not in the repository (correct for secrets), so a local unsigned build without it will not deliver FCM.
- The webpush `badge` is the full-colour `logo-192.png`; Chrome on Android expects a monochrome white-on-transparent badge for the status-bar icon. Add a dedicated `logo-badge-192.png`-style monochrome asset and reference it.
- Custom notification sound/brand chime is not implemented; all channels use `default`. A branded sound needs a native resource plus channel creation (channel sound cannot be changed after creation without a new channel ID).

## E.5 Deep links and Android integration

- Native App Links intent-filter for `https://www.prayerdome.net` with `autoVerify="true"`; `.well-known/assetlinks.json` has the app fingerprint and a legacy fingerprint. Lint validates the file but cannot verify the installed APK's signing key.
- The root domain `prayerdome.net` redirects to `www`; the manifest declares an intent-filter only for `www`, so only that host is verified. Add the root host if Play signing confirms it.
- Notification clicks deep-link to `/bible.html?verse=...`, `/prayer.html`, `/live.html`, `/news.html`, etc.; widget taps route to `/widgets.html` via the `pd_route` intent extra.
- Native capabilities present: camera/mic permissions for WebRTC, FileProvider, `POST_NOTIFICATIONS`, boot receiver for verse alarms, widget provider, Capacitor `VerseWidget` plugin. There is no native database, native media player or native UI beyond the WebView and widget.

## E.6 Lock-screen verse widget — existing implementation

The repository already contains a complete native widget chain:

`assets/pd-verse-data.js` → `scripts/build-widget-verses.mjs` → `res/raw/pd_widget_verses.json` → `VerseWidgetData.java` → `VerseWidgetRenderer.java` → `RemoteViews` → launcher/keyguard.

- `VerseWidgetProvider.java` handles update, boot, package replacement and refresh/tick; `VerseWidgetScheduler.java` arms one `setAndAllowWhileIdle` alarm per slot boundary (00:00, 11:00, 14:00, 18:00) — four wake-ups/day, no background service.
- `VerseWidgetStore.java` persists theme, text size, greeting/reference/brand toggles and an optional pinned verse in SharedPreferences.
- `VerseWidgetPlugin.java` exposes `getState`, `setPreferences`, `pinVerse`, `clearPin`, `refresh`, `requestPin`, `pendingRoute` to `/widgets.html`.
- `verse_widget_info.xml` declares `widgetCategory="home_screen|keyguard"`, 4×2 target size, resizable 180–460dp × 70–280dp, `updatePeriodMillis="0"`, preview layout.
- `tests/widgets.test.js` verifies verse parity (48 checkpoints), slot boundaries, all Java method/resource references and the studio behaviour without an Android SDK.

This is a genuine Android `AppWidget`, not a web widget. It renders without opening the app and requires no data after installation.

## E.7 What requires native Android versus PWA

| Capability | PWA | Native Android |
| --- | --- | --- |
| Scripture notification on lock screen | Yes, via Web Push/FCM; branding partly browser-controlled | Yes, full control of icon, channel, sound, actions |
| Add a widget to home screen | **No standard web API** | Yes (`AppWidgetProvider`) |
| Add a widget to lock screen | **No** | Yes, only where the OS exposes lock-screen widgets |
| Update widget without opening app | Not applicable | Yes, alarm + provider |
| Custom small icon / channel / sound | No | Yes |
| Share target | Yes (manifest; must implement route) | Native ACTION_SEND alternative available |
| File handler / deep app links | Limited | Yes with intent-filters and assetlinks |
| Background data/battery | Browser-managed | Explicit alarms, no service |

---

# F. New Features Required

## F.1 Lock-screen Bible verse experience

**Status: mostly implemented already; treat this as a parity, compatibility and polish project.**

Android's current platform position: Google states lock-screen widgets became available in AOSP for tablets and phones starting with the release after Android 16 (QPR1), that all widgets are compatible, and that OEMs may choose the trigger (for example charging or docking). Lock-screen widgets were already available on Pixel Tablets [2](https://android-developers.googleblog.com/2025/03/widgets-on-lock-screen-faq.html). OEM adoption and triggers are not guaranteed.

**Desired experience → implementation reality**

| Desired | Current state | Required work |
| --- | --- | --- |
| Beautiful branded verse + reference | Four themes, greeting/reference/brand toggles, `RemoteViews`, preview in `/widgets` | Design review on real devices; dynamic colour and resizing recommended by Google [2](https://android-developers.googleblog.com/2025/03/widgets-on-lock-screen-faq.html). |
| Daily automatic update | Four deterministic slots, 4 alarms/day | Fix server push parity (G.1); verify Doze/battery-optimisation behaviour on target OEMs. |
| Refresh/change verse | Card refresh target, pin/clear in studio, daily rotation, random wallpaper verse | Keep; add an explicit "next verse" in the widget if desired (pin already covers "change"). |
| Prayer Dome branding | Logo/wordmark in card, NIV attribution | Keep; consider CC0 BSB option if verse licensing needs simplifying. |
| Supported devices/versions | `minSdk 24`, `targetSdk 36`, keyguard category | Document support matrix in product UI; test Android 16 QPR1+ phone and Android 15 QPR1+ tablet. |
| No app open each time | Alarm + provider renders directly | Already satisfied. |
| Minimal battery/data | `setAndAllowWhileIdle`, `updatePeriodMillis=0`, packaged JSON | Already satisfied; no background service. |
| Tapping from lock screen | Deliberately requires unlock (no `showWhenLocked`) | Keep for security; document that Android requires authentication unless the activity opts out [2](https://android-developers.googleblog.com/2025/03/widgets-on-lock-screen-faq.html). |

**Alternatives for unsupported devices**

1. **Notification-based verse display** — already implemented via FCM and SW; works on any Android/iOS PWA with notification permission. Best universal fallback.
2. **Home-screen widget + wallpaper studio** — already implemented; the wallpaper must be regenerated manually.
3. **Always-on display / notification channel** — OS-controlled; cannot be built as a web API.

**Acceptance tests to add before release:** real device install, widget placement, reboot/pin persistence, boundary refresh, wallpaper generation, lock-screen placement on a supported OS, notification parity with widget verse, low-power-mode behaviour.

## F.2 Notification branding

**What exists:** branded launcher/adaptive icons, monochrome small icon, app name/colour/channel metadata, seven Android channels, webpush `icon`/`badge`/actions, FCM `android`/`apns` payloads, click routing, default sound.

**Reality check:** an installed Chrome PWA on Android still shows browser-origin UI (the browser/site line cannot be removed by the site). Web.dev notes that without a badge Android shows a browser icon, and that Chrome on Android uses the badge for the small status-bar mark [3](https://web.dev/articles/push-notifications-display-a-notification). Full control of the small icon, channel importance, sound and lock-screen visibility requires the native app path.

**To get consistent Prayer Dome branding:**

1. Web: add a monochrome white-on-transparent badge asset and use it for `webpush.notification.badge` and SW fallback `badge`; keep 192px+ colour `icon` for the large image.
2. Native: ship `google-services.json` in CI, ensure Capacitor Push Notifications is registered, verify FCM tokens are native (not web) in `userTokens`, and confirm `android.notification` fields are applied to those tokens.
3. Keep the existing channel IDs stable; changing sound/importance requires a **new** channel ID on Android.
4. If a branded sound is required, add an Android resource and create channels with that sound at first install.
5. Keep notification titles short; Android truncates long text. Use branded copy in the `title`, not in the origin line.
6. Verify click routing on a device for every `kind` (verse, live, prayer, news, sermon, event) and for action buttons.

## F.3 Homepage hero redesign

**Current implementation (verified):**

- Markup: `index.html:792-808` — `<div class="hero" data-pd-hero>` with two full-bleed `<img class="hero-cinema-layer">`, shade/glow overlays, logo/wordmark, typing `<h1>`, paragraph and three CTAs.
- CSS: `index.html:335-395` — `min-height: clamp(430px, 46vw, 600px)`, `width: 100%`, `border-radius: 0 0 36px 36px`, crossfade/pan keyframes (`pdHeroPan`, `pdHeroPanAlt`, `pdHeroFadeA/B`), reduced-motion fallback, text shadows and gradient overlays.
- Admin-managed banner path: `assets/pd-app.js:2096-2145` replaces the hero with `.pd-hero-managed`, `.pd-hero-img`/`.pd-hero-video`, `.pd-hero-shade`, `.pd-hero-content`, live pill. CSS lives in `assets/pd-brand.css:877-930`.
- **Conflict:** `assets/pd-brand.css:3047` inside `@media (max-width: 720px)` sets `.pd-home .hero { padding:32px 24px 38px; border-radius:24px; margin:0 16px; min-height:0; }`. This turns the hero into a rounded card with side gaps on phones and removes the height cap — the opposite of the requested full-bleed, card-free design.
- `assets/pd-responsive-fix.css` only sets flex/gap rules; it does not override the hero.
- Images: `assets/hero-prayer.jpg` 1376×768 (~180 KB) and `assets/hero-worship.jpg` 1672×941 (~92 KB); both are precached by `sw.js`.
- Text animation: `index.html:1279-1320` cycles six encouraging messages, disabled on ≤720px and reduced motion.

**Components that need changing (without replacing functionality):**

1. `index.html` hero CSS: remove all bottom corner radius, make the section full-bleed at every width, set a consistent `clamp()` height, keep overlays and text shadow, improve `object-position` per breakpoint to avoid awkward cropping.
2. `assets/pd-brand.css:3047-3057`: remove `margin: 0 16px`, `border-radius: 24px` and `min-height: 0`; preserve mobile font/CTA sizing.
3. `assets/pd-brand.css:877-930`: apply the same full-bleed/no-card treatment to `.pd-hero-managed` so admin scheduled banners match.
4. `assets/pd-app.js:2121-2145`: keep the managed banner replacement, its live pill and CTA logic; only change classes/CSS, not the renderer.
5. `index.html` hero markup: keep `data-pd-hero`, both cinema layers, `[data-pd-scripture]`, `#typingHeading`, CTA links and `[data-pd-install-banner]` mount.
6. `sw.js`: if new hero artwork is introduced, update the precache list and cache version.
7. Add a narrow, low-opacity gradient or scrim rather than relying on the remote `transparenttextures.com` pattern in `.hero::after`; this removes another external request.

Recommended visual direction: one primary photograph spanning 100% width, a restrained Ken Burns/crossfade (already present), layered navy→transparent gradient, gold accent line, 48–60vh capped height, centred content with a max-width reading measure, and a soft transition into the following section without a card boundary. Preserve reduced-motion behaviour.

---

# G. Bugs and Problems

Each item below was found by direct source inspection; impact and cause are stated where known.

1. **Server push verse does not match site/widget verse (verified).** `assets/pd-verse-data.js` has 80 verses and uses `(dayIndex * 4 + slotIndex) % pool.length`; `functions/verse-bank.js` has 20 verses and uses `abs(daysSince2024-01-01) % 5` with no slot offset. On 2026-11-26 the site shows Lamentations 3:22-23 / Psalm 46:1 / Philippians 4:6-7 / Psalm 63:6, while the server bank shows Isaiah 40:31 / 1 Peter 5:7 / Isaiah 30:15 / Psalm 42:8. A user can therefore see one verse in the widget and a different one in the lock-screen notification. **Fix:** generate `functions/verse-bank.js` from `assets/pd-verse-data.js` (as `scripts/build-widget-verses.mjs` already does for Android) and add parity checkpoints to CI.

2. **PWA share target is declared but nonfunctional.** Manifest `share_target.action` is `/share`; no route handles bare `/share?title=...&text=...&url=...`, and `functions/share.js` ignores those parameters. **Fix:** add a small `/share` intake page/route that renders original text/link or a branded fallback, or remove the declaration.

3. **PWA file handler is declared but nonfunctional.** `file_handlers` accepts PDF at `/resource-view.html`, but that page has no `launchQueue.setConsumer` / File System Access handling and only reads legacy `.md?file=` URLs. **Fix:** implement the launch queue or remove the declaration. Note Chrome OS is the main supporter; Android support is limited.

4. **Theme toggle is a dead/inconsistent control.** `assets/pd-app.js:570-580` treats the OS `prefers-color-scheme` as the default (an explicit `data-pd-theme` attribute can override it). Fifteen pages render a `.theme-toggle-btn`; seven of them (`lesson-audio.html`, `lesson-pdf.html`, `lesson-quiz.html`, `lesson.html`, `lessons.html`, `resource-view.html`, `stories.html`) have no `toggleDarkMode` definition, so clicking is a no-op. On the other pages the local function reads the *current* state with `PDApp.theme.isDark()` and then calls `classList.toggle('dark-mode', dark)` with that same value — in light mode it adds the class, but a second click still computes `dark === true` from the OS/attribute and **never removes it**. It is effectively a one-way switch and does not persist across navigation. `resource-view.html` uses the same class for a back-link, so the selector is not uniformly a button. **Fix:** remove the buttons or implement one real, persisted override using `data-pd-theme`.

5. **Legacy notification list in `index.html` fails for ordinary members.** `loadNotifications()` queries Firestore `notifications`, whose rule is `isAdmin() || !('tokens' in resource.data)`; admin push documents contain `tokens`, so a member's query is denied and the promise is swallowed by `console.error`. The shared `PDApp.notifications` panel works via `publicNotifications`, but two lists are rendered in the same panel. **Fix:** remove the legacy loader/list and rely on the public mirror.

6. **Announcement marquee is device-local only.** Admin publishing writes Firestore `announcements` but updates only the admin's localStorage marquee; other users do not see it in the bar until their local content is updated. **Fix:** listen to `announcements` or `publicNotifications` in `PDApp.announcements`.

7. **`LocalNotifications` is referenced but not installed.** `assets/pd-app.js:1581` calls `Capacitor.Plugins.LocalNotifications`, but `package.json` only includes `@capacitor/push-notifications`. Foreground native notifications and custom channel scheduling cannot use that path. **Fix:** add the plugin and sync native, or remove the dead path.

8. **Native push silently depends on an injected secret.** `android/app/build.gradle` logs "Push Notifications won't work" when `google-services.json` is absent. CI injects it, but local builds do not. **Fix:** document/verify the release pipeline and add a startup diagnostic in the admin notification settings.

9. **App Links cover only `www.prayerdome.net`.** Root `prayerdome.net` redirects, which Android does not follow during verification. **Fix:** add the root host to the intent-filter and assetlinks statement after confirming Play signing fingerprint.

10. **Admin/finance roles are UI-cached for 7 days in localStorage.** Firestore rules still gate data, but a shared device can briefly show admin UI after sign-out/role removal. **Fix:** move roles to Firebase custom claims, keep the cached session only for rendering continuity, and revoke aggressively on sign-out.

11. **Some Firestore rules are intentionally permissive.** `liveSignals/{liveId}/{document=**}` allows unauthenticated read/create/update/delete; `liveChat` allows guest writes; `contactMessages` allow anonymous create; `news` allows public read of unpublished docs. **Fix:** add size/rate constraints, server cleanup for transient signals, and move publication filtering into rules where practical.

12. **Firebase Web config is duplicated across ~20 files, and `ai-video.html` uses a different `appId`** (`web:8de1...` versus the common `web:1222...`). This is config drift and can cause support confusion. **Fix:** centralise config in one module loaded by all pages.

13. **CSP is permissive:** `script-src 'unsafe-inline' 'unsafe-eval'` and `img-src/media-src https:` reduce XSS containment; many pages build `innerHTML` from dynamic content. **Fix:** nonce/hash inline scripts where practical, tighten media/image hosts, and audit all `innerHTML` sinks.

14. **Large assets and precache cost:** `assets/domey/human/VRM1_Constraint_Twist_Sample.vrm` is ~10.28 MiB; `assets/logo-master.png` 1.62 MiB and `logo-source.png` 0.31 MiB are copied into `mobile/www` even though Vercel excludes them; SW precaches 93 URLs/~6.24 MiB including PDFs. **Fix:** exclude design originals from mobile packaging, lazy-load 3D assets only when the game/lounge is opened, and reduce initial precache to the true shell.

15. **External runtime dependencies:** Google Fonts, moment.js, canvas-confetti, hls.js CDN, `three.ws` iframe, exchange-rate APIs, geolocation APIs. Each is a potential outage/privacy/performance source. **Fix:** vendor critical libraries, self-host fonts, cache API responses, and provide graceful fallbacks.

16. **Vercel function budget is exactly at the Hobby limit (12).** Adding a new function without consolidating will require a paid plan. **Fix:** route new features through existing `system.js`/consolidated handlers.

17. **Licensing diligence remains open:** `docs/BIBLE-LICENSING.md` flags NLT/ESV mirrors with unverified rights and notes that NIV/MSG require an entitled api.bible account. The widget bundles NIV text with attribution. **Fix:** obtain/confirm written permissions and prefer the CC0 BSB for bundled offline content if licensing needs simplifying.

18. **No real end-to-end verification of high-risk flows** (payments, FCM, live WebRTC, radio, admin writes, Android build). The 1,967 assertions verify structure, not outcomes.

---

# H. Security and Performance

## H.1 Security strengths (verified)

- Firestore rules are unusually thorough for a community app: role changes restricted to admins, private user documents owner-scoped, payment/subscription collections server-only, giving records validate amount/currency/reference/status and reject card fields, team/location/church-ID projections separate public from private data.
- Storage rules default-deny and keep giving/billing evidence owner-or-admin with size and MIME limits; radio audio is admin-write only.
- Billing API verifies Firebase ID tokens with revocation check, HMAC-verifies webhooks, rate-limits, and never logs request bodies containing tokens.
- FCM fan-out deduplicates and disables dead tokens; per-user notification preferences are honoured server-side.
- Security headers include HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and a CSP.
- No private keys, service-account JSON, Brevo key, R2 secret or keystore were found in tracked files.

## H.2 Security risks and recommended improvements

| Risk | Recommendation |
| --- | --- |
| Role docs + localStorage UI gating | Use custom claims for admin/finance; keep localStorage only as a non-authoritative rendering cache; clear on sign-out. |
| Permissive live signalling and guest chat/create rules | Add payload size/type validation, per-IP/per-user rate limits, TTL cleanup jobs and admin-only deletion of stale data. |
| Public `news` read includes unpublished docs | Enforce `published == true || isAdmin()` in reads/list queries. |
| Broad CSP (`unsafe-inline`, `unsafe-eval`, `https:` wildcards) | Introduce nonces/hashes, remove `unsafe-eval`, narrow connect/media/img hosts to used domains. |
| `innerHTML` across many pages | Standardise on a shared escape helper; audit dynamic attribute values (URLs, `onclick` arguments) not just text. |
| Firebase web config duplicated, one appId differs | Centralise and restrict the web API key by HTTP referrer and API; document allowed domains. |
| Contact/public create endpoints | Add CAPTCHA or rate limiting and moderation alerts. |
| HTML escaping in server-rendered share cards | Already escaped in `functions/share.js`; keep it that way when adding the share-target page. |
| Payment evidence URLs | Signed URLs are generated server-side; confirm short expiry and no public listing. |
| Dependency freshness | `firebase-functions ^7.4.0`, `firebase-admin ^13.10.0`, Capacitor 8.x, jsdom 26; run `npm audit` and schedule upgrades. |

## H.3 Performance

- **First load:** root HTML pages are large (`admin.html` ~694 KB, `index.html` ~118 KB, `chat.html` ~218 KB); several JS modules are also large.
- **Install:** SW precaches 93 files / 6.24 MiB including six PDFs and multiple images; this is acceptable for an offline Bible app but costly on slow mobile connections. Prioritise shell, then lazy-cache documents on first use.
- **Images:** hero images are O(100 KB), reasonable; `support/*.jpg` and `sermons/*.jpg` are ~200-300 KB; no `srcset`/AVIF/WebP pipeline was found. Add responsive sources and compression.
- **Fonts:** five Google Font families requested on nearly every page; self-host subsets or reduce families.
- **3D/media:** the 10 MiB VRM and 650 KB three.js are needed only on game/live pages but are bundled into the mobile web assets; load on demand.
- **Audio/video:** range requests bypass the SW (correct); Cloudinary media should use lazy loading, poster images and adaptive HLS.
- **Database:** Firestore queries use `onSnapshot` for chat/live/prayer lists; add pagination and indexes for growing collections (`firestore.indexes.json` exists). Avoid full-collection `getDocs` where queries can be bounded.
- **Caching:** HTML revalidates; JS/CSS fetch fresh with cache fallback; API calls are network-only. This is a good freshness/offline balance.
- **PWA/native:** SW is deliberately disabled in the Capacitor WebView to avoid interfering with the bridge; native app relies on bundled assets and HTTP cache.

## H.4 Accessibility

- Positive: semantic landmarks/ARIA labels on many controls, `aria-live` on notifications/challenge, focus-visible styles in mobile CSS, reduced-motion handling for hero/animation modules, text shadows/overlays for hero readability.
- Gaps: contrast of gold-on-white and small `.68rem` labels should be checked with axe/Lighthouse; modal focus trapping and keyboard escape are inconsistent across hand-written modals; many icon-only buttons rely on titles rather than visible labels; video/audio players need captions/transcripts; the canvas-generated certificate/video and 3D mascot need text alternatives where they carry meaning.
- **No automated accessibility audit was run** in this environment.

---

# I. Recommended Development Priorities

## I.1 Critical fixes

1. Unify verse sources: generate `functions/verse-bank.js` from `assets/pd-verse-data.js`; add parity tests so widget, website, SW and push always agree.
2. Implement or remove PWA `share_target` and `file_handlers`; do not leave non-working declarations.
3. Fix the theme toggle inconsistency (remove dead buttons or implement a real persisted override).
4. Remove the broken legacy notification list and keep one source of truth (`publicNotifications` mirror).
5. Confirm native push configuration (`google-services.json`, plugin registration, token type) and device-test FCM delivery/branding.
6. Audit and harden permissive Firestore rules (`liveSignals`, `liveChat`, `contactMessages`, unpublished `news`).

## I.2 Important functionality

1. Firestore marquee subscription for admin announcements across all devices.
2. Migrate admin/finance roles to custom claims; tighten session caching.
3. Add guest→signed-in migration for Bible notes/progress and daily challenge where appropriate.
4. Add pagination to high-volume Firestore lists and admin views; split `admin.html` into modules.
5. Verify giving/payment flows end-to-end with a test account and webhook signature configuration; document which methods are enabled.
6. Verify live WebRTC and radio automation with real devices, including TURN fallback and presenter takeover.
7. Test the Firestore rules with `npm run test:rules` on a Java-equipped machine.

## I.3 New features

1. Finish and device-test the lock-screen verse widget (Section F.1), including parity with notifications.
2. Add monochrome notification badge asset and branded native sound if desired (Section F.2).
3. Implement a real PWA share-target intake page if shared links are a product priority.
4. Consider a global site search (new capability, not a repair).
5. If "audio Bible" is meant to be recorded audio, license and integrate real recordings; keep TTS as fallback.

## I.4 Visual improvements

1. Full-bleed, card-free, height-capped hero across mobile/tablet/desktop (Section F.3).
2. Apply the same treatment to admin-managed hero banners.
3. Replace external texture dependency with an in-CSS overlay; refine text readability and image cropping.
4. Replace the manifest's logo-only narrow screenshot with a real phone-shaped screenshot.
5. Review Domey/AI page visual quality on a real phone.

## I.5 Performance optimisation

1. Reduce SW precache to a true shell; lazy-cache PDFs and optional pages.
2. Exclude `logo-master.png`/`logo-source.png` from `mobile/www`; lazy-load VRM/3D assets.
3. Self-host or subset fonts; vendor critical CDN libraries.
4. Add `srcset`/modern formats for large images; use Cloudinary transformations where already available.
5. Monitor Firestore read volume from `onSnapshot` listeners and admin full-collection queries.

---

# J. Final Development Roadmap

| Phase | Work | Exit criteria |
| --- | --- | --- |
| **0. Baseline (done in this audit)** | Read-only source audit; full test/lint run; production health check; no source changes. | Report reviewed; tracked git tree clean. |
| **1. Correctness sprint (1–2 weeks)** | Verse-bank parity + CI check; remove/fix share target and file handler; theme toggle fix; single notification list; marquee Firestore listener. | `npm run verify:all` passes; a test proves site/widget/push verse equality; no dead declarations. |
| **2. Security & infrastructure (1–2 weeks)** | Custom claims; rules hardening with emulator tests; central Firebase config; CSP tightening; Brevo/R2/TURN configuration checklist; budgets/alerts. | `npm run test:rules` passes; admin/finance roles survive sign-out and revocation; no secret in source. |
| **3. Android & notification verification (1–2 weeks)** | Build APK/AAB in CI; install on Android 16 QPR1+ phone and Android 15 QPR1+ tablet; verify widget placement, alarms, pinning, reboot, lock-screen rendering, notification icon/channel/sound/click, App Links. | Device test log; screenshots; assetlinks fingerprint matches Play signing key. |
| **4. Hero redesign (1 week)** | Full-bleed hero CSS/markup changes, managed banner alignment, responsive/reduced-motion review, new screenshot. | Visual review at 360/768/1440px; CTAs, scripture, typing animation and install banner still work. |
| **5. Flow verification (1–2 weeks)** | Real test transactions for giving/support; real live broadcast with TURN; radio automation and presenter takeover; email delivery with verified domain. | Written test evidence for each flow; failures fixed or documented. |
| **6. Performance & accessibility (ongoing)** | Precache reduction, lazy 3D, image/font optimisation, axe/Lighthouse pass, Firestore query profiling. | Lighthouse/axe targets agreed; no regression in offline shell. |
| **7. Optional enhancements** | Global search, recorded audio Bible, branded notification sound, richer share-target experience. | Prioritised separately after phases 1–6. |

**Guiding principle for the next phase:** preserve the existing architecture (static pages + Firebase + Vercel functions + Capacitor widget) and change only where evidence shows a real defect or a genuinely necessary platform limitation. The largest wins are parity, declared-capability cleanup, device verification, and the hero CSS conflict — not a rewrite.

---

## Appendix — key files of record

| Area | Files |
| --- | --- |
| Shell | `assets/pd-app.js`, `assets/pd-nav.js`, `assets/pd-brand.css`, `assets/pd-responsive-fix.css`, `assets/pd-motion.js`, `assets/pd-icons.js` |
| Homepage | `index.html`, `assets/pd-content-data.js`, `devotional-data.js`, `assets/pd-daily-challenge.js` |
| Bible/verse | `bible.html`, `api/bible.js`, `assets/bible/bsb/`, `assets/pd-verse-data.js`, `functions/verse-bank.js`, `scripts/build-widget-verses.mjs`, `assets/pd-verse-alerts.js` |
| PWA | `manifest.json`, `sw.js`, `firebase-messaging-sw.js`, `offline.html`, `assets/pd-widget.js`, `widgets.html` |
| Android | `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/java/net/prayerdome/app/*.java`, `android/app/src/main/res/`, `capacitor.config.json`, `scripts/prepare-mobile.mjs`, `.well-known/assetlinks.json` |
| Backend | `api/*.js`, `functions/*.js`, `lib/billing-server.js`, `firestore.rules`, `storage.rules`, `firestore.indexes.json` |
| Deployment | `vercel.json`, `firebase.json`, `scripts/build-vercel.mjs`, `codemagic.yaml`, `mobile/android-build.yml`, `.vercelignore` |
| Tests | `tests/*.test.js`, `tests/rules/firestore.test.js`, `package.json` scripts |
| Documentation reviewed | `README.md`, `DEPLOYMENT.md`, `DEVELOPMENT.md`, `GIVING_WITHOUT_CLOUD_FUNCTIONS.md`, `docs/BIBLE-LICENSING.md`, `docs/RADIO-24-7.md`, `docs/FINAL-REPORT.md`, `docs/QA-REPORT.md`, `mobile/ANDROID-WIDGET.md` |
