# Payment system repair — support, deposits, giving, withdrawals

## Root cause of the reported error

The message

> Billing hit an internal error; the server did not confirm the request. Please retry in a moment. If it continues, contact info@prayerdome.net and quote code internal.

was produced by `PDBilling.billingErrorCopy()` in `assets/pd-billing.js`. That
branch is used only when the error has code `internal` **without** the
`details.billing === true` marker that `functions/billing.js` puts on its own
business errors. In other words, the browser was not receiving a decision from
the billing server at all; it was receiving a transport/platform error.

The request that produced it came from `support.html`:

```js
const cloudFunctions = getFunctions(app);
const billingCall = httpsCallable(cloudFunctions, 'billing');
```

Production is hosted on Vercel. Vercel does not deploy Firebase Cloud
Functions, and the Google Cloud billing account is closed, so
`https://us-central1-prayer-dome.cloudfunctions.net/billing` could not serve
`plans.list`, `checkout.create`, `withdrawal.request` or any other billing
action. The Firebase Functions SDK reported an opaque `internal` failure, and
the page faithfully translated it into the message above. A second, latent
problem was that `functions/billing.js` imported `firebase-functions/v1` and was
registered only as a Cloud Function, so the money logic could not run anywhere
else without a Google Cloud deployment.

## What was changed

| File | Purpose |
| --- | --- |
| `support.html` | Removed the `firebase-functions` import and callable. All billing actions use `PDBillingClient` over `/api/billing`. Added payout-method selection, an account field for bank transfers, withdrawal cancellation and status labels. |
| `admin.html` | Loads the billing client and supplies the admin's Firebase ID token; added date/user/method/status filters, failed/cancelled payment filters and CSV export controls. |
| `assets/pd-billing-client.js` (new) | Same-origin HTTP client with Bearer token, code-preserving error mapping, no retries on business failures, no secrets. |
| `assets/pd-billing-admin.js` | Replaced the admin billing callable with the HTTP client; added under-review/cancel actions, payout column, filters and CSV export. |
| `functions/billing.js` | Removed the Cloud Functions SDK import and registration; exports a runtime-independent `handler`. Added signature-verified provider confirmation, payout-method validation, under-review and cancellation states, and duplicate-open-deposit detection. |
| `functions/index.js` | Removed the `billing` callable and its Cloud Scheduler job; no payment function is deployed. |
| `lib/billing-server.js` (new) | Vercel gateway: Firebase ID-token verification, Firebase Admin credential from Vercel env, action allowlist, rate limiting, safe error mapping and HMAC webhook verification. |
| `api/system.js`, `vercel.json`, `.vercelignore` | Added `/api/billing` and `/api/payment-webhook` rewrites to the existing consolidated system function; included the billing source files and installed `firebase-admin` on Vercel. Still 12 serverless functions. |
| `package.json`, `package-lock.json` | Added server-side `firebase-admin` 13.x; removed the Cloud Functions billing deploy script; explicit Vercel install command. |
| `firestore.indexes.json` | Composite index for duplicate-open-deposit lookup. |
| `assets/pd-billing.js` | Safe not-found guidance now points at the Vercel API; added `pending`, `under_review`, `failed` and `refunded` labels. |
| `tests/payment-system.test.js` (new) | Full lifecycle tests against an atomic in-memory Firestore double: deposits, confirmations, failures, duplicate prevention, withdrawals, permissions, webhook signatures and replays. |
| `tests/billing.test.js`, `tests/vercel.test.js`, `tests/deployment.test.js`, `tests/dev-server.test.js`, `tests/layout.test.js` | Updated stale expectations and added gateway/deployment regression checks. The layout count assertion was already failing on the base revision (51 tables, not 48) and now matches the real markup. |
| `DEPLOYMENT.md`, `GIVING_WITHOUT_CLOUD_FUNCTIONS.md`, `scripts/install-functions.mjs` | Documented Vercel billing configuration, webhook contract and the absence of a Cloud Functions payment path. |

## Payment methods and confirmation paths

| Method | Verified in this workspace | Confirmation |
| --- | --- | --- |
| Mobile Money (Airtel/MTN or any configured number) | Logic and UI tested with a configured test method; no real money moved | Member submits reference + private receipt; Finance verifies against the ministry account and approves. Also usable as an approved payout channel. |
| Bank transfer | Logic and UI tested with a configured test method; no real money moved | Same verified administrative process; bank account fields are shown from Finance settings. Also usable as an approved payout channel. |
| Cash at office / WhatsApp | Present in the existing settings model and payment instructions | Manual Finance verification only; not a payout channel. |
| Hosted checkout | Tested with a simulated signature and test secret (`https://pay.example.org` in tests only) | Provider HMAC webhook with matching reference, amount, currency and fresh event id, or the same manual Finance process. No provider credentials are committed. |

