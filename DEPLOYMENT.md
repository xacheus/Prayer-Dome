# Deployment checklist

## Status

The public bundle and application checks pass locally. This is **not a sign-off
for unrestricted production use**: the live/community security review and
external-service checks below remain launch gates. No production deployment,
credentials, database contents, or project settings were changed.

## Reproducible checks

Use Node.js 22 and Python 3:

```sh
npm ci                        # also npm ci in functions/
npm run verify:all            # lint, application + packaging + HTTP tests, Functions load
npm run build                # allowlisted public files in dist/
npm audit --audit-level=moderate
npm --prefix functions audit --audit-level=moderate
npm run test:rules            # needs Java 21; downloads pinned Firebase CLI/emulator
npm run dev                  # public bundle + local APIs on port 8000
```

`test:rules` targets only `demo-prayer-dome`, never the production database.
Its authorization tests were added but could not be executed in the preparation
environment: Java was unavailable and binary download attempts were blocked.
Run them successfully before deploying rules. The other commands above were
validated locally, including HTTP responses and private-file isolation.

The verification workflow is staged in `ci/verify.yml`, including emulator and
dependency checks. As described in DEVELOPMENT.md, a maintainer must activate it
with `node scripts/install-workflows.mjs` if `.github/workflows/` is absent.
Require a passing Verify check before merging into the production branch.

The same verification and Android builds also run on Codemagic: `codemagic.yaml`
defines `web-verify`, `android-debug` (debug APK plus release outputs on every
push) and `android-release` (signed APK/AAB from a `v*` tag). The secure
variables and the one-time application setup are documented in
**[mobile/CODEMAGIC.md](mobile/CODEMAGIC.md)**; `tests/codemagic.test.js` keeps
that configuration valid on every `npm test` run. Play accepts a bundle only
when it carries the upload key certificate registered for the app: set
`PLAY_UPLOAD_KEY_SHA1` so a wrong-key bundle fails the release instead of the
upload, and follow **[mobile/PLAY-UPLOAD-KEY.md](mobile/PLAY-UPLOAD-KEY.md)**
when Play reports "signed with the wrong key".

## Vercel website

1. Import this repository using the existing `vercel.json` (Other framework,
   Node 22, build `node scripts/build-vercel.mjs`, output `dist`). Do not publish
   the repository root as a static directory.
2. The upload filter includes the shared API handlers, `lib/billing-server.js`,
   `functions/billing.js`, its catalogue and the lockfile. Keep
   `functions/translate.js`, `functions/share.js` and `functions/brevo.js` in
   serverless uploads. Vercel runs `npm ci --ignore-scripts` so the serverless
   billing gateway has the pinned `firebase-admin` dependency but does not run
   the legacy Cloud Functions installer.
   The Hobby plan allows at most **12 Serverless Functions per deployment**, so
   `/api/health`, `/api/newsletter`, `/api/billing` and `/api/payment-webhook`
   are all rewritten to `api/system.js` rather than shipped as separate files.
   `tests/vercel.test.js` fails if a thirteenth function is added; consolidate
   an endpoint instead of upgrading the plan.
3. Automatic deployments are intentionally enabled only for `main`; this work
   stays on the session branch. Use a manual preview deployment or review/merge
   before a production deployment. The local preview is not a Vercel deployment.
4. Check `/api/health`, `/api/news`, `/api/radio`, `/lessons`, the language picker,
   an unknown URL, and sharing previews on the deployed host. `/package.json`,
   `/firestore.rules`, and `/functions/index.js` must not be publicly served.
5. Vercel does **not** deploy Firebase Functions or Firestore rules.

## Firebase

Use an explicitly selected project; do not guess a project from the browser's
public Firebase config:

```sh
firebase deploy --only firestore:rules --project <project-id>
# Non-payment functions (notifications, verification, mail) only:
firebase deploy --only functions --project <project-id>
# Alternative to Vercel hosting, not an additional required step:
firebase deploy --only hosting --project <project-id>
```

