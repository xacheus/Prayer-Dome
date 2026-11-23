'use strict';

/*
 * Billing parity and safety checks.
 *
 * The price a member reads must equal the price the callable writes, the
 * browser must never be able to activate a plan itself, and a payment receipt
 * must be private. These are static checks; the Firestore emulator suite covers
 * the rules themselves.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function browserCatalogue() {
  const context = { window: {} };
  context.window.window = context.window;
  vm.runInNewContext(read('assets/pd-billing.js'), context, { filename: 'pd-billing.js' });
  return context.window.PDBilling;
}

const browser = browserCatalogue();
const server = require(path.join(ROOT, 'functions/billing-catalog.js'));

const EXPECTED_PRICES = {
  'education-bronze': 5,
  'education-gold': 50,
  'education-platinum': 100,
  'education-diamond': 500,
  'business-bronze': 5,
  'business-gold': 50,
  'business-platinum': 100,
  'business-diamond': 500,
  'compassion-basic': 2.5,
  'compassion-standard': 25,
  'compassion-premium': 50
};

test('billing failures are reported by cause, not one catch-all notice', () => {
  assert.equal(browser.billingErrorCode({ code: 'functions/not-found' }), 'not-found');
  assert.equal(browser.billingErrorCode({ code: 'firebase/functions/unauthenticated' }), 'unauthenticated');
  assert.equal(browser.billingErrorCode({ message: 'FirebaseError: internal' }), 'internal');

  const missing = browser.billingErrorCopy({ code: 'functions/not-found', message: 'not found' });
  assert.match(missing, /not available on this site yet/);
  assert.doesNotMatch(missing, /temporarily unavailable/i);

  const expired = browser.billingErrorCopy({ code: 'functions/unauthenticated', message: 'Sign in to continue.' });
  assert.match(expired, /sign-in has expired/i);

  // A server decision can share a gRPC code with a deployment failure. The
  // `details.billing` marker keeps the real reason instead of calling every
  // not-found a missing function.
  const serverMissing = 'That payment reference was not found.';
  assert.equal(
    browser.billingErrorCopy({ code: 'functions/not-found', message: serverMissing, details: { billing: true } }),
    serverMissing
  );
  const foreignPayment = 'This payment belongs to another member.';
  assert.equal(
    browser.billingErrorCopy({ code: 'functions/permission-denied', message: foreignPayment, details: { billing: true } }),
    foreignPayment
  );
  const rule = 'Your membership must be approved before you start a support plan.';
  assert.equal(
    browser.billingErrorCopy({ code: 'functions/failed-precondition', message: rule }),
    rule,
    'a real business rule must not be replaced by a network-style notice'
  );

  assert.equal(browser.billingRetryable({ code: 'functions/unavailable' }), true);
  assert.equal(browser.billingRetryable({ code: 'functions/internal' }), true);
  assert.equal(browser.billingRetryable({ code: 'functions/not-found' }), false);
  assert.match(
    browser.billingErrorCopy({ code: 'functions/not-found' }, { staff: true }),
    /firebase deploy --only functions:billing --project prayer-dome/
  );
  assert.match(
    read('functions/billing.js'),
    /new HttpsError\(code, message, Object\.assign\(\{ billing: true \}/,
    'server business errors must carry the marker the page uses to preserve their message'
  );
});

test('the member and admin pages keep the error code and retry transient calls', () => {
  const page = read('support.html');
  const admin = read('assets/pd-billing-admin.js');
  assert.doesNotMatch(page, /Billing is temporarily unavailable/);
  assert.doesNotMatch(admin, /Billing is temporarily unavailable/);
  assert.match(page, /Billing\.billingErrorCopy\(lastError\)/);
  assert.match(page, /Billing\.billingRetryable\(error\)/);
  assert.match(page, /wrapped\.code =/);
  assert.match(admin, /billingErrorCopy\(error, \{ staff: true \}\)/);
});

test('the billing server uses the namespaced Admin SDK it is written for', () => {
  const pkg = JSON.parse(read('functions/package.json'));
  assert.match(pkg.dependencies['firebase-admin'], /^\^13\./,
    'firebase-admin 14 removed admin.firestore(); the billing code is namespaced');
  const index = read('functions/index.js');
  assert.match(index, /if \(!admin\.apps\.length\)/);
  assert.doesNotMatch(index, /admin\.getApps\(/);
  assert.match(index, /ignoreUndefinedProperties: true/);
});

test('browser and server catalogues contain the same 11 plans', () => {
  const browserIds = Array.from(browser.PLANS, (plan) => plan.id).sort();
  const serverIds = Array.from(server.PLANS, (plan) => plan.id).sort();
  assert.deepEqual(browserIds, serverIds);
  assert.equal(browserIds.length, 11);
  assert.deepEqual(browserIds, Object.keys(EXPECTED_PRICES).sort());
});

test('every price, currency and programme length matches exactly', () => {
  for (const plan of server.PLANS) {
    const mirror = browser.PLANS.filter((row) => row.id === plan.id)[0];
    assert.ok(mirror, `browser is missing ${plan.id}`);
    assert.equal(mirror.price, plan.price, `${plan.id} price drift`);
    assert.equal(mirror.price, EXPECTED_PRICES[plan.id], `${plan.id} is not the agreed price`);
    assert.equal(mirror.currency, 'USD');
    assert.equal(mirror.billingPeriod, 'monthly');
    assert.equal(mirror.durationMonths, 1);
    assert.equal(mirror.programMonths, 12);
    assert.ok(['Education', 'Business', 'Compassion'].includes(mirror.program));
    assert.ok(mirror.claimType);
    assert.ok(mirror.name.indexOf('·') !== -1);
    assert.ok(mirror.benefits.length >= 3);
    assert.ok(mirror.summary.length > 20);
  }
});

test('the callable refuses to trust browser pricing', () => {
  const source = read('functions/billing.js');
  assert.match(source, /loadPlan\(data\.planId/);
  assert.match(source, /charge = Number\(plan\.price\)/);
  assert.doesNotMatch(source, /charge\s*=\s*Number\(data\.amount\)[\s\S]{0,40}kind === 'subscription'/);
  assert.match(source, /requireAdmin\(context\)/);
  assert.match(source, /payment\.approve/);
  assert.match(source, /payment\.reject/);
});

test('payment collections are server-write-only', () => {
  const rules = read('firestore.rules');
  for (const collection of ['paymentRequests', 'subscriptions', 'walletTransactions', 'billingAudit']) {
    const pattern = new RegExp('match /' + collection + '/\\{[^}]+\\}[\\s\\S]{0,600}allow write: if false');
    assert.match(rules, pattern, `${collection} must deny client writes`);
  }
  assert.match(rules, /match \/wallets\/\{userId\}[\s\S]{0,1200}affectedKeys\(\)\.hasOnly\(\['pin'\]\)/);
  assert.match(rules, /match \/wallets\/\{userId\}[\s\S]{0,700}balance == 0/);
});

test('receipts upload to private Storage and are opened through a signed URL', () => {
  const rules = read('storage.rules');
  assert.match(rules, /match \/billingEvidence\/\{uid\}\/\{fileName\}/);
  assert.match(rules, /allow read:[\s\S]{0,160}request\.auth\.uid == uid/);
  assert.match(rules, /match \/\{allPaths=\*\*\}/);
  assert.match(rules, /allow read, write: if false/);
  const support = read('support.html');
  assert.match(support, /uploadBytes\(storageRef\(storage, path\)/);
  assert.match(support, /billingEvidence\//);
  assert.match(support, /evidence\.signedUrl/);
  assert.doesNotMatch(support, /preset: 'gallery_uploads',\s*\n\s*maxBytes: 5000000[\s\S]{0,120}evidenceUrl/);
  const billing = read('functions/billing.js');
  assert.match(billing, /getSignedUrl\(/);
  assert.match(billing, /evidencePath/);
});

test('the support page loads the shared billing catalogue and confirmations', () => {
  const support = read('support.html');
  assert.match(support, /\/assets\/pd-billing\.js/);
  assert.match(support, /checkoutReceiptInput/);
  assert.match(support, /submitCheckoutEvidence/);
  assert.match(support, /paymentRequests/);
  assert.match(support, /financial/i);
  assert.match(support, /Cancel plan/);
  assert.match(support, /evidence\.signedUrl/);
});

test('the admin console exposes every billing workspace', () => {
  const admin = read('admin.html');
  for (const view of ['payment-verification', 'subscriptions', 'wallet-transactions', 'wallet-balances', 'support-plans', 'activity']) {
    assert.ok(admin.includes(`id="view-${view}"`), `missing #view-${view}`);
  }
  for (const target of ['paymentList', 'subscriptionList', 'walletTxList', 'walletList', 'supportPlanList', 'activityList']) {
    assert.ok(admin.includes(`id="${target}"`), `missing #${target}`);
  }
  assert.match(admin, /\/assets\/pd-billing-admin\.js/);
  assert.match(admin, /modalPaymentReview/);
});

test('the public verification page uses the server, never the register', () => {
  const verify = read('verify.html');
  assert.match(verify, /httpsCallable/);
  assert.match(verify, /verifyMembership/);
  assert.doesNotMatch(verify, /membershipVerificationRefs|membershipVerification/);
  assert.doesNotMatch(verify, /getDocs|getDoc\b/);
  assert.match(verify, /PRAYER DOME/);
});

test('membership cards and certificates print the fixed identity', () => {
  const membership = read('membership.html');
  assert.match(membership, /S\. K\. MASUKU/);
  assert.match(membership, /Founder and President/);
  assert.match(membership, /PRAYER DOME/);
  assert.match(membership, /downloadID\('front'\)|downloadID\("front"\)/);
  assert.match(membership, /downloadID\('back'\)|downloadID\("back"\)/);
  const certificate = read('assets/pd-certificate.js');
  assert.match(certificate, /S\. K\. MASUKU/);
  assert.match(certificate, /Founder and President/);
  assert.match(certificate, /administratorSignatureUrl/);
});