Nothing in this repository pretends a live provider is configured. The church's
real numbers, bank accounts and hosted checkout URL still have to be entered by
an administrator in **Payment Verification → Payment methods**.

## Tests performed

* `npm test` — full repository suite, exit 0, including the new six-test
  payment lifecycle suite.
* `npm run lint` — icons, navigation, production JS syntax, SEO, widget data and
  Android asset links, exit 0.
* `npm run functions:verify` — functions modules load; `firebase-admin` 13.x
  namespace API present, exit 0.
* `node tests/payment-system.test.js` — deposit creation/evidence/approval with
  duplicate idempotency-key and double-tap protection; wallet credit exactly
  once; withdrawal hold, review, approval, rejection, cancellation, paid marking
  and repeat-payout protection; over-balance and unauthorised payout rejection;
  unsigned/forged/tampered/replayed webhook events; rate limiting; static
  Cloud Functions removal checks.
* Local Vercel-equivalent preview (`scripts/dev-server.mjs`) on port 8000:
  `/support.html`, `/give.html` and `/assets/pd-billing-client.js` returned 200;
  `POST /api/billing` without a token returned 401 with a safe JSON error;
  `POST /api/payment-webhook` without a configured secret returned 503 and did
  not alter a payment.
* Responsive/mobile layout is covered by the existing `tests/responsive.test.js`,
  `tests/layout.test.js` and `tests/layout.test.js` table-wrapper assertions,
  all passing. The preview uses the same page markup on desktop and mobile
  widths.
* `npm run test:rules` could not run here: the sandbox has no Java runtime for
  the Firestore emulator. Firestore rules were reviewed and their static
  acceptance tests pass.

## Remaining external configuration

1. Set `FIREBASE_SERVICE_ACCOUNT_JSON` (single-line full service-account JSON)
   in Vercel for Production and each preview environment used for payments.
   The account needs Firestore Data Reader/Writer. No Cloud Billing account is
   needed for these Firestore/Auth operations.
2. If automatic provider confirmation is used, set `PAYMENT_WEBHOOK_SECRET` to
   the HMAC secret supplied by the chosen provider and configure the provider's
   webhook URL to `https://prayerdome.net/api/payment-webhook`. Without it,
   webhooks fail closed and Finance verification remains the confirmation path.
3. Configure real payment methods in the admin console. No phone numbers, bank
   accounts or gateway keys are present in source control.
4. Deploy Firestore rules and indexes from a signed-in
   machine; Vercel does not deploy them. No `firebase deploy --only functions`
   step is required for payments.
5. Run one small live transaction through the configured provider after the
   environment variables are set, then approve it in the admin console. This
   sandbox deliberately did not create a fake successful production payment.

## Follow-up full-feature audit (26 Nov 2026)

After the Vercel deployment checks turned green, the whole repository was
audited feature by feature for incomplete controls and credential leaks. Three
concrete defects were found and fixed in this branch:

| Finding | Fix |
| --- | --- |
| `admin.html`'s Financial Reports "Export All" button only displayed a toast saying an export was ready. No file was produced. | The button now exports the current filtered report list as a real UTF-8 CSV, using the same safe quoting pattern as the certificate export. Formula-like cells are neutralised before they reach Excel/Sheets. |
| Report and deposit document URLs were interpolated straight into inline `onclick` handlers. A quote or `javascript:` URL in a Firestore row could break the handler or open an unsafe link. | Only `http(s)` URLs are rendered, and they are emitted with `JSON.stringify` plus `<` escaping before being passed to `viewDoc()`. |
| The legacy Finance overview still labelled every non-approved withdrawal as "Pending" and offered actions for a status the billing API no longer creates. Domey's random micro-saccades also overwrote a real `rig.look()` gaze signal, causing an intermittent gaze test failure. | The overview now uses the real Pending review / Under review / Approved / Processing / Paid / Rejected / Cancelled labels, shows the billing currency, and sends staff to the authoritative money views. Domey's idle glances are now a small decaying offset to, never a replacement for, the member's gaze. |

Stale source comments and one admin help sentence still called the retired
money path a "billing callable"; they now refer to the Vercel billing API.
Historical reports deliberately keep the old wording where it describes the
original failure.

Verification after these changes: `npm test` (all suites), `npm run lint`,
`npm run functions:verify`, `npm run build`, `node --check` over 145 JavaScript
files, and local HTTP smoke checks of `/support.html`, `/give.html`,
`/admin.html`, `/api/health` and unauthenticated `/api/billing` (401). All
passed. Responsive structure is checked by the existing jsdom/layout tests;
there is still no real browser or physical Android device in this environment,
and no fake production payment was created.
