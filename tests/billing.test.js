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

test('the public verification page never lists the register', () => {
  const verify = read('verify.html');
  assert.match(verify, /membershipVerificationRefs/);
  assert.match(verify, /getDoc|\.get\b/);
  assert.doesNotMatch(verify, /getDocs|collection\(db, "membershipVerification"\)/);
  assert.match(verify, /PRAYER DOME/);
});

test('membership cards and certificates print the fixed identity', () => {
  const membership = read('membership.html');
  assert.match(membership, /SEEDWELL K\. KHAYALETHU MASUKU/);
  assert.match(membership, /Founder and President/);
  assert.match(membership, /PRAYER DOME/);
  assert.match(membership, /downloadID\('front'\)|downloadID\("front"\)/);
  assert.match(membership, /downloadID\('back'\)|downloadID\("back"\)/);
  const certificate = read('assets/pd-certificate.js');
  assert.match(certificate, /SEEDWELL K\. KHAYALETHU MASUKU/);
  assert.match(certificate, /Founder and President/);
  assert.match(certificate, /administratorSignatureUrl/);
});