**Payments never require a Cloud Functions deployment.** A closed Google Cloud
billing account does not block Firebase Authentication, Firestore rules or the
Vercel billing API described below. Do not re-enable Cloud Billing for payments.

Firebase Hosting now builds and publishes `dist/`, not repository sources.
The Firestore rules target is explicitly configured. Firebase Hosting does not
implement every Vercel-only `/api/*` handler; Vercel remains the recommended
website target. Confirm feature parity before switching hosting providers.

### Giving and donations (no Cloud Functions, no Cloud billing)

Giving is a Firestore-only path and does **not** require Cloud Functions or an
enabled Google Cloud billing account:

* `give.html` reads `settings/payments` directly (public read) and creates
  `offerings/{reference}` with `status: 'pending'`.
* The member support page has a **Give** tab that writes the same collection.
* Receipts are uploaded through the shared Cloudinary service to `givingEvidence` with an unguessable public id; only the https link is stored on the record.
* `admin.html` → **Giving & Donations** reviews, approves, rejects and marks
  gifts received. Only `received` rows count towards confirmed contributions.
* `settings/payments` and `givingAudit` are administrator-writable only.

Deploy the rules and indexes for this path:

```sh
firebase deploy --only firestore:rules --project <project-id>
```

Then sign in as an administrator, open **Payment Verification → Payment
methods**, add the church's real Airtel/MTN/bank/hosted-checkout details and
save. The save writes Firestore directly. Never put a number or bank account in
the repository; if no method is configured the give page deliberately shows a
contact notice instead of invented details.

For a provider-hosted card checkout, set the method's **Hosted checkout URL**
(a secure `https://` link from an approved provider). The donor pays on the
provider page and returns with the provider's transaction reference; the gift
still starts pending until Finance checks it. Automatic provider webhooks are
not required for this manual-safe flow. If automatic verification is added
later, terminate the webhook on Vercel (`api/system.js?op=…`) or another
non-GCP-billing host, verify the provider signature and write the status with a
server credential — never trust a browser claim.

## Prayer Dome Radio

Radio Studio is the administrator surface for the gospel library, recorded
human presenter voices, playlists, the Lusaka timetable and presenter access.
Deploy all three pieces together; a website newer than the rules can show
controls that the server correctly refuses:

```sh
firebase deploy --only firestore:rules --project <project-id>
firebase deploy --only functions --project <project-id>
```

Radio audio uploads to the ministry Cloudinary media library under `radioAudio/` (optionally to Cloudflare R2 for broadcast) and is limited to audio content types and files under 50 MB. Presenter requests, sessions and the
public LIVE state are written only by the Admin SDK callables; browsers cannot
approve themselves. `radioSessionWatchdog` uses the same Firebase
Functions/Cloud Scheduler setup as the existing reminder and email jobs. It does
not add a streaming server, TURN service or new paid vendor. See
`docs/RADIO-REPORT.md` for verification status and the costs that still need
approval (a server-side 24/7 stream and TURN/SFU for larger live audiences
would be recurring costs).

### Deposits, support, giving and withdrawals (Vercel, no Cloud Functions)

All member money actions now use the same-origin Vercel route
`POST /api/billing`. `support.html` and `admin.html` send the signed-in user's
Firebase ID token; `lib/billing-server.js` verifies it, then calls the shared
transaction logic in `functions/billing.js`. That module is plain Node code —
it does **not** import `firebase-functions` and no `billing` callable or
scheduled Cloud job is deployed. Firebase Admin SDK 13.x is the only server
dependency; Firestore and Firebase Authentication continue on the existing
project without a paid billing account.

Required Vercel environment variables (server-side only, never committed):

```sh
# Full Firebase service-account JSON, supplied as a single-line string.
vercel env add FIREBASE_SERVICE_ACCOUNT_JSON production
# Optional: only for automatic provider-confirmed hosted checkouts.
vercel env add PAYMENT_WEBHOOK_SECRET production
```

