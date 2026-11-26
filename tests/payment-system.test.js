'use strict';
/*
 * End-to-end tests for the Vercel money system.
 *
 * The Firestore double below applies writes only when a transaction commits,
 * so these tests exercise the same atomic guarantees the real backend relies
 * on. No network calls and no real money are involved.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeDb {
  constructor() {
    this.documents = new Map();
    this.counter = 0;
    this.FieldValue = { serverTimestamp: () => ({ __serverTimestamp: true, value: Date.now() }) };
  }

  collection(name) {
    const db = this;
    const query = (state) => ({
      path: name,
      FieldValue: db.FieldValue,
      doc(id) { return db.doc(name + '/' + (id || ('auto-' + (++db.counter)))); },
      where(field, operator, value) {
        return query({ filters: (state.filters || []).concat([[field, operator, value]]) });
      },
      orderBy() { return query(state); },
      limit(count) { return query(Object.assign({}, state, { limit: count })); },
      get() {
        let docs = Array.from(db.documents.entries())
          .filter((entry) => entry[0].startsWith(name + '/'));
        for (const [field, operator, value] of state.filters || []) {
          docs = docs.filter((entry) => operator === 'in'
            ? Array.isArray(value) && value.includes(entry[1][field])
            : JSON.stringify(entry[1][field]) === JSON.stringify(value));
        }
        if (state.limit) docs = docs.slice(0, state.limit);
        const snapshots = docs.map((entry) => ({
          id: entry[0].split('/').pop(), data: () => clone(entry[1]), exists: true
        }));
        return Promise.resolve({
          empty: snapshots.length === 0,
          docs: snapshots,
          forEach(callback) { snapshots.forEach((snapshot) => callback(snapshot)); }
        });
      }
    });
    return query({});
  }

  doc(fullPath) {
    const db = this;
    const parts = String(fullPath).split('/');
    return {
      path: fullPath,
      id: parts[parts.length - 1],
      get() { return Promise.resolve(db.snapshot(fullPath)); },
      set(data, options) {
        const existing = db.documents.get(fullPath);
        db.documents.set(fullPath, options && options.merge && existing
          ? Object.assign({}, existing, clone(data)) : clone(data));
        return Promise.resolve();
      }
    };
  }

  snapshot(fullPath) {
    const value = this.documents.get(fullPath);
    return {
      id: fullPath.split('/').pop(),
      exists: value !== undefined,
      data: () => clone(value)
    };
  }

  put(fullPath, value) {
    this.documents.set(fullPath, clone(value));
    return this;
  }

  get(fullPath) {
    return this.documents.get(fullPath);
  }

  count(prefix) {
    return Array.from(this.documents.keys()).filter((key) => key.startsWith(prefix)).length;
  }

  async runTransaction(work) {
    const staged = clone(Array.from(this.documents.entries()));
    const self = this;
    const readAt = (fullPath) => {
      const value = staged.find((entry) => entry[0] === fullPath);
      return {
        id: fullPath.split('/').pop(),
        exists: Boolean(value),
        data: () => clone(value && value[1])
      };
    };
    const write = (ref, data, mode) => {
      const index = staged.findIndex((entry) => entry[0] === ref.path);
      const existing = index === -1 ? undefined : staged[index][1];
      if (mode === 'create' && existing !== undefined) throw new Error('Document already exists: ' + ref.path);
      if (mode === 'update' && existing === undefined) throw new Error('Document missing: ' + ref.path);
      const next = (mode === 'merge' || mode === 'update') && existing
        ? Object.assign({}, existing, clone(data))
        : clone(data);
      if (index === -1) staged.push([ref.path, next]);
      else staged[index][1] = next;
    };
    const transaction = {
      get: (ref) => Promise.resolve(readAt(ref.path)),
      create: (ref, data) => write(ref, data, 'create'),
      set: (ref, data, options) => write(ref, data, options && options.merge ? 'merge' : 'set'),
      update: (ref, data) => write(ref, data, 'update')
    };
    const result = await work(transaction);
    self.documents = new Map(staged);
    return result;
  }
}

const db = new FakeDb();
const tokens = {
  'member-token-000000000000000000000000': { uid: 'member-1', email: 'member@example.com', name: 'Test Member' },
  'admin-token-0000000000000000000000000': { uid: 'admin-1', email: 'admin@example.com', name: 'Test Admin', admin: true }
};
const fakeAdmin = {
  apps: [{}],
  firestore: () => ({
    collection: (name) => db.collection(name),
    doc: (id) => db.doc(id),
    runTransaction: (fn) => db.runTransaction(fn),
    batch: () => {
      const writes = [];
      return {
        set(ref, data, options) { writes.push(() => ref.set(data, options)); },
        async commit() { for (const write of writes) await write(); }
      };
    },
    settings: () => {},
    FieldValue: db.FieldValue
  }),
  auth: () => ({
    verifyIdToken: async (token) => {
      if (!tokens[token]) throw new Error('invalid token');
      return tokens[token];
    }
  }),
  credential: { cert: (value) => value },
  initializeApp: () => {},
  storage: () => ({ bucket: () => ({ file: () => ({ exists: async () => [false] }) }) })
};
fakeAdmin.firestore.FieldValue = db.FieldValue;

// Inject the double before loading the API; the real SDK is never contacted.
const adminPaths = [
  require.resolve('firebase-admin'),
  require.resolve('firebase-admin', { paths: [path.join(ROOT, 'functions')] })
];
for (const adminPath of adminPaths) {
  require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: fakeAdmin };
}
const system = require(path.join(ROOT, 'api/system.js'));
const server = require(path.join(ROOT, 'lib/billing-server.js'));

db.put('users/member-1', { fullName: 'Test Member', email: 'member@example.com' });
db.put('memberships/member-1', { status: 'approved', role: 'member', fullName: 'Test Member' });
db.put('users/admin-1', { fullName: 'Test Admin', email: 'admin@example.com' });
db.put('memberships/admin-1', { status: 'approved', role: 'admin', fullName: 'Test Admin' });
db.put('wallets/member-1', { userId: 'member-1', balance: 0, heldBalance: 0, currency: 'USD' });
db.put('settings/payments', {
  primaryMethodId: 'momo',
  methods: [
    { id: 'momo', type: 'mobile-money', label: 'MTN Mobile Money', number: '+26876000000', enabled: true, scope: 'both', order: 1 },
    { id: 'online', type: 'hosted-checkout', label: 'Hosted checkout', enabled: true, scope: 'both', order: 2, checkoutUrl: 'https://pay.example.org/checkout' }
  ]
});

function auth(token) {
  return { authorization: 'Bearer ' + token };
}

async function call(action, payload, token) {
  const req = {
    method: 'POST', url: '/api/system?op=billing',
    headers: Object.assign({ 'content-type': 'application/json' }, auth(token || 'member-token-000000000000000000000000')),
    body: Object.assign({ action }, payload || {})
  };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end() { this.body = arguments[0]; } };
  await system(req, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

async function webhook(body, signature) {
  const headers = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-pd-signature'] = signature;
  const req = { method: 'POST', url: '/api/system?op=payment-webhook', headers, body };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end() { this.body = arguments[0]; } };
  await system(req, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

function wallet() {
  return db.get('wallets/member-1') || { balance: 0, heldBalance: 0 };
}

test('a member can create, submit and verify a deposit exactly once', async () => {
  const plans = await call('plans.list', {}, 'member-token-000000000000000000000000');
  assert.equal(plans.status, 200, JSON.stringify(plans.body));
  assert.ok(plans.body.plans.length >= 11);

  const settings = await call('payment.settings.public', {}, 'member-token-000000000000000000000000');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.settings.configured, true);
  assert.equal(settings.body.settings.methods.length, 2);

  const created = await call('checkout.create', {
    kind: 'wallet_deposit', amount: 50, methodId: 'momo', idempotencyKey: 'deposit-lifecycle-1'
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const reference = created.body.reference;
  assert.match(reference, /^PD-WAL-\d{8}-[0-9A-F]{10}$/);
  assert.equal(created.body.payment.status, 'pending_payment');
  assert.equal(created.body.payment.amount, 50);
  assert.equal(created.body.payment.payToNumber, '+26876000000');

  const duplicate = await call('checkout.create', {
    kind: 'wallet_deposit', amount: 50, methodId: 'momo', idempotencyKey: 'deposit-lifecycle-1'
  });
  assert.equal(duplicate.body.alreadyCreated, true);
  assert.equal(duplicate.body.payment.reference, reference);
  assert.equal(db.count('paymentRequests/'), 1);

  // A double tap generates a fresh idempotency key in the browser; the server
  // must still recognise the open deposit for the same amount and channel.
  const secondTap = await call('checkout.create', {
    kind: 'wallet_deposit', amount: 50, methodId: 'momo', idempotencyKey: 'deposit-lifecycle-2'
  });
  assert.equal(secondTap.body.alreadyCreated, true);
  assert.equal(secondTap.body.payment.reference, reference);
  assert.equal(db.count('paymentRequests/'), 1);

  const evidence = await call('checkout.evidence', {
    reference, evidenceUrl: 'https://res.cloudinary.com/prayerdome/image/upload/billingEvidence/receipt.png', evidenceName: 'receipt.png'
  });
  assert.equal(evidence.status, 200, JSON.stringify(evidence.body));

  // Even after a receipt is uploaded, a fresh browser key must reuse the open
  // deposit instead of starting a second pending credit.
  const thirdTap = await call('checkout.create', {
    kind: 'wallet_deposit', amount: 50, methodId: 'momo', idempotencyKey: 'deposit-lifecycle-3'
  });
  assert.equal(thirdTap.body.alreadyCreated, true);
  assert.equal(thirdTap.body.payment.reference, reference);
  assert.equal(db.count('paymentRequests/'), 1);

  const memberApproval = await call('payment.approve', { reference, confirmed: true }, 'member-token-000000000000000000000000');
  assert.equal(memberApproval.status, 403, 'members must never approve their own payment');
  assert.equal(wallet().balance || 0, 0);

  const approved = await call('payment.approve', { reference, confirmed: true }, 'admin-token-0000000000000000000000000');
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(wallet().balance, 50, 'a verified deposit must credit the balance');
  const tx = db.get('walletTransactions/wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, ''));
  assert.equal(tx.status, 'approved');

  const again = await call('payment.approve', { reference, confirmed: true }, 'admin-token-0000000000000000000000000');
  assert.equal(again.body.alreadyApproved, true);
  assert.equal(wallet().balance, 50, 'a repeated approval must not credit twice');
});

test('withdrawals reserve funds, require an admin payout and release holds on rejection', async () => {
  const first = await call('withdrawal.request', {
    amount: 40, phone: '+26876123456', payoutMethodId: 'momo', idempotencyKey: 'withdraw-lifecycle-1'
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const reference = first.body.withdrawal.reference;
  assert.match(reference, /^PD-WD-\d{8}-[0-9A-F]{10}$/);
  assert.equal(first.body.withdrawal.status, 'pending_review');
  assert.equal(first.body.withdrawal.payoutMethodLabel, 'MTN Mobile Money');
  assert.equal(wallet().heldBalance, 40);
  assert.equal(wallet().balance, 50, 'a hold must not reduce the verified balance');

  const duplicate = await call('withdrawal.request', {
    amount: 40, phone: '+26876123456', payoutMethodId: 'momo', idempotencyKey: 'withdraw-lifecycle-1'
  });
  assert.equal(duplicate.body.alreadyCreated, true);
  assert.equal(db.count('withdrawals/'), 1);

  const tooMuch = await call('withdrawal.request', {
    amount: 100, phone: '+26876123456', payoutMethodId: 'momo', idempotencyKey: 'withdraw-too-much'
  });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error.message, /available balance/i);

  const unknownMethod = await call('withdrawal.request', {
    amount: 10, phone: '+26876123456', payoutMethodId: 'not-approved', idempotencyKey: 'withdraw-bad-method'
  });
  assert.equal(unknownMethod.status, 400);

  const review = await call('withdrawal.review', { reference }, 'admin-token-0000000000000000000000000');
  assert.equal(review.status, 200);
  assert.equal(review.body.status, 'under_review');
  const approved = await call('withdrawal.approve', { reference }, 'admin-token-0000000000000000000000000');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'processing');
  assert.equal(wallet().balance, 50, 'approval alone must not deduct money');

  const memberPaid = await call('withdrawal.paid', {
    reference, paidReference: 'MOMO-123', confirmed: true
  }, 'member-token-000000000000000000000000');
  assert.equal(memberPaid.status, 403, 'only an administrator can record a payout');

  const paid = await call('withdrawal.paid', {
    reference, paidReference: 'MOMO-123', confirmed: true
  }, 'admin-token-0000000000000000000000000');
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(wallet().balance, 10);
  assert.equal(wallet().heldBalance, 0);
  const again = await call('withdrawal.paid', {
    reference, paidReference: 'MOMO-999', confirmed: true
  }, 'admin-token-0000000000000000000000000');
  assert.equal(again.body.alreadyPaid, true);
  assert.equal(wallet().balance, 10, 'a repeated payout must not deduct twice');

  const rejected = await call('withdrawal.request', {
    amount: 10, phone: '+26876123456', payoutMethodId: 'momo', idempotencyKey: 'withdraw-reject'
  });
  const rejectRef = rejected.body.withdrawal.reference;
  assert.equal(wallet().heldBalance, 10);
  const reject = await call('withdrawal.reject', { reference: rejectRef, reason: 'Account mismatch' }, 'admin-token-0000000000000000000000000');
  assert.equal(reject.status, 200);
  assert.equal(wallet().heldBalance, 0, 'rejection must release the hold');
  assert.equal(wallet().balance, 10, 'rejection must not change the verified balance');

  const cancelled = await call('withdrawal.request', {
    amount: 10, phone: '+26876123456', payoutMethodId: 'momo', idempotencyKey: 'withdraw-cancel'
  });
  const cancelRef = cancelled.body.withdrawal.reference;
  const cancel = await call('withdrawal.cancel', { reference: cancelRef });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'cancelled');
  assert.equal(wallet().heldBalance, 0);
  assert.equal(wallet().balance, 10);
});

test('a signature-verified provider webhook confirms a hosted checkout once', async () => {
  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  process.env.PAYMENT_WEBHOOK_SECRET = 'whsec_test_only_0123456789';
  try {
    const checkout = await call('checkout.create', {
      kind: 'wallet_deposit', amount: 25, methodId: 'online', idempotencyKey: 'webhook-deposit-1'
    });
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    assert.equal(checkout.body.payment.payToType, 'hosted-checkout');
    const reference = checkout.body.reference;
    const event = {
      eventId: 'evt_lifecycle_1', reference, providerReference: 'PRV-998877',
      amount: 25, currency: 'USD', status: 'paid'
    };
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET)
      .update(JSON.stringify(event)).digest('hex');

    const noSignature = await webhook(event, null);
    assert.equal(noSignature.status, 401, 'unsigned events must be rejected');

    const badSignature = await webhook(event, 'sha256=' + '0'.repeat(64));
    assert.equal(badSignature.status, 401, 'a forged signature must be rejected');

    const tampered = await webhook(Object.assign({}, event, { amount: 9999 }), signature);
    assert.equal(tampered.status, 401, 'a signature made for a different body must fail');
    assert.equal(db.get('paymentRequests/' + reference).status, 'pending_payment');

    const before = wallet().balance;
    const confirmed = await webhook(event, signature);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(db.get('paymentRequests/' + reference).status, 'approved');
    assert.equal(wallet().balance, before + 25);

    const replay = await webhook(event, signature);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.alreadyProcessed, true);
    assert.equal(wallet().balance, before + 25, 'a replayed event must not credit twice');
  } finally {
    if (originalSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;
  }
});

test('a browser cannot call the webhook-only action and the gateway requires auth', async () => {
  const forged = await call('payment.webhook', {
    reference: 'PD-WAL-20260101-AAAAAAAAAA', eventId: 'x', providerReference: 'x',
    amount: 1, currency: 'USD', outcome: 'paid'
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'invalid-argument');

  const req = {
    method: 'POST', url: '/api/system?op=billing',
    headers: { 'content-type': 'application/json' },
    body: { action: 'checkout.create', kind: 'wallet_deposit', amount: 5 }
  };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end() { this.body = arguments[0]; } };
  await system(req, response);
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error.code, 'unauthenticated');
});

test('rate limiting is enforced per caller and action', () => {
  const first = server.rateLimit('test|key|action', 1, 60000);
  const second = server.rateLimit('test|key|action', 1, 60000);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfter >= 1);
});

test('support and admin pages no longer call a Google Cloud Function for money', () => {
  const support = read('support.html');
  const admin = read('admin.html');
  const client = read('assets/pd-billing-client.js');
  const gateway = read('lib/billing-server.js');
  const billingAdmin = read('assets/pd-billing-admin.js');
  assert.doesNotMatch(support, /firebase-functions|httpsCallable|getFunctions/);
  assert.doesNotMatch(client, /cloudfunctions\.net|httpsCallable|firebase-functions/);
  assert.doesNotMatch(billingAdmin, /httpsCallable/);
  assert.match(support, /\/assets\/pd-billing-client\.js/);
  assert.match(admin, /\/assets\/pd-billing-client\.js/);
  assert.match(client, /\/api\/billing/);
  assert.doesNotMatch(client, /private_key|client_email|FIREBASE_SERVICE_ACCOUNT|PAYMENT_WEBHOOK_SECRET/);
  assert.match(gateway, /verifyIdToken/);
  assert.match(gateway, /timingSafeEqual/);
  const source = read('functions/billing.js');
  assert.doesNotMatch(source, /require\(['"]firebase-functions/);
  assert.doesNotMatch(source, /functions\.region|onCall|pubsub\.schedule/);
  const index = read('functions/index.js');
  assert.doesNotMatch(index, /exports\.billing\b|expireSupportSubscriptions/);
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.rewrites.some((rule) => rule.source === '/api/billing' &&
    rule.destination === '/api/system?op=billing'));
  assert.ok(vercel.rewrites.some((rule) => rule.source === '/api/payment-webhook' &&
    rule.destination === '/api/system?op=payment-webhook'));
  assert.match(vercel.functions['api/*.js'].includeFiles, /functions\/billing\*\.js/);
  assert.ok(vercel.functions['api/*.js'].includeFiles.length <= 256,
    'Vercel rejects includeFiles patterns longer than 256 characters');
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter((name) => name.endsWith('.js'));
  assert.ok(files.length <= 12, 'Vercel Hobby deployments allow 12 serverless functions');
});
