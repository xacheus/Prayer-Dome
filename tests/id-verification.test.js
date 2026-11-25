'use strict';

/* Static acceptance checks for the membership verification, card, giving and
   resource-library fixes. These complement the real-browser checks in the
   report; they catch regressions where a private read, a raw-id QR or a
   second card renderer is reintroduced. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const verify = read('verify.html');
const membership = read('membership.html');
const give = read('give.html');
const resources = read('resources.html');
const academy = read('assets/pd-academy.js');
const game = read('game.html');
const rules = read('firestore.rules');
const server = read('functions/verification.js');
const admin = read('admin.html');
const extras = read('assets/pd-admin-extras.js');

// ---- verification endpoint -------------------------------------------------
assert.match(verify, /httpsCallable/, '/verify must call the server');
assert.match(verify, /verifyMembership/, '/verify must call verifyMembership');
assert.match(verify, /never upper-case a pasted code/, 'a pasted QR code must keep its exact case');
assert.doesNotMatch(verify, /getDoc\b|getDocs\b|membershipVerification/,
  '/verify must not read private Firestore documents directly');
for (const state of ['Verified & Active', 'Pending Approval', 'Not Yet Issued', 'Expired',
  'Suspended', 'Revoked', 'Invalid ID', 'Verification Unavailable']) {
  assert.ok(verify.includes(state), 'missing verification state: ' + state);
}
assert.match(verify, /trim\(\)/, 'manual input must be trimmed');
assert.match(verify, /toUpperCase\(\)/, 'manual input must be normalised to one case');

assert.match(server, /normaliseId/, 'server must normalise the ID');
assert.match(server, /text\(value, 40\)\.toUpperCase\(\)/, 'server case rule must be explicit');
assert.match(server, /resolveState/, 'server must resolve status separately from existence');
assert.match(server, /membershipVerificationRefs/, 'server must resolve QR tokens');
assert.match(server, /randomBytes\(12\)\.toString\('base64url'\)/, 'QR token must be unpredictable');
assert.match(server, /ensureMyCard/, 'server must issue a card projection for approved members');
assert.match(server, /membershipVerificationHistory/, 'server must append issuance history');
assert.doesNotMatch(server, /userId:\s*context\.auth\.uid[^]*return\s*\{[^}]*userId/,
  'public result must not echo the user id');

// ---- card identity and QR --------------------------------------------------
assert.match(membership, /aspect-ratio:\s*85\.6\s*\/\s*54/, 'card must use CR80 proportions');
assert.match(membership, /object-fit:\s*cover/, 'portrait must cover its frame');
assert.match(membership, /object-position:\s*center 22%/, 'portrait must keep the face in the upper frame');
assert.match(membership, /S\. K\. MASUKU/, 'founder name must be exact');
assert.match(membership, /Founder and President/, 'founder role must be present');
assert.doesNotMatch(membership, /barcodeImg|JsBarcode/, 'barcode must not compete with the QR');
assert.match(membership, /verify\?ref=/, 'QR must point at a token URL');
assert.doesNotMatch(membership, /verify\?id=/, 'QR must never expose a raw membership id');
assert.match(membership, /verify\?ref=[^]*encodeURIComponent/, 'QR token must be encoded');
assert.match(membership, /addPage\(\[width, height\]/, 'PDF must add exactly a second CR80 page');
assert.match(membership, /const width = bleed \? 91\.6 : 85\.6;/, 'PDF page width must be CR80 (or the optional bleed page)');
assert.match(membership, /const height = bleed \? 60 : 54;/, 'PDF page height must be CR80 (or the optional bleed page)');
assert.match(membership, /downloadID\('front'\)/, 'front download action missing');
assert.match(membership, /downloadID\('back'\)/, 'back download action missing');
assert.match(membership, /@page \{ size: 85\.6mm 54mm; margin: 0; \}/, 'print page must be CR80');
assert.match(membership, /ensureMyCardCall/, 'card page must ask the server for its token');
assert.match(membership, /Secure QR could not be registered/, 'card must explain a missing token');
assert.match(membership, /\/assets\/qrcode-generator\.js/, 'QR encoder must be bundled, not CDN-only');
assert.doesNotMatch(membership, /cdn\.jsdelivr\.net\/npm\/qrcode-generator/, 'QR encoder must not depend on a CDN');
assert.match(membership, /function cardRoleLabel/, 'card must derive a membership category, not print a raw role');
assert.match(membership, /return 'PASTOR'/, 'pastors must print PASTOR');
assert.match(membership, /return 'TEAM MANAGEMENT'/, 'church team roles must print TEAM MANAGEMENT');
assert.match(membership, /return 'MEMBER'/, 'ordinary members must print MEMBER');
assert.doesNotMatch(membership, /idRole/, 'raw role/department must not leak through the retired idRole field');
assert.match(server, /_categoryLabel/, 'server must apply the same category rule as the card');
assert.match(server, /reserveMembershipNumber/, 'membership numbers must be reserved atomically');
assert.match(rules, /match \/membershipCounters\/\{year\}/, 'number counters must be server-only');
assert.match(membership, /const width = bleed \? 91\.6 : 85\.6;/, 'PDF width must switch only for optional bleed');
assert.match(membership, /const height = bleed \? 60 : 54;/, 'PDF height must switch only for optional bleed');
assert.match(membership, /addPage\(\[width, height\]/, 'the back must be a second page of the same PDF');
assert.match(membership, /downloadID\('front'\)/, 'front PNG download must stay separate');
assert.match(membership, /downloadID\('back'\)/, 'back PNG download must stay separate');
assert.match(membership, /normalizeCardCanvas/, 'exports must be normalised to exact CR80 pixels');
assert.match(membership, /bleedCardCanvas/, 'optional bleed must not enlarge the card');
assert.match(membership, /targetWidth \|\| 2568/, 'card export must use the exact CR80 pixel width');
assert.match(membership, /const innerW = 2568;/, 'bleed must keep the card at 2568 px wide');
assert.match(membership, /const innerH = 1620;/, 'bleed must keep the card at 1620 px high');
assert.match(membership, /pd-signature\.png/, 'membership card must use the official signature image');
assert.match(membership, /S\. K\. MASUKU/, 'membership card must print the authorised founder name');
assert.match(read('assets/pd-certificate.js'), /pd-signature\.png/, 'certificate must fall back to the official signature');
assert.match(read('assets/pd-certificate.js'), /S\. K\. MASUKU/, 'certificate must print the authorised founder name');
assert.ok(fs.existsSync(path.join(ROOT, 'assets/pd-signature.png')), 'signature PNG must ship');
assert.ok(fs.existsSync(path.join(ROOT, 'assets/pd-signature.svg')), 'signature vector must ship');
assert.match(read('certificates.html'), /pd-signature\.png/, 'certificate card must show the signature image');
assert.match(read('certificates.html'), /S\. K\. MASUKU/, 'certificate card must print the authorised founder name');

// ---- approval creates the issued projection --------------------------------
assert.match(admin, /window\.issueCardVerification\(uid, false/,
  'approval must issue the card verification record');
assert.match(admin, /Repair missing cards/i, 'the card panel must offer a repair action for approved members');
assert.match(extras, /window\.repairMissingCards = repairMissingCards/, 'the repair action must be exposed to the inline handler');
assert.match(extras, /membershipVerificationRefs/, 'repair must restore QR pointer documents, not only the card projection');
assert.match(admin, /signatureFileIsSafe/, 'signature uploads must be validated');
assert.match(admin, /signatureAuthorityConfirm/, 'signature changes must require an authority attestation');
assert.match(admin, /readSignatureImage/, 'uploaded signatures must be probed before use');
assert.match(admin, /signatureAuditNote/, 'the last authorised signature change must be visible');
assert.match(read('assets/pd-app.js'), /founder\.setLocal\(data\);\s*return data;/, 'signature cache must update only after a successful write');
assert.match(admin, /await PDApp\.founder\.save\(data\)/, 'signature save must await the secure write');
assert.match(admin, /Only an authorised administrator may change certificate signatures/, 'signature changes must be admin-gated');
assert.match(admin, /S\. K\. MASUKU/, 'admin signature identity must use the exact founder name');
assert.match(admin, /membership_id_changed/, 'sensitive ID changes must be audited');
assert.match(admin, /already used by another member/, 'duplicate IDs must be rejected');
assert.match(extras, /memberSnap = await store\.getDoc\(store\.doc\(bridge\.db, 'memberships', uid\)\)/,
  'issuing must work outside the card-panel cache');
assert.match(server, /not_issued/, 'an approved number without an issued card must resolve to not_issued');

// ---- give page -------------------------------------------------------------
assert.doesNotMatch(give, /Pastor Zacheus|Simbaya/, 'no individual may be a giving recipient');
assert.doesNotMatch(give, /PRAYER DOME CHURCH/, 'recipient must be PRAYER DOME, the organisation');
const purposeValues = ['Church support', 'General offering', 'Missions', 'Evangelism', 'Building projects', 'Other'];
for (const value of purposeValues) assert.ok(give.includes('>' + value + '<'), 'missing giving purpose: ' + value);
assert.match(give, /organization:\s*"PRAYER DOME"/, 'offering must name the organisation');
assert.match(give, /recipient:\s*"PRAYER DOME"/, 'offering must name the recipient');
assert.match(give, /donorUid:\s*currentUser\.uid/, 'payer id must be stored privately');
assert.match(give, /reference:\s*reference/, 'a payment reference must be stored');
assert.match(give, /PDG-/, 'payment reference must be a real, quotable format');
assert.match(give, /PRAYER DOME — giving recorded/, 'confirmation must identify PRAYER DOME');
assert.doesNotMatch(give, /moment\(/, 'give page must not call the unloaded moment library');
assert.match(give, /getDoc\(doc\(db, 'settings', 'payments'\)\)/, 'give page must read finance settings directly from Firestore');
assert.doesNotMatch(give, /firebase-functions|httpsCallable/, 'giving must not depend on a Cloud Function');
assert.match(give, /paymentMethodsFor\(settings, 'give'\)/, 'give page must show only enabled giving methods');
assert.match(give, /methodId: method\.id/, 'the offering must name the configured method used');
assert.doesNotMatch(give, /waPaymentNumber|momoPaymentNumber|momoAmt|waAmt/, 'no hardcoded payment card elements');

// ---- resources -------------------------------------------------------------
assert.match(resources, /PD_RESOURCES_OWNED_BY_PAGE = true/, 'page must own the resource grid');
assert.match(academy, /PD_RESOURCES_OWNED_BY_PAGE\) return/, 'academy must not overwrite the grid');
assert.match(resources, /resourceStatus/, 'resources need a visible loading/error state');
assert.match(resources, /No resources are available yet/, 'empty state must explain itself');
assert.match(resources, /LIVE\.error/, 'live errors must be shown');
assert.match(resources, /function safeUrl/, 'resource URLs must be constrained');
assert.match(resources, /fl_attachment/, 'downloads must force a file where supported');
assert.match(resources, /size:\s*fmtBytes\(EDIT\.fileBytes\)/, 'uploaded file size must be stored');
assert.match(resources, /aria-busy/, 'grid must expose its loading state');
assert.match(resources, /where\('published', '!=', false\)/, 'resource list must satisfy the read rule with an explicit query');
assert.match(resources, /setFirestore\(bindings\)/, 'resources must install Firestore bindings instead of waiting forever');
assert.match(resources, /where, *$/m, 'Firestore bindings must include where for the published query');

// ---- game tabs -------------------------------------------------------------
assert.match(game, /#domeyTopicChips \{[^}]*display: grid/s, 'topic tabs must use a wrapping grid');
assert.match(game, /minmax\(min\(100%, 136px\), 1fr\)/, 'topic tabs must wrap into rows');
assert.match(game, /white-space: normal/, 'topic tabs must not split words into letters');
assert.match(game, /\.is-selected/, 'active topic must be visible');
assert.match(game, /aria-pressed/, 'topic tabs must expose their state');

// ---- security --------------------------------------------------------------
assert.match(rules, /match \/membershipVerification\/\{id\} \{\s*[\s\S]*?allow get, list: if isAdmin\(\);/,
  'card records must not be publicly readable');
assert.match(rules, /match \/membershipVerificationRefs\/\{reference\} \{\s*[\s\S]*?allow get, list: if isAdmin\(\);/,
  'QR pointers must not be publicly readable');
assert.match(rules, /match \/offerings\/\{id\} \{[^}]*allow read: if isAdmin\(\) \|\|/s,
  'offering rows must be private or owner-readable');
assert.match(rules, /request\.resource\.data\.donorUid == request\.auth\.uid/,
  'offering creation must bind the payer uid');

console.log('ID verification, card, giving, resources and game acceptance checks passed.');
