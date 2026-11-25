# Prayer Dome — PWA, Android identity and transactional email

**Project:** Prayer Dome (https://prayerdome.net)
**Branch:** `arena/e95077f2-prayer-dome`, branched from `ba6aa470f2b9596e3c09ddff70050c7045707e6b` on `main`
**Date:** 22 November 2026
**Scope:** the standalone-home-screen requirement, the Android identity requirement, and the Brevo/email requirement. This report replaces the earlier navigation/Domey deliverable report in this file.

---

## 1. Outcome in one page

| Requirement | Outcome | Evidence |
| --- | --- | --- |
| Home-screen app must not show a browser address bar, Share control or three-dot menu | The manifest now declares `display: standalone`, `display_override: ["standalone"]`, a stable `id` of `/`, `start_url` `/?source=pwa`, scope `/` and `launch_handler.client_mode: "navigate-existing"`. The app shell treats only a genuine `standalone`/`fullscreen`/native launch as installed; `minimal-ui` is explicitly **not** accepted as installed. No CSS hides browser controls. | `manifest.json`, `assets/pd-app.js`, `sw.js` (cache `prayer-dome-v53`), `tests/pwa.test.js` (85 assertions) |
| Keep the Android status bar, Prayer Dome header/logo/menu/bell | `display` is standalone, not fullscreen; the status bar remains. The existing top bar, logo, menu button and bell are unchanged; safe-area padding is applied in app mode. | `manifest.json`, `assets/pd-app.js`, `tests/layout.test.js`, `tests/pwa.test.js` |
| Preserve Google Play SHA-1/SHA-256 fingerprints and application ID | No fingerprint or package name was removed or altered. `.well-known/assetlinks.json` still carries `net.prayerdome.app` with SHA-256 `43:70:D7:…:5C:70` and the legacy `co.median.android.qdoxnjx` statement. The three SHA-1 values and the two unpublished SHA-256 values remain recorded in `mobile/ANDROID-IDENTITY.md`. | `tests/assetlinks.test.js` (46 assertions), `tests/play-signing.test.js`, `npm run assetlinks:check` |
| Fix “Email delivery is temporarily unavailable…” without new Google Cloud billing | Root cause fixed: the client collapsed many provider errors into one sentence and the server collapsed all Brevo failures into one `unavailable` error. Brevo failures are now classified (`not_configured`, `auth_failed`, `rate_limited`, `sender_not_verified`, `recipient_rejected`, `invalid_request`, `provider_error`, `unreachable`), and the administrator can see the exact cause and provider response. Brevo is the mail provider; no new paid Google API was added. | `functions/brevo.js`, `functions/notifications.js`, `assets/pd-email-admin.js`, `tests/brevo.test.js` (14), `tests/email.test.js` (17) |
| Six-digit emailed verification code | Server-generated six digits; scrypt hash + salt only; ten-minute expiry; 60-second resend cooldown; five sends per hour; five failed attempts; one-time use enforced in a transaction; server-only verification; code never returned to the browser and never written to a log; record is stored before the message is sent; expired records cleaned hourly. | `functions/index.js`, `functions/notifications.js`, Firestore rules, `tests/email.test.js`, `tests/support.test.js`, `tests/verification-flow.test.js` |
| Automatic branded template for every listed event | One renderer (`functions/email-design.js`) with the real Prayer Dome identity; 46 event templates; the 13 requested account/giving/prayer/announcement/newsletter events are present and render without placeholders. | `functions/email-design.js`, `functions/notifications.js`, `tests/email.test.js` |
| One central server-side email service | Account, security, membership, payment, giving, prayer, certificate and announcement mail goes through `functions/notifications.js` → `functions/brevo.js` → `emailOutbox`. The browser never holds the Brevo key and never sends mail directly. | `functions/notifications.js`, `functions/brevo.js`, `functions/index.js`, `tests/email.test.js` |
| Admin email monitoring | Admin → Email Delivery shows event/type, recipient, created time, request status, provider status, failure reason, attempts, next retry and a retry action; a connection check shows the provider account, sender verification and the exact failure code. An accepted message is never labelled delivered. | `admin.html`, `assets/pd-email-admin.js`, `functions/notifications.js`, `tests/email.test.js` |
| Tests | `npm test` exits 0; `npm run lint` exits 0; `npm run functions:verify` exits 0; `npm run build:vercel` produces 223 files / 27.22 MiB. | section 8 |

**Not verified here:** production deployment, a real Play-signed APK, a physical Android launch, Gmail/Outlook rendering, and the Play App Signing certificate. See section 9.

---

## 2. Standalone PWA behaviour

### What was changed

`manifest.json` is the authority:

```json
"id": "/",
"start_url": "/?source=pwa",
"scope": "/",
"display": "standalone",
"display_override": ["standalone"],
"launch_handler": { "client_mode": "navigate-existing" }
```

* The `id` is stable at `/`. An app previously installed from `/` keeps its identity after the `start_url` gains `?source=pwa`.
* `display_override` removes a browser’s ability to fall back to `minimal-ui` while still keeping the Android status bar (no `fullscreen`).
* `launch_handler` reuses an open app window instead of stacking a second copy.
* The existing 192/512 any and maskable icons, theme colour `#104F91`, shortcuts, share target and file handlers are retained.
* `sw.js` moved to `prayer-dome-v53` so a returning installed app retires the old shell and loads the corrected launch/app assets.
* `assets/pd-app.js` now treats **only** `standalone`, `fullscreen` or the native Capacitor app as installed. `minimal-ui` still has browser controls, so it must never mark the app “installed” or hide the install invitation.
* The install banner, app-mode spacing, safe-area padding, splash and offline shell are unchanged except for that correctness fix.

### What the platform controls

A browser tab always shows browser controls. A home-screen PWA shows no address bar, Share control or three-dot menu **only when the icon was installed as a WebAPK/standalone app**, not when the site is merely opened in Chrome and added as a bookmark. The app cannot and does not hide Chrome’s controls with CSS. If an old Chrome-installed copy still shows the bar, uninstall that copy and install again from the site; the stable `id` preserves the app identity but Android still records the installing browser for a WebAPK. The Play/Capacitor build (`net.prayerdome.app`) has its own WebView and no browser chrome.

---

## 3. Android identity and signing

Nothing about the application identity was changed.

| Item | Published / recorded value |
| --- | --- |
| Application ID | `net.prayerdome.app` (Gradle, Capacitor and assetlinks agree) |
| Published SHA-256 | `43:70:D7:09:23:4E:F0:0B:A5:E0:88:1E:24:23:C6:1D:BB:76:48:F0:FB:31:1E:00:1F:D2:7B:D2:5A:B9:5C:70` |
| Legacy package kept | `co.median.android.qdoxnjx` with SHA-256 `40:9D:FC:…:46:70:E8` |
| Recorded SHA-1 values | `80:6D:53:…:F4:2B:0E`, `A6:71:0E:…:39:27:CA`, `B9:DB:A4:…:8E:DB:53` — recorded in `mobile/ANDROID-IDENTITY.md`; SHA-1 is not valid inside `assetlinks.json` |
| Other supplied SHA-256 | `8E:FE:79:…:AE:67:D5` and `29:82:29:…:1D:83:0B:CA` — recorded but deliberately **not** published because they were supplied without a package and publishing one would grant link-handling permission |

**Important Play caveat:** if Play App Signing is enabled, the certificate Android compares is Google’s **app signing key**, not the upload key whose SHA-256 is published. Play Console → App integrity → App signing key certificate must be checked; if it differs, add its SHA-256 to the `net.prayerdome.app` statement and deploy the file. This report does not invent that value.

The assetlinks file is still served as JSON with no redirect by both `vercel.json` and `firebase.json`. `npm run assetlinks:check` passes.

---

## 4. Why the email error happened, and what changed

Two independent collapses produced the sentence users saw:

1. **Client collapse.** The account page mapped `/not found|unavailable|internal/i` to one generic message, so a missing function, an unverified sender, a bad key and a provider outage all looked identical.
2. **Server collapse.** The old Brevo helper turned every non-success into `unavailable`. The administrator could not tell whether the key was wrong, the sender was unverified or Brevo was rate-limiting.

The fix:

* `functions/brevo.js` now has `providerFailure()` with stable codes:
  `not_configured`, `auth_failed` (401/403), `rate_limited` (429), `sender_not_verified` (400/422 sender/domain wording), `recipient_rejected`, `invalid_request`, `provider_error` (5xx), `unreachable` (network/timeout).
* `checkConnection(env)` performs `GET /account` and `GET /senders`, returns `{configured, ok, code, status, companyName, senderEmail, senderName, senderVerified, message}` and **never returns the API key**.
* `getEmailStatus(messageId, …)` asks Brevo for the actual delivery/bounce state of an accepted message.
* The registration-code callable maps the provider code to a specific, professional sentence (bad credentials, unverified sender, rate limit, temporary provider outage).
* The admin page has a **Check connection** action that shows the exact reason code and HTTP status, the Brevo account name, sender/reply-to and whether the sender is in Brevo’s verified list.
* The account page no longer reduces all callable errors to the same sentence; it shows the server’s cause-specific message and keeps the cooldown/retry details.

**No new Google Cloud billing was introduced.** Mail is sent by Brevo. The existing Firebase Functions/Secret Manager deployment and a Brevo account are used. Brevo’s own plan limits remain the only mail quota.

### Brevo environment contract

Required: `BREVO_API_KEY`.
Optional: `BREVO_SENDER_EMAIL` (default `noreply@prayerdome.net`), `BREVO_SENDER_NAME`, `BREVO_REPLY_TO`, `BREVO_LIST_ID`, `BREVO_DOI_TEMPLATE_ID`, `PD_SITE_URL`.
The key is read server-side only. It is never entered in the admin page and never returned by a callable.

### Deliverability is a provider/domain step

Brevo must have the sender or the `prayerdome.net` domain verified. For Gmail/Outlook inbox placement, the domain should have SPF, DKIM and DMARC records configured in Brevo and DNS. Those records are outside this repository; the admin connection check reports an unverified sender.

---

## 5. Six-digit verification codes

The registration flow is server-authoritative:

1. `sendRegistrationVerificationCode`, authenticated, generates `crypto.randomInt(100000, 1000000)`.
2. Only a **salted scrypt hash** is stored in `registrationVerification/{uid}`. A legacy SHA-256 verifier remains only for records created before the change, which expire within ten minutes.
3. The record is written **before** Brevo is called. If storage fails, nothing is sent. If delivery fails, the record is deleted so no unusable code remains.
4. The email is the fixed branded code template; the code never appears in the outbox, the function logs or the callable response.
5. `verifyRegistrationCode` validates inside a Firestore transaction: same email, not consumed, not expired, fewer than five failed attempts, then a constant-time comparison.
6. A correct code is consumed in the same transaction, then Firebase Auth is marked `emailVerified: true` and the Firestore profile is updated. If the Auth update fails, the code is un-consumed so the user is not stranded.
7. `cleanupRegistrationVerification` deletes expired records hourly.
8. Firestore rules deny all client access to `registrationVerification`. Public reads are limited to a member’s own bell entries; the delivery log is administrator-only.

Limits: **10-minute expiry, 60-second resend cooldown, five sends per rolling hour, five failed attempts, one use**. The account page shows the countdown and the server’s exact “wait N seconds”/“request a new code” messages. The old link-based verification callable was removed; the badge/re-send path now uses the same six-digit service.

---

## 6. Branded template system

`functions/email-design.js` is the single renderer. Its identity is the real site identity:

| Token | Value |
| --- | --- |
| Name / legal name | Prayer Dome / Prayer Dome Ministry |
| Tagline | A House of Prayer for All Nations |
| Logo | `https://prayerdome.net/assets/logo.png` |
| Blue / deep navy | `#0A4D9B` / `#07244D` |
| Gold / soft gold | `#D4AF37` / `#F6DF8A` |
| Surface / border / ink / muted | `#F3F6FB` / `#DBE3EE` / `#172033` / `#5B6B82` |
| Type | Poppins headings, Inter/Segoe UI body |
| Contact / phone / address | `info@prayerdome.net`, `+260 973 028 342`, Manzini, Eswatini |

Every message has: a branded header, preheader, responsive body, optional details table, optional single CTA, a plain-text alternative, a visible fallback URL and a footer explaining why the member received it. CTA URLs are restricted to `prayerdome.net`, `www.prayerdome.net` or `prayer-dome.firebaseapp.com`; anything else falls back to a safe account URL. Member-supplied values are HTML-escaped. The code block is rendered only for exactly six digits.

The requested events are present:

`email_verification`, `welcome`, `password_reset`, `password_changed`, `new_login`, `account_security_alert`, `giving_submitted`, `giving_confirmed`, `giving_rejected`, `prayer_request_confirmation`, `prayer_request_update`, `ministry_announcement`, `newsletter_welcome`.

The complete `EVENTS` registry contains **46** templates, including membership, church ID, payment/subscription, withdrawal, certificate, testimony and support-claim messages. The test suite renders every event and fails on an unresolved `{{placeholder}}`, an empty button or a missing text alternative.

Security-critical content is fixed on the server: the verification code and the one-time password-reset link cannot be altered into an unsafe destination. Administrators may customise subject, heading, message, button label and path for ordinary events.

### Automatic event wiring

| Trigger | Event |
| --- | --- |
| Email/password verification succeeds | `welcome` |
| Google account profile is created with a verified email | `welcome` (same deterministic id, so no duplicate) |
| Password reset requested | `password_reset` (link never stored) |
| Password changed from the account page | `password_changed` |
| New browser/device sign-in | `new_login` |
| Giving record created | `giving_submitted` |
| Giving status becomes `received` | `giving_confirmed` (only a real receipt, not `approved`) |
| Giving status becomes `rejected` | `giving_rejected` |
| Prayer request created | `prayer_request_confirmation` |
| Prayer status changes | `prayer_request_update` |
| Announcement created with `emailMembers: true` | `ministry_announcement` |
| Newsletter consent accepted | `newsletter_welcome` (newsletter intake path; see limitation in section 9) |

Guest giving records use the same branded giving templates when the record carries an email address, even though there is no member account to resolve. The old `prayer_received` template is retained only for already-queued legacy rows; new prayer confirmations use `prayer_request_confirmation`.

---

## 7. One central service and admin monitoring

### Flow

```
Firestore change / callable
        │
        ▼
functions/notifications.js
  resolveRecipient / preference checks / template
        │
        ▼
emailOutbox/{deterministic event id}   ← duplicate protection
        │
        ▼
functions/brevo.js  →  Brevo /smtp/email
        │
        ▼
provider message id → later provider status refresh
```

* The browser never sends email directly and never supplies the recipient address; the server resolves the account.
* Outbox ids are deterministic per event, so a trigger retry, a refresh or a double tap cannot send the same message twice.
* `userNotifications` bell entries are written in the same transaction as the outbox row.
* `emailOutbox` is readable only by administrators; clients can never create or alter a row.
* Password-reset and verification rows are `retryable: false`; a retry can never resend a secret the server no longer knows.
* The retry job runs every 30 minutes, maximum five attempts, exponential `nextAttemptAt`. It re-checks the admin email switch and the member’s category preference before every retry, so a message queued before an opt-out is not sent.
* `refreshProviderStatuses` queries Brevo for accepted messages and records `delivered`, `bounced`, `failed` or `deferred` only when Brevo reports it.

### Status vocabulary

`pending` → `sending` → `accepted` (Brevo received it) → `delivered` / `bounced` / `failed` / `deferred` (provider report).
Also: `disabled`, `opted_out`, `missing_email`.
The UI shows **“Accepted by Brevo”** and **“Delivered (provider)”** as separate states. Accepted is never called delivered.

### Admin view

`admin.html` → Email Delivery:

* Sender/reply-to and the verified-sender warning.
* Per-category switches plus the master email switch.
* Delivery test that says “Brevo accepted” and directs the admin to refresh the provider report.
* Template editor with placeholders.
* Delivery log with created time, event/subject, recipient/name, status, provider response, failure reason, attempts/next retry and a Retry button.
* Connection check with cause code, HTTP status, company name, sender verification and message counts.
* “Refresh provider status” for the provider’s report.

`functions/index.js` exposes `emailAdmin` plus the triggers; `api/system.js` remains within the 12-function Vercel limit and only owns health/newsletter. No new `api/*.js` was added.

---

## 8. Verification evidence

All commands were run in this checkout on the current branch. “Exit 0” means the command completed successfully.

| Command | Result |
| --- | --- |
| `node tests/email.test.js` | 17 tests, 0 failed, exit 0 |
| `node tests/brevo.test.js` | 14 tests, exit 0 |
| `node tests/notifications.test.js` | 27 event/content checks, exit 0 |
| `node tests/pwa.test.js` | 85 assertions, exit 0 |
| `node tests/support.test.js` | 16 tests, exit 0 |
| `node tests/layout.test.js` | 43 pages, 42 static tables, exit 0 |
| `node tests/admin.test.js` | exit 0 |
| `node tests/icons.test.js` | 42 passed, exit 0 |
| `npm test` | full suite, exit 0 (≈105.8 s) |
| `npm run lint` | exit 0: icons 286, nav 42 pages, 154 JS files/42 HTML pages, SEO 32 up to date, widget verses 48, assetlinks valid |
| `npm run functions:verify` | exit 0: “Functions module loads successfully.” |
| `npm run build:vercel` | 223 files, 27.22 MiB, exit 0 |
| `node scripts/assetlinks.mjs` | exit 0; both statements valid |
| `npm run test:rules` | **not run here** — requires Java 21 |

The email tests specifically pin:

* the real brand identity and the logo/contact footer;
* responsive HTML plus a plain-text alternative;
* no unresolved placeholders in any event;
* HTML escaping of member text;
* CTA destination allow-listing;
* the six-digit code present in the mail but absent from metadata;
* Brevo’s `auth_failed` being named as an authentication failure, not an outage;
* `senderVerified` read from Brevo’s `/senders` response;
* the admin console never calling an accepted message delivered;
* the code being stored before it is emailed and hashed with scrypt;
* the guest-giving, Google-welcome and password-change paths sharing the service;
* guest giving and password-change wiring.

`npm test` output includes the full existing suite (navigation, pages, billing, giving, Android, SEO, etc.); all of it exits 0.

---

## 9. Deployment and what still needs your action

Nothing was deployed from this environment. The repository passes locally, but these steps are required in the live project:

1. **Deploy Firestore rules** (the new collections are server-only):
   ```sh
   firebase deploy --only firestore:rules --project prayer-dome
   ```
2. **Deploy the functions** (emailAdmin, registration code, triggers, retry job):
   ```sh
   firebase deploy --only functions --project prayer-dome
   ```
   Confirm `BREVO_API_KEY` is set as a secret for the functions. If the CLI asks for a secret, use the current Brevo v3 key; do not put it in source or the browser.
3. **Redeploy the Vercel app** so `api/*` and `vercel.json`’s `includeFiles` include `functions/brevo.js` and `functions/email-design.js`. Set `BREVO_API_KEY` in Vercel for `/api/newsletter`.
4. **Verify the Brevo sender/domain.** In Brevo, authenticate `prayerdome.net` and confirm `noreply@prayerdome.net` is an active sender. Add SPF/DKIM/DMARC DNS records for reliable Gmail/Outlook delivery. Then use Admin → Email Delivery → **Check connection** and **Send test email**.
5. **Play App Signing.** If Play App Signing is enabled, copy the **app signing key** SHA-256 from Play Console → App integrity into the `net.prayerdome.app` statement, run `npm run assetlinks:check`, and deploy the updated `.well-known/assetlinks.json`. The current file preserves the supplied upload key and the legacy Median key; it cannot guess Google’s key.
6. **Install the app fresh on Android.** Uninstall any old Chrome-installed copy, open `https://prayerdome.net/` in Chrome, choose **Install app**, and launch from the home screen. Confirm `display-mode: standalone`, the status bar remains, and there is no address bar, Share control or three-dot menu. A browser tab will always show browser controls; that is platform behaviour, not a CSS bug.
7. **Rebuild the native Android package** if you ship Play/Capacitor rather than the PWA. `capacitor.config.json` still points at `webDir: mobile/www`, which is not present in this checkout; this repository does not produce an APK/AAB here. The application ID and fingerprints were not changed.
8. **Run the Firestore rules tests** on a machine with Java 21: `npm run test:rules`.

### Limitations and honest exceptions

* **No production verification.** No Vercel deployment, Firebase functions deployment, Play upload or physical-device launch was performed here. The live site `/api/health` was previously reachable, but these new functions are not deployed by this work.
* **No real mail was sent.** Brevo tests use a stubbed `fetch`. The connection check and delivery status depend on the real key and sender being configured; those are deploy-time actions.
* **Email-client rendering is not visually verified** in Gmail, Outlook or Apple Mail. The HTML is table-based, inline-styled and tested structurally.
* **Newsletter welcome exception.** The Vercel newsletter intake sends its welcome through Brevo using the shared design renderer, but it has no Firebase Admin context on Vercel and therefore does not write an `emailOutbox` row. All account, security, membership, payment, giving, prayer, certificate and announcement mail does. If you require the newsletter welcome in the same admin log, the intake must move to the Firebase-hosted `brevoSubscribe` function or Vercel must be given a server credential; that is a deployment decision, not hidden here.
* **`prayer_received` legacy template** remains in the registry for already-queued rows; new prayer confirmations use `prayer_request_confirmation`.
* **Old browser copies** cannot be forced to drop browser chrome by a server change. A fresh install is required, and a WebAPK will still be recorded as installed by Chrome.
* **No new billing** was introduced, but the existing Firebase project must already allow Cloud Functions/Secret Manager. Brevo’s free-plan limits apply.

---

## Files of record

| Path | Purpose |
| --- | --- |
| `manifest.json` | Stable `id`, scoped `start_url`, standalone `display_override`, launch handler |
| `sw.js` | Cache `prayer-dome-v53`, offline shell, FCM, network-only admin |
| `assets/pd-app.js` | Install/app-mode detection; `minimal-ui` is not installed; safe-area shell |
| `functions/email-design.js` | One branded renderer for every message |
| `functions/notifications.js` | Event registry, templates, outbox, retries, provider refresh, admin callable, triggers |
| `functions/brevo.js` | Brevo transport, failure classification, connection check, provider status, newsletter intake |
| `functions/index.js` | Registration-code service, password reset, new-login/password-change callables, welcome trigger |
| `assets/pd-email-admin.js`, `admin.html` | Admin email monitoring and settings |
| `account.html` | Code entry, resend cooldown, password change, verification badge |
| `tests/email.test.js`, `tests/pwa.test.js`, `tests/brevo.test.js`, `tests/support.test.js` | New coverage |
| `.well-known/assetlinks.json`, `mobile/ANDROID-IDENTITY.md`, `tests/assetlinks.test.js` | Unchanged identity and signed-link record |