The service account needs Firestore Data Reader/Writer on the existing database
and nothing more. Firebase Admin verifies ID tokens and signs private receipt
URLs with that identity. `GOOGLE_APPLICATION_CREDENTIALS` is supported as an
alternative for runtimes that already have Application Default Credentials.
Without credentials the API returns a safe `failed-precondition` message and
records the technical cause in the Vercel logs; it never falls back to a client
write or a fake success.

`PAYMENT_WEBHOOK_SECRET` is a shared HMAC-SHA256 secret you obtain from your
existing payment provider. Configure the provider to POST JSON to
`https://prayerdome.net/api/payment-webhook` with the signature in
`x-pd-signature` (hex or base64, with an optional `sha256=` prefix). The gateway
verifies the signature with `crypto.timingSafeEqual` before an event can touch a
payment. If the secret is absent, webhooks fail closed and gifts stay pending
for manual Finance verification. No provider credentials are invented in this
repository.

Supported confirmation paths:

* **Mobile Money / bank transfer / office / WhatsApp** — the member submits a
  reference and private receipt; Finance checks the ministry account and
  explicitly approves. No screenshot alone confirms a payment.
* **Hosted checkout** — the provider's signature-verified webhook may confirm a
  matching open payment. Amount, currency, reference and event id must match;
  a replayed event cannot credit a balance twice.
* **Giving and church support** — `offerings/{reference}` is created as
  `pending` directly in Firestore, then Finance reviews and marks it received.
  Those gifts are never added to a withdrawable wallet balance.

Withdrawals reserve the amount in `wallets/{uid}.heldBalance`, appear in
**Admin → Withdrawals**, and move from `pending` → `under review` → approved /
`processing` → `paid` only after Finance records the real payout reference.
Rejecting or cancelling releases the hold; only the administrator action that
confirms a completed payout deducts the verified balance. Every state change
writes a `walletTransactions` row and a `billingAudit` entry.

Errors from `/api/billing` are JSON with a stable `code` and a short safe
`message`; full technical detail is logged on the server. The pages show the
server's explanation where it is safe (for example a missing payment method or
an exhausted balance) and a retry notice for transient failures. Check
`https://prayerdome.net/api/health` after deploying, then sign in on
`/support.html` and open the wallet tab: a `plans.list` request must succeed
before any money is sent.

The functions package is pinned to `firebase-admin` 13.x. Version 14 removed the
namespaced `admin.firestore()` / `admin.storage()` API used throughout these
files, so upgrading it turns every billing action into an opaque failure. Run
`npm run functions:verify` after changing dependencies; it fails fast if the
namespace API is missing.

### Bible reader (API.Bible)

NIV and The Message (MSG) are read from API.Bible through `/api/bible`. The
server-side API.Bible key is **required**; a `MSG_BIBLE_ID` by itself is not
sufficient to authorize requests. Add the key in Vercel → Settings → Environment
Variables (or with `vercel env add`) and never put it in a committed file:

```sh
vercel env add BIBLE_API_KEY production   # your API.Bible key (required)
```

**The key does not have to cost anything.** API.Bible's free Starter plan is
$0/month and includes up to three licensed Bibles (plus every open-access one),
5,000 API calls a month, for non-commercial use. The Message is one of the
choices, so MSG can be read on the free plan. The steps, printed by the setup
guide and returned by `GET /api/bible?action=setup&version=MSG`:

1. Create a free account at <https://api.bible/sign-up>. No card is asked for.
2. In the dashboard (<https://api.bible/dashboard>), add **The Message** (and
   **New International Version**) to the account. Starter allows three licensed
   Bibles; if all three slots are taken, remove one and add the edition you want.
3. Copy the account API key.
4. Add it to Vercel as `BIBLE_API_KEY` (above) and redeploy.
5. Check it: `GET /api/bible?action=status&version=MSG` should say
   `"configured": true`.

With no key, `npm run bible:setup` prints the same steps without needing one.
Readers never see these instructions — the reader shows a plain note that the
translation is not switched on yet plus a collapsed "site owner?" section, and
no text from any other translation is shown in its place.

