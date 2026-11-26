'use strict';

/* Acceptance checks for the Firestore-only giving flow.
 *
 * These are deliberately static: they prove the public pages contain no
 * Cloud Functions dependency for giving, that a gift is written as a pending
 * offering, and that the admin console is the only place a gift can be
 * approved/received/rejected. Emulator rules assertions live in
 * tests/rules/firestore.test.js. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const give = read('give.html');
const support = read('support.html');
const admin = read('admin.html');
const givingAdmin = read('assets/pd-giving-admin.js');
const billing = read('assets/pd-billing.js');
const rules = read('firestore.rules');

// ---- give page ------------------------------------------------------------
assert.doesNotMatch(give, /firebase-functions|httpsCallable|getFunctions/,
  'the public give page must not load or call Cloud Functions');
assert.match(give, /getDoc\(doc\(db, 'settings', 'payments'\)\)/,
  'official payment methods must be read directly from Firestore');
assert.match(give, /setDoc\(doc\(db, 'offerings', reference\)/,
  'the reference must be the offering document id so it cannot be reused');
assert.match(give, /transactionReference: transactionReference/,
  'the visitor must submit the transaction reference they were given');
assert.match(give, /status: 'pending'/,
  'a visitor submission must always start pending');
assert.doesNotMatch(give, /status:\s*'received'|status:\s*'approved'/,
  'a visitor can never submit a confirmed status');
for (const category of ['church-support', 'general-offering', 'missions', 'evangelism', 'building-projects', 'other']) {
  assert.ok(give.includes(`value="${category}"`), 'missing giving category: ' + category);
}
assert.match(give, /PDUpload\.uploadPrivate\(file, 'givingEvidence'\)/, 'receipts must go to the unguessable giving evidence folder');
assert.doesNotMatch(give, /cardNumber|cardCvv|cardExpiry/,
  'the give page must never collect or store card details');
assert.match(give, /Billing\.methodCheckoutUrl/,
  'a hosted checkout URL must be used when Finance configures one');
assert.match(give, /target="_blank" rel="noopener noreferrer"/,
  'hosted checkout must open safely in a new tab');

// ---- member support page --------------------------------------------------
assert.match(support, /aria-controls="view-give"/, 'support page needs a Give tab');
assert.match(support, /setDoc\(doc\(db, 'offerings', reference\)/,
  'member giving must write the offering directly to Firestore');
assert.match(support, /transactionReference: transactionReference/);
assert.match(support, /status: 'pending'/);
assert.match(support, /PDUpload\.uploadPrivate\(file, 'givingEvidence'\)/);
assert.doesNotMatch(support, /cardNumber|cardCvv|cardExpiry/);

// ---- admin console --------------------------------------------------------
assert.match(admin, /data-view="giving"/, 'admin navigation must expose Giving & Donations');
assert.match(admin, /id="view-giving"/);
assert.match(admin, /pd-giving-admin\.js/);
assert.match(givingAdmin, /collection\(bridge\.db, 'offerings'\)/);
assert.match(givingAdmin, /status === 'received'/,
  'confirmed totals must be limited to received records');
assert.match(givingAdmin, /status: 'approved'/);
assert.match(givingAdmin, /status: 'received'/);
assert.match(givingAdmin, /status: 'rejected'/);
assert.match(givingAdmin, /receiptNumber/);
assert.match(givingAdmin, /downloadGivingCsv/);
assert.match(givingAdmin, /givingAudit/);

// ---- rules ---------------------------------------------------------------
assert.match(rules, /match \/offerings\/\{id\}/);
assert.match(rules, /request\.resource\.data\.status == 'pending'/,
  'a member-created offering must be pending');
assert.match(rules, /request\.resource\.data\.reference == id/,
  'an offering document id must equal its reference');
assert.match(rules, /cardNumber|cardCvv/,
  'the rules must explicitly reject card fields');
assert.match(rules, /match \/givingAudit\/\{id\}/);
assert.match(rules, /match \/settings\/payments \{\s*allow read: if true;/,
  'payment settings must be readable before sign-in');
assert.match(give, /PDUpload\.uploadPrivate\(file, 'givingEvidence'\)/,
  'giving receipts upload through the shared Cloudinary service');
assert.doesNotMatch(give, /firebase-storage\.js|uploadBytes|getDownloadURL/,
  'the giving page must not use Firebase Storage');

// ---- hosted checkout model ------------------------------------------------
assert.match(billing, /hosted-checkout/);
assert.match(billing, /function methodCheckoutUrl/);
assert.match(billing, /checkoutUrl:/);

console.log('giving tests passed');
