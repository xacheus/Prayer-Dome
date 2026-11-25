# Giving without Google Cloud Functions or Cloud billing

**Status:** implemented on `arena/e95077f2-prayer-dome` and covered by the repo test suite.
**Goal:** church giving, donations and support contributions must work with Firestore only — no Cloud Functions deployment and no paid Google Cloud billing account.

## 1. What is now delivered

| Area | Result |
| --- | --- |
| Public give page | Reads `settings/payments` directly from Firestore. No `firebase-functions` import and no `httpsCallable`. |
| Member support page | New **Give** tab records the same Firestore offering. No callable in the giving path. |
| Payment methods | Administrator adds/edits Airtel Money, MTN Mobile Money, bank transfer, office cash, WhatsApp and provider-hosted checkout. Saved directly to `settings/payments`; nothing is hard-coded. |
| Provider checkout | A method may carry an `https://` **Hosted checkout URL**. The donor pays on the provider page; card data never touches Prayer Dome. |
| Submission | Amount, category, method, transaction reference and optional private receipt. The record is written as `offerings/{reference}` with `status: 'pending'`. |
| Duplicate references | The payment reference **is** the Firestore document id. A second submission cannot create another record with the same reference. |
| Trust boundary | A visitor can never submit `approved`/`received`, a receipt number or review metadata. Only Finance can change status. |
| Admin review | **Giving & Donations** lists all records with contributor, amount, method, reference, transaction id and proof. Filter by date, category, method, status and free text. |
| Admin actions | **Approve**, **Reject** (with reason), **Mark received**. Receipts are generated only for received gifts. |
| Totals | The confirmed total is calculated from `received` rows only. Pending and approved rows are shown as counts, never as income. |
| Audit | `givingAudit` is append-only for administrators: approvals, rejections, received marks and payment-setting changes. |
| Receipt privacy | Files upload to `givingEvidence/{uid}/…`; only the giver and Finance can read the object. No public Cloudinary preset is used by giving any more. |
| Card data | No card fields exist in the pages or rules. The Firestore rules explicitly reject `cardNumber`, `cardCvv`, `cvv`, `cvc`, `pan` and `cardExpiry`. |
| Existing features | Authentication, notifications, news, live, membership cards and the other Firebase features are untouched. All existing tests still run. |

### Category values

`church-support`, `general-offering`, `missions`, `evangelism`, `building-projects`, `other`.

### Status workflow

```
pending  ──approve──▶  approved  ──mark received──▶  received
   │                       │
   └──────reject───────────┴──────────▶  rejected
```

`received` is the only status included in confirmed contribution totals. The browser never chooses any status other than `pending`.

### Files changed

- `give.html` — direct Firestore settings read, secure receipt upload, transaction reference, hosted checkout, pending offering write.
- `support.html` — new **Give** tab and Firestore-only contribution form.
- `admin.html` — **Giving & Donations** navigation, filters, summary cards, giving table and detail modal.
- `assets/pd-giving-admin.js` — review dashboard, approve/reject/receive, duplicate-transaction warning, CSV export and printable receipt.
- `assets/pd-billing-admin.js` — payment methods now saved to Firestore directly, with hosted checkout URL support.
- `assets/pd-billing.js` — shared method model accepts `hosted-checkout` and `checkoutUrl`.
- `firestore.rules` — public read / admin write for payment settings, validated pending offering creation, admin-only transitions, append-only audit.
- `storage.rules` — private `givingEvidence` path.
- `functions/billing.js` — legacy callable kept working, with parity for hosted checkout settings.
- `DEPLOYMENT.md` — Firestore-only giving deployment section.
- `tests/giving.test.js`, `tests/rules/firestore.test.js`, `tests/billing.test.js`, `tests/id-verification.test.js`, `tests/layout.test.js`, `tests/upgrade.test.js`.

## 2. Security model

### Firestore