Add the key to every Vercel environment you use (Production, Preview, and/or
Development). Vercel environment changes apply to new deployments, so redeploy
after saving the key. The Bible IDs are optional, non-secret overrides; without
one, the server resolves each translation from the API.Bible account's Bible
list. To pin an exact ID instead of using that account list:

```sh
vercel env add NIV_BIBLE_ID production    # e.g. 78a9f6124f344018-01
vercel env add MSG_BIBLE_ID production    # the ID from your account
```

Check the IDs the account is entitled to before deploying (run locally, the key
is read from the environment and never printed):

```sh
BIBLE_API_KEY=<your key> npm run bible:ids -- --verify
```

After deploying, `GET /api/bible?action=bibles` reports the resolved IDs and
`GET /api/bible?action=status&version=NIV` reports the provider and the ID
source. If an edition is missing from the account, the reader shows a
"setup required" note — with the free Starter-plan steps attached in
`GET /api/bible?action=setup&version=NIV|MSG` — and no text from any other
translation.

### Brevo email (verification + updates)

Brevo delivers two kinds of mail; both are optional and both fail safely.

1. **Account verification.** `sendRegistrationVerificationCode` generates a
   six-digit code on the server, stores only its salted scrypt hash, and asks
   Brevo to deliver it from the ministry's authenticated sender. The code
   expires after ten minutes, resends are throttled, and only
   `verifyRegistrationCode` can mark the account verified. The code is never
   returned to the browser or written to a log.
2. **Support-page updates.** The support page form posts one consenting address
   to `POST /api/newsletter` (Vercel) or the `brevoSubscribe` function (Firebase
   Hosting). With a list and double opt-in template configured, Brevo sends the
   confirmation email; otherwise the contact is added to the list directly.
   Every request is validated server-side and the API key never reaches the
   browser.

Create a free Brevo account, verify the sender address (or the
`prayerdome.net` domain so any mailbox on it can send), and optionally create a
contact list plus a double opt-in template. A sender that has not been verified
in Brevo will be rejected — do not invent a From address.

Set the secret in Secret Manager for Firebase Functions (the same secret name is
bound to both exported functions):

```sh
firebase functions:secrets:set BREVO_API_KEY --project <project-id>
```

Set the API key and non-secret settings as Vercel environment variables, then
redeploy — existing deployments do not pick up new variables:

```sh
vercel env add BREVO_API_KEY production
vercel env add BREVO_SENDER_EMAIL production  # default noreply@prayerdome.net
vercel env add BREVO_SENDER_NAME production   # default Prayer Dome
vercel env add BREVO_LIST_ID production       # optional numeric list id
vercel env add BREVO_DOI_TEMPLATE_ID production # optional numeric DOI template
```

For Firebase Functions, put the non-secret settings in
`functions/.env.<project-id>` (copy `functions/.env.example`) as well, then run
`firebase deploy --only functions --project <project-id>`. Deploying functions
requires the `BREVO_API_KEY` secret to exist; create it first or the deploy stops
before changing anything.

Check the endpoint after deploying (it must return JSON, not an HTML page):

```sh
curl -i -X POST https://prayerdome.net/api/newsletter \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","consent":true}'
```

`200` with `"ok":true` means the address was accepted; `503 NOT_CONFIGURED`
means the key is missing on that host; `502 BREVO_UNAVAILABLE` means Brevo
rejected the request (check the sender verification and the key). The
`doubleOptIn` field tells the page whether to ask the member to confirm.

### Cloudinary callable function

Copy `functions/.env.example` to `functions/.env.<project-id>` and supply your
cloud name, API key and upload preset. Put the secret in Secret Manager:

```sh
firebase functions:secrets:set CLOUDINARY_API_SECRET --project <project-id>
```

Deploy Functions after configuring the values and secret. Legacy
`functions:config:set` is no longer used. The callable requires authentication,
signs canonical Cloudinary parameters, and fixes uploads to a per-user folder.
Clients must submit the returned `folder`, `upload_preset`, `timestamp`, `apiKey`
(as `api_key`) and `signature` unchanged. Test a real upload with your preset;
verify its allowed formats, size limits and moderation in Cloudinary.

