# Firebase Storage removal and shared design polish

Firebase Authentication and Firestore are unchanged. This branch removes the
Firebase Storage bucket, its SDK imports, its rules file and its hosting
configuration from the app. Media and documents now use the ministry's existing
Cloudinary media service through `assets/pd-upload.js` (`PDUpload`). Cloudflare
R2 remains the optional broadcast-only bucket for radio audio; it was already
wired to `/api/radio?op=r2-upload` and needs no new credentials for the web app.

## What changed

| Area | Before | Now |
| --- | --- | --- |
| Support receipts / giving proof | `uploadBytes()` to `billingEvidence/{uid}/…` and `givingEvidence/{uid}/…` | `PDUpload.uploadPrivate(file, 'billingEvidence' | 'givingEvidence')`: unsigned Cloudinary upload with a random `pd-*` public id. Only the returned https URL is sent to the billing API or saved on the offering. |
| Admin review | `evidence.signedUrl` asked Firebase Admin for a GCS signed URL | New receipts open directly from the URL stored on the payment row. Legacy rows show a clear message pointing Finance to the Firebase console. |
| Radio audio | `uploadBytesResumable()` to `radioAudio/{kind}/…` | `PDUpload.uploadPrivate(file, 'radioAudio/' + kind, { preset: 'live_streams' })`; R2 upload remains available for 24/7 broadcast. |
| Event images | Firebase Storage object | `PDUpload.upload(..., { preset: 'news_images', folder: 'events' })`. |
| Chat attachments | Unused Storage import alongside the Cloudinary uploader | Import removed; chat already uploads through `PDUpload.upload(..., { preset: 'gallery_uploads', folder: 'chat_media' })`. |
| Configuration | `storageBucket` in every Firebase config, `firebase.json` storage block, `storage.rules`, `window.PDAdmin.storage` | All removed. No source file configures a Storage bucket. |
| Design | Page-local card/button/form treatments with uneven focus states | Shared low-specificity polish in `assets/pd-responsive-fix.css` (loaded by all 42 pages) plus a clearer, larger-tap-target upload dialog in `assets/pd-upload.js`. |

## Why Cloudinary needs no new secret in the browser

`PDUpload` uses the ministry's existing unsigned upload presets. It sends the
file, `upload_preset`, `folder` and an optional random `public_id` directly to
`https://api.cloudinary.com/v1_1/prayerdome/auto/upload`. The API secret is not
in the repository or the browser. Uploaded receipts are unguessable because the
public id is a random UUID fragment, not a member name, phone number or payment
reference.

If a preset is missing on the Cloudinary account, `PDUpload` tries the
documented fallbacks and then shows a safe error. No fallback creates local
credentials or a paid Google Cloud dependency.

## Required external configuration

1. Confirm these unsigned upload presets exist in the Cloudinary account
   `prayerdome`: `donation_proofs`, `live_streams`, `news_images`,
   `gallery_uploads`, `profile_photos`, `signatures`, `financial_reports`.
   Presets that are not used by a feature can stay disabled.
2. If receipts must be private rather than unguessable, change the
   `donation_proofs` preset to a signed mode and add a server endpoint that
   mints a short-lived signature. That is a deliberate policy change; the
   current implementation does not pretend an unsigned upload is private.
3. Deploy Firestore rules normally (`firebase deploy --only firestore:rules`).
   There is no longer a Storage rules deployment step.
4. Existing files already in the Firebase bucket are **not** deleted or
   migrated by this change. Pending payment rows with a `billingEvidence/…`
   path can still be reviewed manually in the Firebase console; new submissions
   must attach a fresh Cloudinary receipt. Ask Finance to export/archive old
   receipts before closing the bucket.

## Design polish

The shared CSS adds keyboard focus rings, 44 px touch targets on coarse
pointers, readable 16 px mobile form fields, consistent image bounds, calmer
card surfaces, clearer badges/table headings and a reduced-motion guard. It
uses `:where()` so existing page-specific styling still wins. The upload
dialog now has a larger progress bar, a live status announcement for screen
readers, 48 px actions and dark-mode error styling.

## Verification

* `npm test` — all suites, including `tests/storage-removal.test.js`, which
  scans shipped source for any Firebase Storage SDK/config reference.
* `npm run lint`, `npm run functions:verify`, `npm run build` — pass.
* `node --check` over all shipped JavaScript and inline page modules — pass.
* No real Cloudinary upload or Firebase console review was performed in this
  sandbox; those need the ministry accounts and are listed above.