- `settings/payments`: **public read** (the give page must show the church's real numbers before sign-in); **administrator write**, and the write must set `updatedBy` to the authenticated admin uid.
- `offerings/{reference}`:
  - Create requires a signed-in giver, `donorUid == auth.uid`, `reference == document id`, `status == 'pending'`, an allowed category, an allowed method type, a numeric amount in range, a 3-letter currency, a transaction reference of 4–120 characters and a donor name.
  - Create rejects confirmation/review fields and all card fields.
  - Read is the owner or an administrator.
  - Update is administrator-only; reference, donor and amount cannot be changed; the new status must be `pending`, `approved`, `received` or `rejected`.
  - Delete is administrator-only.
- `givingAudit`: administrator read/create; no update or delete.
- `settings/payments` write can only be performed by `isAdmin()`; the callable is not needed for finance configuration.

### Storage

`givingEvidence/{uid}/{fileName}` is readable only by that uid or an administrator, writable only by that uid on create, under 5 MB and image/PDF only. Files cannot be replaced or deleted.

### What the browser cannot do

- Mark a gift paid or received.
- Change another giver's record.
- Supply a status or receipt number at creation.
- Store card data.
- Change the official payment details.

## 3. What still needs real credentials or administrator configuration

These are **configuration**, not code gaps. Nothing below requires Google Cloud Functions or an activated Cloud billing account.

1. **Real payment details.** An administrator must enter the church's actual Airtel Money, MTN Mobile Money, bank or office details in **Payment Verification → Payment methods** (also linked from **Giving & Donations**) and save. The repository intentionally contains no phone numbers or account numbers.
2. **A hosted-checkout provider, if you want card payments.** Create an account with an approved non-GCP-billing provider, obtain the hosted checkout URL and put it on a payment method. The donor pays there and returns with the provider transaction reference.
3. **Automatic provider verification/webhooks, if you later want it.** Not required for the delivered manual-safe flow. It needs provider API credentials and a webhook secret and should terminate on Vercel (`api/system.js?op=…`) or another non-GCP host, verify the provider signature, and write the status with a server credential. Do not trust a browser success claim.
4. **Deploying rules/storage.** The sandbox has no Firebase credentials. Run the commands in section 5 from a machine signed into the Firebase project.
5. **Deploying the website.** Vercel deploys the branch as usual; no `functions:billing` deployment is needed for giving.
6. **A real end-to-end live payment.** A sandbox cannot move real Airtel/MTN/bank money. After configuration, submit one small real gift, approve it, mark it received and print the receipt.

### Provider choices to consider

Any provider that gives you an `https://` hosted checkout page and a transaction reference works with the delivered flow. Common African options include Flutterwave, Pesapal, DPO Pay, Payfast and provider-specific merchant portals. Choose one that supports your country, currency (SZL/USD) and settlement bank; this is a commercial decision, not a code dependency. The code does not pretend a provider is configured when it is not.

## 4. What remains on the legacy callable (out of scope for church giving)

The member **support plans / savings wallet** product (`paymentRequests`, `subscriptions`, `walletTransactions`, withdrawals and plan checkout) still calls the optional `billing` Cloud Function in `functions/billing.js`. That product is not church giving and is not required for the Give page or the support **Give** tab. If you also want plan checkout to run without Cloud Functions, that is a separate migration with its own balance-integrity design; do not mix it into the giving release. Giving, donations and support contributions are complete without it.

## 5. Deploy/configure checklist

```sh
# 1. Verify locally
npm ci
npm test
npm run lint
npm run functions:verify

# 2. Deploy the Firestore and Storage rules (no functions, no Cloud billing)
firebase deploy --only firestore:rules,storage --project prayer-dome

# 3. Website
#    Merge/deploy the branch through Vercel as usual.

# 4. Configure
#    Sign in to /admin.html as an administrator.
#    Open Giving & Donations (or Payment Verification → Payment methods).
#    Add at least one complete, enabled method with the church's real details.
#    Optionally add a Hosted checkout URL on a method.
#    Save, then submit a small test gift from /give.html.
#    Approve it, mark it received, and generate the receipt.
```

No `firebase deploy --only functions` is needed for giving.

## 6. Verification performed in this workspace

- `npm test` — full repository suite, exit 0.
- `npm run lint` — icons, navigation, production validation, SEO, widget data and asset links, exit 0.
- `npm run functions:verify` — functions module loads, exit 0.
- `node tests/giving.test.js` — giving acceptance checks, exit 0.
- `node tests/billing.test.js` — 14 tests, 0 failed.
- `node tests/support.test.js` — 16 tests, 0 failed.
- `node tests/id-verification.test.js` — giving/card/resource assertions, 0 failed.
- Rules tests were extended in `tests/rules/firestore.test.js`. They require the Firestore emulator and Java 21, which are not installed in this sandbox, so they could not be executed here. The rules were reviewed against the same payloads used by the pages; CI or a developer machine should run `npm run test:rules`.

## 7. Acceptance mapping

| Requirement | Implementation |
| --- | --- |
| No Cloud Functions dependency for giving | `give.html` and support **Give** tab contain no functions import/call. |
| Airtel, MTN, bank, other | `paymentMethods` types plus free-form labels and admin order. |
| Admin-configurable details | `settings/payments` written by admin UI; no numbers in source. |
| Hosted checkout | `checkoutUrl` on any method; secure new-tab payment page. |
| Choose category, amount, method | Give form and member Give tab. |
| Correct instructions | Rendered from the selected method only. |
| Submit reference/transaction | Required transaction reference plus optional receipt. |
| Confirmation | Reference shown after the Firestore write; status explicitly pending. |
| Admin list and filters | Giving & Donations table + date/category/method/status/search. |
| Review evidence | Private receipt link per row/detail. |
| Approve/reject/mark received | Guarded admin actions; audit entries. |
| Receipts | Printable receipt generated for received gifts. |
| Pending never counted | Summary sums only `received`. |
| Secure rules | Member pending create, admin-only transition, anti-escalation, card-field denial. |
| Duplicate references | Document id = reference; duplicate transaction ids warned in admin. |
| Never store card details | No fields, rules reject known card keys, hosted checkout only. |
| Never trust visitor success | Forced `pending`; status changes admin-only. |
| Preserve existing features | Full test suite and lint still pass. |
