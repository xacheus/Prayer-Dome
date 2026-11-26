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
    /\/api\/billing/
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

test('payment methods are configurable, scoped and never invented by a page', () => {
  const methods = browser.paymentMethodsFromSettings({
    mobileMoneyNumber: '+268 7600 0000',
    accountName: 'PRAYER DOME',
    network: 'MTN Mobile Money'
  });
  assert.equal(methods.length, 1, 'a legacy single-number document must still load');
  assert.equal(methods[0].type, 'mobile-money');
  assert.equal(methods[0].scope, 'both');
  assert.equal(browser.usablePaymentMethod(methods[0]), true);

  const scoped = browser.paymentMethodsFromSettings({
    methods: [
      { id: 'momo', type: 'mobile-money', label: 'MTN MoMo', number: '+26876000000', accountName: 'PRAYER DOME', enabled: true, scope: 'give', order: 2 },
      { id: 'bank', type: 'bank-transfer', label: 'Standard Bank', bankName: 'Standard Bank', accountNumber: '123456789', enabled: true, scope: 'support', order: 1 },
      { id: 'draft', type: 'mobile-money', label: 'Draft', number: '+268', enabled: false, scope: 'both', order: 3 }
    ]
  });
  assert.deepEqual(scoped.map((method) => method.id), ['bank', 'momo', 'draft'], 'order must be respected');
  assert.deepEqual(browser.paymentMethodsFor({ methods: scoped }, 'give').map((method) => method.id), ['momo']);
  assert.deepEqual(browser.paymentMethodsFor({ methods: scoped }, 'support').map((method) => method.id), ['bank']);
  assert.equal(browser.usablePaymentMethod({ type: 'bank-transfer', bankName: 'Standard Bank', accountNumber: '', enabled: true }), false);
  assert.equal(browser.usablePaymentMethod({ type: 'cash-office', instructions: 'Visit the office', enabled: true }), true);

  const billing = read('functions/billing.js');
  assert.match(billing, /PAYMENT_METHOD_TYPES = \['mobile-money', 'bank-transfer', 'cash-office', 'whatsapp', 'hosted-checkout'\]/);
  assert.match(billing, /function normalizePaymentMethod/);
  assert.match(billing, /function publicPaymentSettings/);
  assert.match(billing, /function requirePaymentSettings\(settings, methodId, scope\)/);
  assert.match(billing, /methods,\n\s*primaryMethodId/, 'saved settings must persist the methods list and its default');

  const give = read('give.html');
  assert.match(give, /getDoc\(doc\(db, 'settings', 'payments'\)\)/);
  assert.doesNotMatch(give, /payment\.settings\.public|firebase-functions/,
    'the give page must read payment settings without a Cloud Function');
  assert.match(give, /paymentMethodsFor\(settings, 'give'\)/);
  assert.match(give, /methodId: method\.id/);
  assert.match(give, /method: method\.label/);
  assert.doesNotMatch(give, /waPaymentNumber|momoPaymentNumber|momoAmt|waAmt/, 'no card may read a hardcoded element');
  assert.doesNotMatch(give, />\s*MTN MoMo\s*</, 'the method name must come from finance settings');

  const support = read('support.html');
  assert.match(support, /data-support-method/);
  assert.match(support, /methodId: selectedSupportMethodId/);
  assert.match(support, /paymentMethodsFor\(row, 'support'\)/);

  const admin = read('admin.html');
  const adminJs = read('assets/pd-billing-admin.js');
  assert.match(admin, /paymentMethodRows/);
  assert.match(adminJs, /addPaymentMethodRow/);
  assert.match(adminJs, /setDoc\(doc\(bridge\.db, 'settings', 'payments'\)/,
    'payment settings must be saved to Firestore');
  assert.match(adminJs, /Add at least one complete, enabled payment method/);
  // The callable is retained only as a one-release fallback while a preview is
  // newer than the deployed Firestore rules; it is not the primary write.
  assert.match(adminJs, /payment\.settings\.save/);
  assert.match(adminJs, /paymentMethodsFromSettings/);
});

test('the give page records the payment method the donor actually used', () => {
  const give = read('give.html');
  assert.match(give, /methodType: method\.type/);
  assert.match(give, /payTo: givingMethodNumber\(method\)/);
  assert.match(give, /currency: currency/);
  assert.match(give, /status: 'pending'/);
  assert.match(give, /Finance has not configured a payment method yet/);
  assert.match(give, /do not send money to any number that is not shown here/);
});

test('a newly added payment method is not wiped by a slow settings read', async () => {
  const { JSDOM } = require('jsdom');
  let resolveSettings;
  const settingsPromise = new Promise((resolve) => { resolveSettings = resolve; });
  let html = read('admin.html').replace(/<script[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://prayerdome.net/admin.html' });
  const window = dom.window;
  window.PDBilling = browser;
  window.PDAdmin = {
    db: {},
    auth: { currentUser: { uid: 'admin', email: 'admin@example.com' } },
    cloudFunctions: {},
    httpsCallable: () => async () => ({ data: {} }),
    firestore: {
      collection: () => ({}),
      getDocs: async () => ({ docs: [], size: 0 }),
      getDoc: () => settingsPromise,
      doc: () => ({}),
      setDoc: async () => {},
      addDoc: async () => {},
      serverTimestamp: () => ({}),
      query: () => ({}),
      orderBy: () => ({}),
      limit: () => ({})
    },
    toast: () => {}
  };
  vm.runInContext(read('assets/pd-billing-admin.js'), dom.getInternalVMContext(), { filename: 'pd-billing-admin.js' });

  const loading = window.loadPaymentSettings();
  assert.equal(window.document.querySelectorAll('#paymentMethodRows .payment-method-row').length, 0);
  window.addPaymentMethodRow();
  assert.equal(window.document.querySelectorAll('#paymentMethodRows .payment-method-row').length, 1,
    'the Add button must create a draft row immediately');
  resolveSettings({
    exists: () => true,
    data: () => ({
      methods: [{ id: 'saved-method', type: 'mobile-money', label: 'Saved', enabled: true, number: '+260970000000' }]
    })
  });
  await loading;
  const rows = window.document.querySelectorAll('#paymentMethodRows .payment-method-row');
  assert.equal(rows.length, 1, 'the slow read must not replace the draft row');
  assert.equal(rows[0].getAttribute('data-id'), '', 'the draft must not be replaced by the saved method');
  assert.match(window.document.getElementById('paySettingsStatus').textContent, /unsaved payment-method changes/i);
  dom.window.close();
});