### Live relay (optional, strongly recommended for mobile viewers)

The browser broadcaster uses WebRTC for the media itself and Firestore only for
signaling metadata. Direct WebRTC works on many home networks, but viewers on
mobile carrier NAT often need a TURN relay.

Do **not** put TURN credentials in `assets/pd-live-webrtc.js`. Instead configure
a server-side secret; `/api/live-ice` mints a short-lived credential and the page
consumes it.

### Cloudflare Realtime TURN (recommended)

In the Cloudflare dashboard open **Realtime → TURN Server Apps → Prayer Dome**.
Copy the **TURN Token ID** and create/copy the **API Token**. The API token is a
secret, so it belongs only in the server environment — never in Git, chat or a
browser file.

```sh
vercel env add TURN_PROVIDER production        # cloudflare
vercel env add TURN_KEY_ID production          # Cloudflare TURN Token ID
vercel env add TURN_KEY_API_TOKEN production   # Cloudflare API Token (secret)
```

The endpoint exchanges those for short-lived credentials at
`https://rtc.live.cloudflare.com/v1/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers`.
The browser receives only the normalised `iceServers` list (Cloudflare STUN/TURN
URLs plus an expiring username/credential), never the TURN key or API token.

If a Cloudflare key or token is exposed, revoke/rotate it in the Cloudflare
dashboard before redeploying.

### Metered or a custom relay

```sh
vercel env add METERED_TURN_API_KEY production
vercel env add METERED_TURN_SUBDOMAIN production  # optional, default prayerdome
# OR a provider that returns an ICE-server array or { iceServers: [...] }:
vercel env add TURN_CREDENTIALS_URL production
vercel env add TURN_API_KEY production            # sent as a Bearer token
```

`/api/live-ice` is an alias for `/api/system?op=live-ice`, so it stays inside the
12-function Hobby limit. If no relay is configured it returns public STUN only;
the player then reports an honest connection problem rather than pretending to
play. Restart/redeploy after adding variables — existing deployments keep the
old environment.

## Required security and service checks before launch

- **Audit existing administrators:** previous rules allowed profile/membership
  self-promotion. Review `users` and `memberships` for unauthorized roles using
  trusted administrator tooling. Rule changes do not repair existing data.
  Bootstrap legitimate admins via trusted server tooling/Firebase Console,
  never a client-side role assignment.
- **Live signaling is still public-write by design.** The `liveSignals` rules
  permit guests to exchange WebRTC signaling. This also permits tampering and
  abuse. Before enabling public broadcasting, implement authenticated (possibly
  Firebase Anonymous Auth) per-viewer ownership and broadcaster-only answer/ICE
  writes, or move signaling behind an authenticated service. Do not treat a
  random client-generated viewer ID as authorization. This requires coordinating
  viewer code, broadcaster code, project Auth settings and rules.
- Public contact/report/chat submission also needs server-side abuse controls,
  quotas and moderation. Review financial/profile read permissions and all
  member-owned writes against your privacy policy. The targeted rule fixes are
  not a complete security audit of every collection.
- Verify Firebase Auth authorized domains, password reset/email verification,
  OAuth redirect behavior, indexes, billing, quotas, and restricted public API
  keys. Test ordinary-member and administrator accounts separately.
- Smoke-test uploads, prayer/testimony moderation, membership approval, Academy
  certificates, giving/support, notifications, and live playback with real
  services. Confirm TURN/media server availability and third-party translation
  behavior; these were not validated using production credentials.
- Android store release/signing and device testing are separate release gates.

## After deployment

Check `/api/health` and provider logs, then test both a fresh browser and a
returning installed PWA (including offline pages). Watch errors, quota usage
and rejected Firestore operations. Keep the previous Vercel deployment available
for rollback. Roll back code/config deliberately; never restore the vulnerable
role-assignment rules as a quick fix.
