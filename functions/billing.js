'use strict';
/*
 * Support-plan billing and wallet credits
 * ---------------------------------------------------------------------------
 * Every money change happens here, behind a server-controlled action handler.
 * The browser can read a plan catalogue, but it can never create an active
 * subscription, mark a payment approved, or move a wallet balance.
 *
 * This module deliberately contains NO firebase-functions import. The money
 * path is served by the Vercel endpoint `api/billing-server.js`; importing a
 * Cloud Functions SDK here used to make every support payment depend on a
 * deployed, billable Google Cloud function. The handler's errors keep the
 * HttpsError shape so existing clients and tests can map them safely.
 *
 * Lifecycle
 *   catalogue -> pending_payment -> pending_verification -> approved
 *   subscription: pending_payment -> active -> expired
 *   wallet:       pending_payment -> approved (credited exactly once)
 *
 * A payment screenshot is never proof on its own: an administrator must open
 * the receipt, check it against the ministry account, and explicitly confirm
 * the verification before the transaction runs. A verified provider webhook is
 * the only other trusted confirmation, and it must pass signature validation
 * and amount/reference matching in the Vercel webhook gateway first.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');
const catalog = require('./billing-catalog');

const CURRENCY = 'USD';
const MIN_WALLET_DEPOSIT = 5;
const MIN_WITHDRAWAL = 10;
const PAYMENT_SETTINGS_DOC = 'settings/payments';
const MAX_AMOUNT = 1000000;

class BillingError extends Error {
  constructor(code, message, details) {
    super(String(message || 'Billing request failed.'));
    this.name = 'HttpsError';
    this.code = code;
    this.details = details;
  }
}
const HttpsError = BillingError;

function fail(code, message, details) {
  // The marker lets the browser tell a real server decision ("that payment
  // belongs to another member") from a transport/deployment failure with the
  // same gRPC code. Without it every not-found or permission-denied would look
  // like a missing function.
  throw new HttpsError(code, message, Object.assign({ billing: true }, details || {}));
}

function isHttpsError(error) {
  // A Firestore transaction can propagate an error across a retry boundary.
  // Match the class first, then its shape, so a real business rule is never
  // reported to the member as an opaque internal failure.
  return error instanceof HttpsError ||
    (error && (error.name === 'HttpsError' || (error.constructor && error.constructor.name === 'HttpsError')));
}

function requireAuth(context) {
  if (!context || !context.auth || !context.auth.uid) {
    fail('unauthenticated', 'Sign in to continue.');
  }
  return context.auth.uid;
}

async function isAdmin(uid) {
  if (!uid) return false;
  const db = admin.firestore();
  try {
    const [membership, user] = await Promise.all([
      db.collection('memberships').doc(uid).get(),
      db.collection('users').doc(uid).get()
    ]);
    return (membership.exists && membership.data().role === 'admin') ||
      (user.exists && user.data().role === 'admin');
  } catch (error) {
    console.error('Admin check failed:', error.message);
    return false;
  }
}

async function requireAdmin(context) {
  const uid = requireAuth(context);
  if (!(await isAdmin(uid))) fail('permission-denied', 'Only an administrator can perform this action.');
  return uid;
}

function actor(context) {
  const token = (context && context.auth && context.auth.token) || {};
  return {
    uid: (context && context.auth && context.auth.uid) || '',
    email: token.email || '',
    role: token.admin === true ? 'admin' : 'member'
  };
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 240);
}

function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_AMOUNT) {
    fail('invalid-argument', 'Enter a valid amount.');
  }
  return Math.round(number * 100) / 100;
}

/*
 * Official payment details live in settings/payments and are managed by the
 * finance team through the billing API. The document keeps a methods[]
 * list so the give page and member support page can offer every channel the
 * ministry actually owns. No number is ever stored in this repository: if
 * finance has not configured a usable method, checkout stops instead of
 * showing a number nobody verified.
 *
 * Legacy documents with only mobileMoneyNumber/accountName/network still work:
 * they are read as one mobile-money method and every save writes the new shape.
 */
const PAYMENT_METHOD_TYPES = ['mobile-money', 'bank-transfer', 'cash-office', 'whatsapp', 'hosted-checkout'];
const PAYMENT_METHOD_SCOPES = ['both', 'give', 'support'];
const PAYMENT_METHOD_LABELS = {
  'mobile-money': 'Mobile Money',
  'bank-transfer': 'Bank transfer',
  'cash-office': 'Cash at the ministry office',
  whatsapp: 'WhatsApp',
  'hosted-checkout': 'Hosted checkout'
};

function paymentMethodType(value) {
  const type = text(value, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return PAYMENT_METHOD_TYPES.includes(type) ? type : 'mobile-money';
}

function paymentMethodScope(value) {
  const scope = text(value, 20).toLowerCase();
  return PAYMENT_METHOD_SCOPES.includes(scope) ? scope : 'both';
}

function paymentMethodId(value, index) {
  const base = text(value, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'method-' + (Number(index) + 1);
}

function normalizePaymentMethod(value, index) {
  if (!value || typeof value !== 'object') return null;
  const type = paymentMethodType(value.type);
  const number = text(value.number, 40);
  const accountNumber = text(value.accountNumber, 60);
  const bankName = text(value.bankName, 120);
  const network = text(value.network, 80);
  const accountName = text(value.accountName, 120);
  const label = text(value.label, 80) || PAYMENT_METHOD_LABELS[type] || 'Payment method';
  const instructions = text(value.instructions, 1000);
  return {
    id: paymentMethodId(value.id, index),
    type,
    label,
    enabled: value.enabled !== false,
    scope: paymentMethodScope(value.scope),
    order: Number.isFinite(Number(value.order)) ? Math.max(0, Math.round(Number(value.order))) : Number(index) + 1,
    number,
    accountNumber,
    accountName,
    network,
    bankName,
    branchCode: text(value.branchCode, 40),
    swift: text(value.swift, 20),
    currency: text(value.currency, 8).toUpperCase() || 'SZL',
    checkoutUrl: text(value.checkoutUrl, 1000),
    instructions
  };
}

function methodCheckoutUrl(method) {
  const url = text(method && method.checkoutUrl, 1000);
  return /^https:\/\/[^\s]+$/i.test(url) ? url : '';
}

function usablePaymentMethod(method) {
  if (!method || method.enabled === false) return false;
  if (methodCheckoutUrl(method)) return true;
  if (method.type === 'bank-transfer') {
    return Boolean(method.bankName && method.accountNumber);
  }
  if (method.type === 'cash-office') {
    return Boolean(method.instructions || method.accountName);
  }
  return String(method.number || '').replace(/\D/g, '').length >= 9;
}

function paymentMethodLabel(method) {
  if (!method) return 'Payment method';
  return method.label || PAYMENT_METHOD_LABELS[method.type] || 'Payment method';
}

function paymentMethodPayTo(method) {
  if (!method) return {};
  const isBank = method.type === 'bank-transfer';
  return {
    payToNumber: isBank ? method.accountNumber : method.number,
    payToName: method.accountName,
    payToNetwork: isBank ? method.bankName : (method.network || paymentMethodLabel(method)),
    payToType: method.type,
    payToMethodId: method.id,
    payToLabel: paymentMethodLabel(method),
    payToBankName: isBank ? method.bankName : '',
    payToBranchCode: isBank ? method.branchCode : '',
    payToSwift: isBank ? method.swift : '',
    payToCheckoutUrl: methodCheckoutUrl(method)
  };
}

function paymentMethodInstructions(method) {
  if (method && method.instructions) return method.instructions;
  if (!method) return catalog.PAYMENT_INSTRUCTIONS;
  if (method.type === 'bank-transfer') {
    return 'Transfer the exact amount to ' + (method.bankName || 'the ministry bank account') +
      (method.accountNumber ? ' (' + method.accountNumber + ')' : '') +
      (method.accountName ? ' in the name of ' + method.accountName : '') +
      '. Use the payment reference as the transfer reference, then upload a clear receipt. ' +
      'A plan is activated only after the finance team checks the payment against the ministry account.';
  }
  if (method.type === 'hosted-checkout') {
    return 'Open the secure hosted checkout, pay the exact amount, then enter the provider transaction reference and upload a receipt. ' +
      'A plan or gift is confirmed only after the finance team checks the provider record.';
  }
  if (method.type === 'cash-office') {
    return 'Take the exact amount to the ministry office. Give the finance team the payment reference, then upload a photo of the receipt. ' +
      'A plan is activated only after the finance team checks the receipt.';
  }
  if (method.type === 'whatsapp') {
    return 'Message the finance team on WhatsApp to arrange payment. Quote the payment reference and upload a clear receipt here. ' +
      'A plan is activated only after the finance team checks the payment.';
  }
  return 'Send the exact amount by ' + (method.network || 'Mobile Money') + ' to ' + (method.number || 'the official number') +
    (method.accountName ? ' (' + method.accountName + ')' : '') +
    '. Put the payment reference in the mobile-money reference field, then upload a clear receipt. ' +
    'A plan is activated only after the finance team checks the payment against the ministry account.';
}

function legacyPaymentMethod(data) {
  const number = text(data.mobileMoneyNumber, 40);
  if (!number) return null;
  return normalizePaymentMethod({
    id: 'official-mobile-money',
    type: 'mobile-money',
    label: text(data.network, 80) || PAYMENT_METHOD_LABELS['mobile-money'],
    enabled: true,
    scope: 'both',
    order: 1,
    number,
    accountName: text(data.accountName, 120),
    network: text(data.network, 80),
    instructions: text(data.instructions, 1000)
  }, 0);
}

async function loadPaymentSettings() {
  const db = admin.firestore();
  let data = {};
  try {
    const snap = await db.doc(PAYMENT_SETTINGS_DOC).get();
    data = snap.exists ? (snap.data() || {}) : {};
  } catch (error) {
    console.error('Payment settings read failed:', error.message);
    data = {};
  }
  const stored = Array.isArray(data.methods)
    ? data.methods.map(normalizePaymentMethod).filter(Boolean)
    : [];
  const legacy = legacyPaymentMethod(data);
  const methods = (stored.length ? stored : (legacy ? [legacy] : []))
    .sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label));
  const active = methods.filter(usablePaymentMethod);
  // The first enabled method is the default; finance controls it with the
  // move-up / move-down controls in the admin console.
  const primary = active[0] || methods[0] || {};
  const instructions = text(data.instructions, 1000) ||
    paymentMethodInstructions(primary.type ? primary : null);
  return {
    number: primary.number || '',
    accountName: primary.accountName || 'PRAYER DOME',
    network: primary.network || primary.bankName || paymentMethodLabel(primary),
    instructions,
    methods,
    primaryMethodId: primary.id || '',
    configured: active.length > 0
  };
}

function publicPaymentSettings(settings, scope) {
  if (!settings) return settings;
  const methods = (settings.methods || [])
    .filter(usablePaymentMethod)
    .filter(method => !scope || method.scope === 'both' || method.scope === scope);
  const primary = methods[0] || null;
  return Object.assign({}, settings, {
    // Never leak the top-level fallback fields for a method that was disabled
    // or is still incomplete. The public page gets only active methods.
    number: primary ? (primary.type === 'bank-transfer' ? primary.accountNumber : primary.number) : '',
    accountName: primary ? (primary.accountName || 'PRAYER DOME') : '',
    network: primary ? (primary.type === 'bank-transfer' ? primary.bankName : (primary.network || primary.label)) : '',
    instructions: primary ? paymentMethodInstructions(primary) : catalog.PAYMENT_INSTRUCTIONS,
    primaryMethodId: primary ? primary.id : '',
    configured: methods.length > 0,
    methods: methods.map(method => Object.assign({}, method, {
      instructions: paymentMethodInstructions(method)
    }))
  });
}

function requirePaymentSettings(settings, methodId, scope) {
  const methods = (settings && Array.isArray(settings.methods) ? settings.methods : [])
    .filter(usablePaymentMethod)
    .filter(method => !scope || method.scope === 'both' || method.scope === scope);
  if (!methods.length) {
    fail('failed-precondition',
      'No payment method has been configured in Finance settings yet. Please contact the ministry office before sending any money.');
  }
  const requested = text(methodId, 60);
  const selected = requested ? methods.find(method => method.id === requested) : null;
  if (requested && !selected) {
    fail('failed-precondition',
      'That payment method is no longer available. Refresh the page and choose another method before sending money.');
  }
  return selected || methods[0];
}

function addMonths(value, months) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  const targetMonth = date.getMonth() + Number(months || 0);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(targetMonth);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return date;
}

function newReference(kind) {
  const date = new Date();
  const stamp = String(date.getUTCFullYear()) +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0');
  const prefix = kind === 'wallet_deposit' ? 'PD-WAL'
    : kind === 'withdrawal' ? 'PD-WD'
      : 'PD-SUB';
  return prefix + '-' + stamp + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function subscriptionId(uid, planId) {
  return 'sub_' + String(uid).replace(/[^A-Za-z0-9_-]/g, '') + '_' +
    String(planId).replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

/* A second tap with a fresh idempotency key must not create another open
   deposit for the same amount and channel. Ten minutes is long enough to cover
   a slow checkout and short enough not to block a genuine repeat deposit after
   the first one has been paid or cancelled. */
const OPEN_DEPOSIT_WINDOW_MS = 10 * 60 * 1000;
async function findOpenDeposit(uid, charge, methodId) {
  const snapshot = await admin.firestore().collection('paymentRequests')
    .where('userId', '==', uid)
    .where('kind', '==', 'wallet_deposit')
    .where('status', 'in', ['pending_payment', 'pending_verification'])
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  let matches = [];
  snapshot.forEach((entry) => matches.push(entry.data() || {}));
  matches = matches.filter((row) => {
    const raw = row.createdAt;
    const created = raw && typeof raw.toDate === 'function' ? raw.toDate() : new Date(raw || 0);
    if (!Number.isFinite(created.getTime()) || Date.now() - created.getTime() > OPEN_DEPOSIT_WINDOW_MS) return false;
    return Math.round(Number(row.amount) * 100) / 100 === charge &&
      String(row.payToMethodId || '') === String(methodId || '');
  });
  return matches.length ? matches[0] : null;
}

function publicPlan(row) {
  return {
    id: row.id,
    name: row.name,
    program: row.program,
    claimType: row.claimType || row.program,
    tier: row.tier,
    price: row.price,
    currency: row.currency,
    billingPeriod: row.billingPeriod,
    durationMonths: row.durationMonths,
    programMonths: row.programMonths,
    order: row.order,
    active: row.active,
    theme: row.theme || '',
    summary: row.summary || '',
    benefits: row.benefits,
    paymentInstructions: row.paymentInstructions
  };
}

async function loadPlan(id, options) {
  const wanted = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{3,60}$/.test(wanted)) fail('invalid-argument', 'Choose a valid support plan.');
  const ref = admin.firestore().collection('supportPlans').doc(wanted);
  const snapshot = await ref.get();
  if (snapshot.exists) {
    const row = catalog.normalizePlan(snapshot.data(), wanted);
    if (row.active === false) fail('failed-precondition', 'This support plan is not open at the moment.');
    return row;
  }
  if (!options || options.create !== false) {
    const fallback = catalog.get(wanted);
    if (fallback) {
      const row = catalog.normalizePlan(fallback, wanted);
      // Seeding the catalogue is a convenience, not a precondition for taking
      // a payment. If the write is denied or the row is momentarily locked,
      // the standard plan is still a valid, server-priced choice.
      try {
        await ref.set(Object.assign({}, row, {
          source: 'standard-catalogue',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }), { merge: true });
      } catch (error) {
        console.warn('Plan catalogue seed skipped for ' + wanted + ':', error && error.message);
      }
      return row;
    }
  }
  fail('not-found', 'That support plan is no longer available.');
}

async function installPlans() {
  const db = admin.firestore();
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  catalog.PLANS.forEach((plan) => {
    const row = catalog.normalizePlan(plan, plan.id);
    batch.set(db.collection('supportPlans').doc(row.id), Object.assign({}, row, {
      source: 'standard-catalogue',
      createdAt: now,
      updatedAt: now
    }), { merge: true });
  });
  await batch.commit();
  return catalog.PLANS.length;
}

async function listPlans() {
  const db = admin.firestore();
  const snapshot = await db.collection('supportPlans').get();
  if (snapshot.empty) await installPlans();
  const fresh = snapshot.empty ? await db.collection('supportPlans').get() : snapshot;
  return fresh.docs
    .map((entry) => catalog.normalizePlan(entry.data(), entry.id))
    .filter((plan) => plan.active !== false)
    // A legacy or hand-edited plan row must never turn the catalogue into an
    // internal error just because its name is not a string.
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) ||
      String(a.name || '').localeCompare(String(b.name || '')))
    .map(publicPlan);
}

function paymentView(data) {
  return {
    reference: data.reference,
    kind: data.kind,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    planId: data.planId || '',
    planName: data.planName || '',
    program: data.program || '',
    tier: data.tier || '',
    method: data.method || 'mobile-money',
    billingPeriod: data.billingPeriod || '',
    durationMonths: data.durationMonths || 0,
    programMonths: data.programMonths || 0,
    planSnapshot: data.planSnapshot || null,
    paymentInstructions: data.paymentInstructions || '',
    payToNumber: data.payToNumber || '',
    payToName: data.payToName || '',
    payToNetwork: data.payToNetwork || '',
    payToType: data.payToType || '',
    payToMethodId: data.payToMethodId || '',
    payToLabel: data.payToLabel || '',
    payToBankName: data.payToBankName || '',
    payToBranchCode: data.payToBranchCode || '',
    payToSwift: data.payToSwift || '',
    payToCheckoutUrl: data.payToCheckoutUrl || '',
    evidenceUrl: data.evidenceUrl || '',
    evidencePath: data.evidencePath || '',
    evidenceName: data.evidenceName || '',
    evidenceType: data.evidenceType || '',
    createdAt: data.createdAt || null
  };
}

async function createCheckout(data, context) {
  const uid = requireAuth(context);
  // Some auth providers omit parts of the token object; never let a missing
  // display name turn a checkout into a bare internal error.
  const token = (context.auth && context.auth.token) || {};
  const db = admin.firestore();
  const kind = data.kind === 'wallet_deposit' ? 'wallet_deposit' : 'subscription';
  const key = text(data.idempotencyKey, 80) || crypto.randomBytes(12).toString('hex');
  const idemRef = db.collection('billingIdempotency').doc(uid + '_' + key.replace(/[^A-Za-z0-9_.-]/g, ''));

  const userSnap = await db.collection('users').doc(uid).get();
  const memberSnap = await db.collection('memberships').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : {};
  const member = memberSnap.exists ? memberSnap.data() : {};
  if (member.status && member.status !== 'approved') {
    fail('failed-precondition', 'Your membership must be approved before you start a support plan.');
  }

  let plan = null;
  let charge = 0;
  if (kind === 'subscription') {
    plan = await loadPlan(data.planId, { create: true });
    charge = Number(plan.price);
  } else {
    charge = amount(data.amount);
    if (charge < MIN_WALLET_DEPOSIT) fail('invalid-argument', 'The minimum wallet deposit is $5.00.');
  }

  // The browser may choose a plan or a deposit amount, but it never supplies
  // the price of a plan and never supplies the number to pay. Both come from
  // the server-owned catalogue and the finance settings document.
  const paymentSettings = await loadPaymentSettings();

  const existingIdem = await idemRef.get();
  if (existingIdem.exists) {
    const previous = await db.collection('paymentRequests').doc(existingIdem.data().reference).get();
    if (previous.exists) {
      return {
        alreadyCreated: true,
        payment: paymentView(previous.data()),
        subscriptionId: previous.data().subscriptionId || '',
        walletTransactionId: previous.data().walletTransactionId || ''
      };
    }
  }

  if (kind === 'wallet_deposit') {
    const selectedDepositMethod = requirePaymentSettings(paymentSettings, data.methodId, 'support');
    const openDeposit = await findOpenDeposit(uid, charge, selectedDepositMethod.id);
    if (openDeposit) {
      return {
        alreadyCreated: true,
        payment: paymentView(openDeposit),
        subscriptionId: '',
        walletTransactionId: openDeposit.walletTransactionId || ''
      };
    }
  }

  const reference = newReference(kind);
  const now = new Date();
  const paymentRef = db.collection('paymentRequests').doc(reference);
  const subId = plan ? subscriptionId(uid, plan.id) : '';
  const subRef = plan ? db.collection('subscriptions').doc(subId) : null;
  const walletTxId = kind === 'wallet_deposit' ? 'wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const walletTxRef = walletTxId ? db.collection('walletTransactions').doc(walletTxId) : null;
  const auditRef = db.collection('billingAudit').doc();

  // Reuse one open checkout per plan. A double tap, a refresh or a second tab
  // must not create a second payment request for the same pending plan.
  if (subRef) {
    const openSub = await subRef.get();
    const openRef = openSub.exists ? text(openSub.data().pendingPaymentRef, 80) : '';
    if (openRef) {
      const openPayment = await db.collection('paymentRequests').doc(openRef).get();
      if (openPayment.exists && ['pending_payment', 'pending_verification'].includes(openPayment.data().status)) {
        return {
          alreadyCreated: true,
          payment: paymentView(openPayment.data()),
          subscriptionId: subId,
          walletTransactionId: openPayment.data().walletTransactionId || ''
        };
      }
    }
  }

  // Resolve the chosen channel only after the idempotency and open-checkout
  // checks: a retry of an existing request must still return that request even
  // if finance has since disabled the method.
  const payMethod = requirePaymentSettings(paymentSettings, data.methodId, 'support');
  const method = payMethod.type === 'whatsapp' ? 'mobile-money' : payMethod.type;
  const payTo = paymentMethodPayTo(payMethod);
  const paymentInstructions = paymentMethodInstructions(payMethod);

  await db.runTransaction(async (transaction) => {
    const currentIdem = await transaction.get(idemRef);
    if (currentIdem.exists) {
      const duplicate = await transaction.get(db.collection('paymentRequests').doc(currentIdem.data().reference));
      if (duplicate.exists) return;
    }
    // Firestore requires every read to happen before the first write.
    const subscriptionSnap = subRef ? await transaction.get(subRef) : null;
    const snapshot = {
      reference,
      kind,
      status: 'pending_payment',
      amount: charge,
      currency: CURRENCY,
      userId: uid,
      userName: text(user.fullName || member.fullName || token.name || user.email || 'Member', 140),
      userEmail: text(user.email || member.email || token.email || '', 180),
      method,
      planId: plan ? plan.id : '',
      planName: plan ? plan.name : 'Secure wallet deposit',
      program: plan ? plan.program : 'Wallet',
      claimType: plan ? plan.claimType : '',
      tier: plan ? plan.tier : '',
      billingPeriod: plan ? plan.billingPeriod : '',
      durationMonths: plan ? plan.durationMonths : 0,
      programMonths: plan ? plan.programMonths : 0,
      planSnapshot: plan ? publicPlan(plan) : null,
      paymentInstructions,
      ...payTo,
      subscriptionId: subId || '',
      walletTransactionId: walletTxId || '',
      evidenceUrl: '',
      evidenceName: '',
      evidenceType: '',
      evidenceUploadedAt: null,
      createdAt: now,
      updatedAt: now
    };
    transaction.create(paymentRef, snapshot);

    if (subRef) {
      const previous = subscriptionSnap && subscriptionSnap.exists ? subscriptionSnap.data() : null;
      const keepActive = previous && previous.status === 'active';
      transaction.set(subRef, {
        userId: uid,
        userName: snapshot.userName,
        userEmail: snapshot.userEmail,
        planId: plan.id,
        planName: plan.name,
        program: plan.program,
        claimType: plan.claimType || plan.program,
        tier: plan.tier,
        amount: charge,
        currency: CURRENCY,
        billingPeriod: plan.billingPeriod,
        durationMonths: plan.durationMonths,
        programMonths: plan.programMonths,
        status: keepActive ? 'active' : 'pending_payment',
        paymentVerified: keepActive ? true : false,
        pendingPaymentRef: reference,
        latestCheckoutAt: now,
        startDate: previous ? previous.startDate || null : null,
        activatedAt: previous ? previous.activatedAt || null : null,
        expiresAt: previous ? previous.expiresAt || null : null,
        renewalDate: previous ? previous.renewalDate || null : null,
        programExpiresAt: previous ? previous.programExpiresAt || null : null,
        createdAt: previous ? previous.createdAt || now : now,
        updatedAt: now
      }, { merge: true });
    }

    if (walletTxRef) {
      transaction.create(walletTxRef, {
        userId: uid,
        userName: snapshot.userName,
        type: 'deposit',
        direction: 'in',
        amount: charge,
        currency: CURRENCY,
        status: 'pending_payment',
        reference,
        method,
        paymentRef: reference,
        createdAt: now,
        updatedAt: now
      });
    }

    transaction.set(idemRef, {
      userId: uid,
      reference,
      kind,
      idempotencyKey: key,
      createdAt: now
    }, { merge: true });

    transaction.create(auditRef, {
      action: 'payment_created',
      paymentRef: reference,
      subscriptionId: subId || '',
      walletTransactionId: walletTxId || '',
      userId: uid,
      amount: charge,
      currency: CURRENCY,
      status: 'pending_payment',
      actorUid: uid,
      actorEmail: snapshot.userEmail,
      actorRole: actor(context).role,
      note: plan ? 'Checkout created for ' + plan.name : 'Wallet deposit checkout created',
      createdAt: now
    });
  });

  return {
    reference,
    subscriptionId: subId || '',
    walletTransactionId: walletTxId || '',
    payment: {
      reference,
      kind,
      status: 'pending_payment',
      amount: charge,
      currency: CURRENCY,
      planId: plan ? plan.id : '',
      planName: plan ? plan.name : 'Secure wallet deposit',
      program: plan ? plan.program : 'Wallet',
      tier: plan ? plan.tier : '',
      method,
      billingPeriod: plan ? plan.billingPeriod : '',
      durationMonths: plan ? plan.durationMonths : 0,
      programMonths: plan ? plan.programMonths : 0,
      planSnapshot: plan ? publicPlan(plan) : null,
      paymentInstructions,
      ...payTo
    }
  };
}

async function submitEvidence(data, context) {
  const uid = requireAuth(context);
  const reference = text(data.reference, 80).toUpperCase();
  const evidencePath = text(data.evidencePath, 320);
  const evidenceUrl = text(data.evidenceUrl, 1200);
  if (evidencePath) {
    // Firebase Storage is retired. A handful of old rows still carry a bucket
    // path; Finance can open those in the Firebase console while reviewing the
    // request, but a new submission must carry the Cloudinary https URL.
    fail('failed-precondition',
      'That receipt was uploaded to the retired Firebase Storage bucket. Attach a new receipt and submit it again.');
  }
  if (!/^https:\/\//i.test(evidenceUrl)) {
    fail('invalid-argument', 'Upload the payment evidence before submitting.');
  }
  const db = admin.firestore();
  const paymentRef = db.collection('paymentRequests').doc(reference);
  const auditRef = db.collection('billingAudit').doc();
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(paymentRef);
    if (!snapshot.exists) fail('not-found', 'That payment reference was not found.');
    const payment = snapshot.data();
    if (payment.userId !== uid) fail('permission-denied', 'This payment belongs to another member.');
    if (payment.status === 'approved' || payment.status === 'rejected') {
      fail('failed-precondition', 'This payment has already been reviewed.');
    }
    if (payment.status === 'cancelled') fail('failed-precondition', 'This checkout was cancelled.');
    if (payment.kind === 'subscription' && (!payment.planId || !payment.planName)) {
      fail('failed-precondition', 'This payment is not linked to a selected plan. Create the checkout again from the programme card.');
    }
    const submittedPlanId = text(data.planId, 80);
    if (payment.kind === 'subscription' && submittedPlanId && submittedPlanId !== payment.planId) {
      fail('invalid-argument', 'The selected plan does not match this payment reference. Open the checkout again and choose the plan.');
    }
    const subSnap = payment.subscriptionId
      ? await transaction.get(db.collection('subscriptions').doc(payment.subscriptionId))
      : null;
    transaction.update(paymentRef, {
      status: 'pending_verification',
      evidenceUrl: evidencePath ? '' : evidenceUrl,
      evidencePath: evidencePath || '',
      evidenceName: text(data.evidenceName, 200) || 'Payment receipt',
      evidenceType: text(data.evidenceType, 80) || 'image',
      evidenceUploadedAt: now,
      submittedAt: now,
      updatedAt: now
    });
    if (payment.subscriptionId) {
      const subRef = db.collection('subscriptions').doc(payment.subscriptionId);
      const active = subSnap && subSnap.exists && subSnap.data().status === 'active';
      transaction.set(subRef, active ? {
        lastPaymentStatus: 'pending_verification',
        pendingPaymentRef: reference,
        updatedAt: now
      } : {
        status: 'pending_verification',
        paymentVerified: false,
        pendingPaymentRef: reference,
        updatedAt: now
      }, { merge: true });
    }
    if (payment.walletTransactionId) {
      transaction.update(db.collection('walletTransactions').doc(payment.walletTransactionId), {
        status: 'pending_verification',
        evidenceUrl: evidencePath ? '' : evidenceUrl,
        evidencePath: evidencePath || '',
        updatedAt: now
      });
    }
    transaction.create(auditRef, {
      action: 'payment_evidence_submitted',
      paymentRef: reference,
      planId: payment.planId || '',
      planName: payment.planName || '',
      subscriptionId: payment.subscriptionId || '',
      walletTransactionId: payment.walletTransactionId || '',
      userId: uid,
      amount: payment.amount,
      currency: payment.currency,
      status: 'pending_verification',
      actorUid: uid,
      actorEmail: payment.userEmail || '',
      actorRole: 'member',
      note: 'Receipt uploaded for administrator verification',
      createdAt: now
    });
  });

  return { reference, status: 'pending_verification' };
}

async function approvePayment(data, context) {
  const adminUid = await requireAdmin(context);
  const adminActor = actor(context);
  if (data.confirmed !== true) {
    fail('failed-precondition', 'Confirm that you checked the payment against the ministry account.');
  }
  const reference = text(data.reference, 80).toUpperCase();
  const note = text(data.note, 500);
  const db = admin.firestore();
  const paymentRef = db.collection('paymentRequests').doc(reference);
  const auditRef = db.collection('billingAudit').doc();
  const now = new Date();
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(paymentRef);
    if (!snapshot.exists) fail('not-found', 'That payment reference was not found.');
    const payment = snapshot.data();
    if (payment.status === 'approved') {
      outcome = { reference, alreadyApproved: true, status: 'approved' };
      return;
    }
    if (payment.status !== 'pending_verification') {
      fail('failed-precondition', 'A payment can only be approved after its receipt is submitted for verification.');
    }
    if (!payment.evidenceUrl && !payment.evidencePath) {
      fail('failed-precondition', 'No payment evidence is attached. Never approve a receipt-free payment.');
    }

    if (payment.kind === 'subscription') {
      if (!payment.subscriptionId) fail('failed-precondition', 'The subscription record is missing.');
      const subRef = db.collection('subscriptions').doc(payment.subscriptionId);
      const subSnap = await transaction.get(subRef);
      if (!subSnap.exists) fail('not-found', 'The subscription record is missing.');
      const subscription = subSnap.data();
      if (subscription.userId !== payment.userId) fail('failed-precondition', 'Subscription ownership does not match the payment.');
      const termStart = subscription.expiresAt && subscription.expiresAt.toDate
        ? subscription.expiresAt.toDate()
        : (subscription.expiresAt ? new Date(subscription.expiresAt) : null);
      const start = termStart && termStart.getTime() > now.getTime() ? termStart : now;
      const months = Number(payment.durationMonths || payment.planSnapshot && payment.planSnapshot.durationMonths || 1) || 1;
      const expires = addMonths(start, months);
      const programMonths = Number(payment.programMonths || payment.planSnapshot && payment.planSnapshot.programMonths || 12) || 12;
      const programExpires = addMonths(now, programMonths);

      transaction.update(subRef, {
        status: 'active',
        paymentVerified: true,
        paymentRef: payment.reference,
        pendingPaymentRef: '',
        startDate: subscription.startDate || now,
        activatedAt: now,
        expiresAt: expires,
        renewalDate: expires,
        programExpiresAt: subscription.programExpiresAt || programExpires,
        lastPaymentAmount: payment.amount,
        lastPaymentAt: now,
        verifiedBy: adminActor.email || adminUid,
        verificationNote: note,
        updatedAt: now
      });
      outcome = {
        reference,
        status: 'active',
        subscriptionId: payment.subscriptionId,
        startsAt: now.toISOString(),
        expiresAt: expires.toISOString()
      };
    } else if (payment.kind === 'wallet_deposit') {
      const walletRef = db.collection('wallets').doc(payment.userId);
      const walletSnap = await transaction.get(walletRef);
      const balance = walletSnap.exists ? Number(walletSnap.data().balance) || 0 : 0;
      const newBalance = Math.round((balance + Number(payment.amount)) * 100) / 100;
      transaction.set(walletRef, {
        userId: payment.userId,
        balance: newBalance,
        currency: CURRENCY,
        updatedAt: now,
        updatedBy: adminActor.email || adminUid
      }, { merge: true });
      if (payment.walletTransactionId) {
        transaction.update(db.collection('walletTransactions').doc(payment.walletTransactionId), {
          status: 'approved',
          balanceAfter: newBalance,
          approvedAt: now,
          approvedBy: adminActor.email || adminUid,
          verificationNote: note,
          updatedAt: now
        });
      }
      outcome = {
        reference,
        status: 'approved',
        walletTransactionId: payment.walletTransactionId || '',
        balance: newBalance
      };
    } else {
      fail('failed-precondition', 'Unknown payment type.');
    }

    transaction.update(paymentRef, {
      status: 'approved',
      approvedAt: now,
      approvedBy: adminActor.email || adminUid,
      verifiedByUid: adminUid,
      verificationNote: note,
      updatedAt: now
    });
    transaction.create(auditRef, {
      action: 'payment_approved',
      paymentRef: reference,
      subscriptionId: payment.subscriptionId || '',
      walletTransactionId: payment.walletTransactionId || '',
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.currency,
      status: 'approved',
      actorUid: adminUid,
      actorEmail: adminActor.email || '',
      actorRole: 'admin',
      note
    });
  });

  return outcome || { reference, status: 'approved' };
}

/*
 * Provider-confirmed checkout. This entry point is only reachable from the
 * Vercel webhook gateway after it has validated the provider's HMAC signature.
 * A browser cannot call it: the gateway passes a `webhook: true` context that
 * no client request can set. Even then, the event must name an existing hosted
 * checkout, the same amount and currency, and a fresh event id.
 */
async function confirmProviderPayment(data, context) {
  if (!context || context.webhook !== true) {
    fail('permission-denied', 'Provider confirmations must arrive through the verified webhook endpoint.');
  }
  const reference = text(data.reference, 80).toUpperCase();
  const eventId = text(data.eventId, 160);
  const providerReference = text(data.providerReference, 160);
  if (!reference || !eventId || !providerReference) {
    fail('invalid-argument', 'The provider event is incomplete.');
  }
  const eventKey = crypto.createHash('sha256').update(eventId + '|' + reference).digest('hex');
  const db = admin.firestore();
  const paymentRef = db.collection('paymentRequests').doc(reference);
  const eventRef = db.collection('paymentWebhookEvents').doc(eventKey);
  const now = new Date();
  const outcomeStatus = text(data.outcome, 20).toLowerCase();
  const failed = ['failed', 'cancelled', 'canceled', 'reversed', 'refunded'].includes(outcomeStatus);
  const succeeded = ['paid', 'success', 'successful', 'completed'].includes(outcomeStatus);
  if (!failed && !succeeded) fail('invalid-argument', 'The provider event has no recognised outcome.');
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const [paymentSnap, eventSnap] = await Promise.all([
      transaction.get(paymentRef),
      transaction.get(eventRef)
    ]);
    if (!paymentSnap.exists) fail('not-found', 'That payment reference was not found.');
    const payment = paymentSnap.data() || {};
    if (eventSnap.exists) {
      outcome = { reference, status: eventSnap.data().paymentStatus || (failed ? 'failed' : 'approved'), alreadyProcessed: true };
      return;
    }
    if (payment.status === 'approved' || payment.status === 'active' || payment.status === 'failed') {
      outcome = { reference, status: payment.status, alreadyProcessed: true };
      return;
    }
    if (!['pending_payment', 'pending_verification'].includes(payment.status)) {
      fail('failed-precondition', 'This checkout is no longer open for provider confirmation.');
    }
    if (payment.payToType !== 'hosted-checkout' && payment.method !== 'hosted-checkout') {
      fail('failed-precondition', 'This payment method cannot be confirmed by a provider webhook.');
    }
    const paidAmount = Math.round(Number(data.amount) * 100) / 100;
    const paidCurrency = text(data.currency, 8).toUpperCase();
    if (!Number.isFinite(paidAmount) || paidAmount !== Math.round(Number(payment.amount) * 100) / 100 ||
        paidCurrency !== text(payment.currency || CURRENCY, 8).toUpperCase()) {
      fail('failed-precondition', 'The provider amount does not match this payment reference.');
    }

    const auditRef = db.collection('billingAudit').doc();
    if (failed) {
      transaction.update(paymentRef, {
        status: outcomeStatus === 'cancelled' || outcomeStatus === 'canceled' ? 'cancelled' : 'failed',
        providerReference,
        providerEventId: eventId,
        providerFailureReason: text(data.reason, 300) || 'Provider reported an unsuccessful payment',
        updatedAt: now
      });
      if (payment.walletTransactionId) {
        transaction.update(db.collection('walletTransactions').doc(payment.walletTransactionId), {
          status: 'failed', providerReference, updatedAt: now
        });
      }
      if (payment.subscriptionId) {
        transaction.update(db.collection('subscriptions').doc(payment.subscriptionId), {
          status: 'failed', lastPaymentStatus: 'failed', pendingPaymentRef: '', updatedAt: now
        }, { merge: true });
      }
      transaction.create(eventRef, {
        eventId, reference, providerReference, paymentStatus: 'failed', createdAt: now
      });
      transaction.create(auditRef, {
        action: 'payment_provider_failed',
        paymentRef: reference,
        subscriptionId: payment.subscriptionId || '',
        walletTransactionId: payment.walletTransactionId || '',
        userId: payment.userId,
        amount: payment.amount,
        currency: payment.currency || CURRENCY,
        status: 'failed',
        actorUid: 'webhook',
        actorEmail: 'provider-webhook',
        actorRole: 'system',
        note: 'Verified provider event reported an unsuccessful payment: ' + providerReference,
        createdAt: now
      });
      outcome = { reference, status: 'failed', alreadyProcessed: false };
      return;
    }

    // Atomic confirmation: only the transaction that finds an open payment can
    // credit the wallet or activate the plan, and the same event id can never
    // be processed a second time.
    const verifiedBy = 'provider-webhook';
    if (payment.kind === 'wallet_deposit') {
      const walletRef = db.collection('wallets').doc(payment.userId);
      const walletSnap = await transaction.get(walletRef);
      const balance = walletSnap.exists ? Math.round((Number(walletSnap.data().balance) || 0) * 100) / 100 : 0;
      const newBalance = Math.round((balance + Number(payment.amount)) * 100) / 100;
      transaction.set(walletRef, {
        userId: payment.userId,
        balance: newBalance,
        currency: payment.currency || CURRENCY,
        updatedAt: now,
        updatedBy: verifiedBy
      }, { merge: true });
      if (payment.walletTransactionId) {
        transaction.update(db.collection('walletTransactions').doc(payment.walletTransactionId), {
          status: 'approved', balanceAfter: newBalance, approvedAt: now,
          approvedBy: verifiedBy, providerReference, updatedAt: now
        });
      }
      outcome = { reference, status: 'approved', balance: newBalance, walletTransactionId: payment.walletTransactionId || '' };
    } else if (payment.kind === 'subscription') {
      if (!payment.subscriptionId) fail('failed-precondition', 'The subscription record is missing.');
      const subRef = db.collection('subscriptions').doc(payment.subscriptionId);
      const subSnap = await transaction.get(subRef);
      if (!subSnap.exists) fail('not-found', 'The subscription record is missing.');
      const subscription = subSnap.data();
      if (subscription.userId !== payment.userId) fail('failed-precondition', 'Subscription ownership does not match the payment.');
      const months = Number(payment.durationMonths || payment.planSnapshot && payment.planSnapshot.durationMonths || 1) || 1;
      const expires = addMonths(now, months);
      transaction.update(subRef, {
        status: 'active',
        paymentVerified: true,
        paymentRef: reference,
        pendingPaymentRef: '',
        startDate: subscription.startDate || now,
        activatedAt: now,
        expiresAt: expires,
        renewalDate: expires,
        lastPaymentAmount: payment.amount,
        lastPaymentAt: now,
        verifiedBy,
        updatedAt: now
      }, { merge: true });
      outcome = { reference, status: 'active', subscriptionId: payment.subscriptionId, expiresAt: expires.toISOString() };
    } else {
      fail('failed-precondition', 'Unknown payment type.');
    }

    transaction.update(paymentRef, {
      status: 'approved',
      providerReference,
      providerEventId: eventId,
      approvedAt: now,
      approvedBy: verifiedBy,
      verifiedByUid: 'webhook',
      verificationNote: 'Confirmed by a signature-verified provider webhook: ' + providerReference,
      updatedAt: now
    });
    transaction.create(eventRef, {
      eventId, reference, providerReference, paymentStatus: 'approved', createdAt: now
    });
    transaction.create(auditRef, {
      action: 'payment_provider_confirmed',
      paymentRef: reference,
      subscriptionId: payment.subscriptionId || '',
      walletTransactionId: payment.walletTransactionId || '',
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.currency || CURRENCY,
      status: 'approved',
      actorUid: 'webhook',
      actorEmail: verifiedBy,
      actorRole: 'system',
      note: 'Provider-confirmed payment ' + providerReference,
      createdAt: now
    });
  });

  return outcome || { reference, status: 'approved' };
}

async function rejectPayment(data, context) {
  const adminUid = await requireAdmin(context);
  const adminActor = actor(context);
  const reference = text(data.reference, 80).toUpperCase();
  const reason = text(data.reason, 500);
  if (reason.length < 4) fail('invalid-argument', 'Give the member a reason for the rejection.');
  const db = admin.firestore();
  const paymentRef = db.collection('paymentRequests').doc(reference);
  const auditRef = db.collection('billingAudit').doc();
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(paymentRef);
    if (!snapshot.exists) fail('not-found', 'That payment reference was not found.');
    const payment = snapshot.data();
    if (payment.status === 'approved') fail('failed-precondition', 'An approved payment cannot be rejected.');
    if (payment.status === 'rejected') return;
    if (payment.status !== 'pending_verification' && payment.status !== 'pending_payment') {
      fail('failed-precondition', 'Only an open payment can be rejected.');
    }
    const subSnap = payment.subscriptionId
      ? await transaction.get(db.collection('subscriptions').doc(payment.subscriptionId))
      : null;

    transaction.update(paymentRef, {
      status: 'rejected',
      rejectedAt: now,
      rejectedBy: adminActor.email || adminUid,
      rejectionReason: reason,
      updatedAt: now
    });

    if (payment.subscriptionId) {
      const subRef = db.collection('subscriptions').doc(payment.subscriptionId);
      if (subSnap && subSnap.exists) {
        const subscription = subSnap.data();
        const stillActive = subscription.status === 'active' && subscription.paymentRef !== reference;
        transaction.update(subRef, {
          status: stillActive ? 'active' : 'rejected',
          paymentVerified: stillActive,
          pendingPaymentRef: '',
          lastPaymentStatus: 'rejected',
          lastRejectionReason: reason,
          updatedAt: now
        });
      }
    }
    if (payment.walletTransactionId) {
      transaction.update(db.collection('walletTransactions').doc(payment.walletTransactionId), {
        status: 'rejected',
        rejectedAt: now,
        rejectedBy: adminActor.email || adminUid,
        rejectionReason: reason,
        updatedAt: now
      });
    }
    transaction.create(auditRef, {
      action: 'payment_rejected',
      paymentRef: reference,
      subscriptionId: payment.subscriptionId || '',
      walletTransactionId: payment.walletTransactionId || '',
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.currency,
      status: 'rejected',
      actorUid: adminUid,
      actorEmail: adminActor.email || '',
      actorRole: 'admin',
      note: reason
    });
  });

  return { reference, status: 'rejected' };
}

async function cancelCheckout(data, context) {
  const uid = requireAuth(context);
  const reference = text(data.reference, 80).toUpperCase();
  const db = admin.firestore();
  const paymentRef = db.collection('paymentRequests').doc(reference);
  const now = new Date();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(paymentRef);
    if (!snapshot.exists) fail('not-found', 'That payment reference was not found.');
    const payment = snapshot.data();
    if (payment.userId !== uid) fail('permission-denied', 'This payment belongs to another member.');
    if (payment.status !== 'pending_payment') {
      fail('failed-precondition', 'This checkout can no longer be cancelled from the member page.');
    }
    const subSnap = payment.subscriptionId
      ? await transaction.get(db.collection('subscriptions').doc(payment.subscriptionId))
      : null;
    transaction.update(paymentRef, { status: 'cancelled', cancelledAt: now, updatedAt: now });
    if (payment.subscriptionId) {
      const subRef = db.collection('subscriptions').doc(payment.subscriptionId);
      if (subSnap && subSnap.exists && subSnap.data().status === 'pending_payment') {
        transaction.update(subRef, { status: 'cancelled', updatedAt: now });
      }
    }
    if (payment.walletTransactionId) {
      transaction.update(db.collection('walletTransactions').doc(payment.walletTransactionId), {
        status: 'cancelled', updatedAt: now
      });
    }
  });
  return { reference, status: 'cancelled' };
}

async function savePlan(data, context) {
  const adminUid = await requireAdmin(context);
  const plan = catalog.normalizePlan(data.plan || {}, data.plan && data.plan.id);
  if (!/^[a-z0-9-]{3,60}$/.test(plan.id)) fail('invalid-argument', 'Use a lowercase plan id with hyphens.');
  if (!plan.name || !plan.program) fail('invalid-argument', 'A plan needs a name and a programme.');
  if (!(plan.price > 0)) fail('invalid-argument', 'A plan needs a positive monthly price.');
  if (plan.currency !== CURRENCY) fail('invalid-argument', 'Support plans are priced in USD.');
  plan.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  plan.updatedBy = actor(context).email || adminUid;
  await admin.firestore().collection('supportPlans').doc(plan.id).set(plan, { merge: true });
  return { plan: publicPlan(plan) };
}

async function expireSubscriptions() {
  const db = admin.firestore();
  const snapshot = await db.collection('subscriptions').where('status', '==', 'active').limit(500).get();
  const now = new Date();
  const batch = db.batch();
  let expired = 0;
  snapshot.forEach((entry) => {
    const row = entry.data();
    const raw = row.expiresAt;
    const date = raw && raw.toDate ? raw.toDate() : (raw ? new Date(raw) : null);
    if (!date || date.getTime() >= now.getTime()) return;
    batch.update(entry.ref, {
      status: 'expired',
      expiredAt: now,
      updatedAt: now,
      lastPaymentStatus: row.lastPaymentStatus || 'expired'
    });
    expired += 1;
  });
  if (expired) await batch.commit();
  return expired;
}

async function cancelSubscription(data, context) {
  const uid = requireAuth(context);
  const subscriptionIdValue = text(data.subscriptionId, 160);
  if (!subscriptionIdValue) fail('invalid-argument', 'Choose a subscription to cancel.');
  const db = admin.firestore();
  const subRef = db.collection('subscriptions').doc(subscriptionIdValue);
  const snap = await subRef.get();
  if (!snap.exists) fail('not-found', 'That subscription was not found.');
  const row = snap.data();
  if (row.userId !== uid && !(await isAdmin(uid))) {
    fail('permission-denied', 'This subscription belongs to another member.');
  }
  if (['expired', 'cancelled'].includes(row.status)) return { subscriptionId: subscriptionIdValue, status: row.status };
  const now = new Date();
  const pending = ['pending_payment', 'pending_verification'].includes(row.status);
  await subRef.update({
    status: pending ? 'cancelled' : row.status,
    autoRenew: false,
    cancelAtPeriodEnd: !pending,
    cancellationReason: text(data.reason, 300) || 'Cancelled by the member',
    cancelledAt: now,
    updatedAt: now
  });
  await db.collection('billingAudit').add({
    action: pending ? 'subscription_cancelled' : 'subscription_cancel_scheduled',
    subscriptionId: subscriptionIdValue,
    userId: row.userId,
    planId: row.planId || '',
    actorUid: uid,
    actorEmail: actor(context).email || '',
    actorRole: uid === row.userId ? 'member' : 'admin',
    status: pending ? 'cancelled' : 'active',
    note: 'Cancellation recorded',
    at: now
  });
  return { subscriptionId: subscriptionIdValue, status: pending ? 'cancelled' : row.status, cancelAtPeriodEnd: !pending };
}

async function resumeSubscription(data, context) {
  const uid = requireAuth(context);
  const subscriptionIdValue = text(data.subscriptionId, 160);
  if (!subscriptionIdValue) fail('invalid-argument', 'Choose a subscription to resume.');
  const db = admin.firestore();
  const subRef = db.collection('subscriptions').doc(subscriptionIdValue);
  const snap = await subRef.get();
  if (!snap.exists) fail('not-found', 'That subscription was not found.');
  const row = snap.data();
  if (row.userId !== uid && !(await isAdmin(uid))) fail('permission-denied', 'This subscription belongs to another member.');
  if (row.status !== 'active') fail('failed-precondition', 'Only an active subscription can be resumed.');
  const now = new Date();
  await subRef.update({ autoRenew: true, cancelAtPeriodEnd: false, resumedAt: now, updatedAt: now });
  await db.collection('billingAudit').add({
    action: 'subscription_resumed',
    subscriptionId: subscriptionIdValue,
    userId: row.userId,
    planId: row.planId || '',
    actorUid: uid,
    actorEmail: actor(context).email || '',
    actorRole: uid === row.userId ? 'member' : 'admin',
    status: 'active',
    at: now
  });
  return { subscriptionId: subscriptionIdValue, status: 'active', cancelAtPeriodEnd: false };
}


/* ------------------------------------------------------------------ withdrawals
 * A withdrawal is a request, never a payment. The requested amount is placed
 * on hold so two open requests cannot spend the same money, but the verified
 * wallet balance is untouched. Only a finance administrator who has actually
 * sent the money may mark it paid, and that single transaction deducts the
 * balance exactly once. A rejection releases the hold and never deducts.
 */
function withdrawalReferenceId(value) {
  return text(value, 80).toUpperCase();
}

function publicWithdrawal(row) {
  return {
    reference: row.reference || '',
    userId: row.userId || '',
    userName: row.userName || '',
    userEmail: row.userEmail || '',
    amount: row.amount,
    currency: row.currency || CURRENCY,
    payoutMethodId: row.payoutMethodId || '',
    payoutMethodLabel: row.payoutMethodLabel || '',
    payoutMethodType: row.payoutMethodType || '',
    receivePhone: row.receivePhone || '',
    status: row.status || 'pending_review',
    requestedAt: row.requestedAt || null,
    reviewedAt: row.reviewedAt || null,
    paidAt: row.paidAt || null,
    paidReference: row.paidReference || '',
    rejectionReason: row.rejectionReason || ''
  };
}

/* Payout channels are a subset of the finance-configured methods: only money
   that can be sent back to a member (Mobile Money or a bank transfer) is
   eligible. The browser supplies an id, never account details of its own. */
function eligiblePayoutMethods(settings) {
  return (settings && Array.isArray(settings.methods) ? settings.methods : [])
    .filter(usablePaymentMethod)
    .filter((method) => ['mobile-money', 'bank-transfer'].includes(method.type));
}

async function requestWithdrawal(data, context) {
  const uid = requireAuth(context);
  const token = (context.auth && context.auth.token) || {};
  const db = admin.firestore();
  const value = amount(data.amount);
  if (value < MIN_WITHDRAWAL) fail('invalid-argument', 'The minimum withdrawal is $10.00.');
  const phone = text(data.phone, 40);
  const digits = phone.replace(/\D/g, '');
  const payoutSettings = await loadPaymentSettings();
  const payoutMethods = eligiblePayoutMethods(payoutSettings);
  if (!payoutMethods.length) {
    fail('failed-precondition',
      'No approved payout method is configured yet. Ask the finance team to add a Mobile Money number or bank account before requesting a withdrawal.');
  }
  const wantedId = text(data.payoutMethodId, 60);
  const payoutMethod = wantedId
    ? payoutMethods.find((method) => method.id === wantedId)
    : payoutMethods[0];
  if (!payoutMethod) {
    fail('failed-precondition', 'That payout method is not approved for withdrawals. Refresh the page and choose another one.');
  }
  const payoutAccount = text(data.accountNumber, 60);
  if (payoutMethod.type === 'mobile-money' &&
      (!/^\+?[0-9][0-9 ()\-]{6,24}$/.test(phone) || digits.length < 9)) {
    fail('invalid-argument', 'Enter the Mobile Money number that should receive the payment, including the country code.');
  }
  if (payoutMethod.type === 'bank-transfer' &&
      (!payoutAccount || payoutAccount.replace(/\D/g, '').length < 6)) {
    fail('invalid-argument', 'Enter the bank account number that should receive the payment.');
  }
  const key = text(data.idempotencyKey, 80) || crypto.randomBytes(12).toString('hex');
  const idemRef = db.collection('billingIdempotency').doc(uid + '_wd_' + key.replace(/[^A-Za-z0-9_.-]/g, ''));

  const memberSnap = await db.collection('memberships').doc(uid).get();
  const member = memberSnap.exists ? memberSnap.data() : {};
  if (member.status && member.status !== 'approved') {
    fail('failed-precondition', 'Your membership must be approved before you can withdraw.');
  }
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : {};
  const reference = newReference('withdrawal');
  const withdrawalRef = db.collection('withdrawals').doc(reference);
  const walletRef = db.collection('wallets').doc(uid);
  const walletTxRef = db.collection('walletTransactions').doc('wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const auditRef = db.collection('billingAudit').doc();
  const now = new Date();
  let result = null;

  await db.runTransaction(async (transaction) => {
    const idemSnap = await transaction.get(idemRef);
    if (idemSnap.exists) {
      const previousRef = withdrawalReferenceId(idemSnap.data().reference);
      if (previousRef) {
        const previous = await transaction.get(db.collection('withdrawals').doc(previousRef));
        if (previous.exists) {
          result = { alreadyCreated: true, withdrawal: publicWithdrawal(previous.data()) };
          return;
        }
      }
    }
    const walletSnap = await transaction.get(walletRef);
    if (!walletSnap.exists) fail('failed-precondition', 'Open your wallet before requesting a withdrawal.');
    const wallet = walletSnap.data() || {};
    const balance = Math.round((Number(wallet.balance) || 0) * 100) / 100;
    const held = Math.round((Number(wallet.heldBalance) || 0) * 100) / 100;
    const available = Math.round((balance - held) * 100) / 100;
    if (value > available) {
      fail('failed-precondition', 'The amount is more than your verified available balance of ' + available.toFixed(2) + ' USD.');
    }
    const row = {
      reference,
      userId: uid,
      userName: text(user.fullName || member.fullName || token.name || user.email || 'Member', 140),
      userEmail: text(user.email || member.email || token.email || '', 180),
      amount: value,
      currency: CURRENCY,
      payoutMethodId: payoutMethod.id,
      payoutMethodLabel: payoutMethod.label,
      payoutMethodType: payoutMethod.type,
      receivePhone: payoutMethod.type === 'mobile-money' ? phone : '',
      receiveAccount: payoutMethod.type === 'bank-transfer' ? payoutAccount : '',
      status: 'pending_review',
      requestedAt: now,
      createdAt: now,
      updatedAt: now
    };
    transaction.create(withdrawalRef, row);
    transaction.update(walletRef, {
      heldBalance: Math.round((held + value) * 100) / 100,
      updatedAt: now
    });
    transaction.create(walletTxRef, {
      userId: uid,
      userName: row.userName,
      type: 'withdrawal',
      direction: 'out',
      amount: value,
      currency: CURRENCY,
      status: 'pending_review',
      reference,
      withdrawalId: reference,
      payoutMethodId: payoutMethod.id,
      payoutMethodLabel: payoutMethod.label,
      receivePhone: row.receivePhone,
      receiveAccount: row.receiveAccount,
      createdAt: now,
      updatedAt: now
    });
    transaction.set(idemRef, {
      userId: uid,
      reference,
      kind: 'withdrawal',
      idempotencyKey: key,
      createdAt: now
    }, { merge: true });
    transaction.create(auditRef, {
      action: 'withdrawal_requested',
      withdrawalId: reference,
      walletTransactionId: walletTxRef.id,
      userId: uid,
      amount: value,
      currency: CURRENCY,
      status: 'pending_review',
      actorUid: uid,
      actorEmail: row.userEmail,
      actorRole: 'member',
      note: 'Withdrawal held for finance review; balance unchanged',
      createdAt: now
    });
    result = { withdrawal: publicWithdrawal(row), availableAfter: Math.round((available - value) * 100) / 100 };
  });

  return result || { withdrawal: null };
}

async function reviewWithdrawal(data, context, decision) {
  const adminUid = await requireAdmin(context);
  const adminActor = actor(context);
  const reference = withdrawalReferenceId(data.reference);
  if (!reference) fail('invalid-argument', 'Choose a withdrawal to review.');
  const reason = text(data.reason, 500);
  if (decision === 'reject' && reason.length < 4) {
    fail('invalid-argument', 'Give the member a reason for rejecting this withdrawal.');
  }
  if (!['review', 'approve', 'reject'].includes(decision)) {
    fail('invalid-argument', 'Unknown withdrawal decision.');
  }
  const db = admin.firestore();
  const withdrawalRef = db.collection('withdrawals').doc(reference);
  const auditRef = db.collection('billingAudit').doc();
  const now = new Date();
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(withdrawalRef);
    if (!snapshot.exists) fail('not-found', 'That withdrawal was not found.');
    const row = snapshot.data() || {};
    if (row.status === 'paid') fail('failed-precondition', 'A paid withdrawal cannot be changed.');
    if (row.status === 'rejected' && decision === 'reject') {
      outcome = { reference, status: 'rejected', alreadyRejected: true };
      return;
    }
    if (!['pending_review', 'under_review', 'processing'].includes(row.status)) {
      fail('failed-precondition', 'Only an open withdrawal can be reviewed.');
    }
    const txRef = db.collection('walletTransactions').doc('wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const txSnap = await transaction.get(txRef);
    if (decision === 'review') {
      if (row.status !== 'pending_review') fail('failed-precondition', 'This withdrawal is already under review.');
      transaction.update(withdrawalRef, {
        status: 'under_review', reviewedAt: now, reviewedBy: adminActor.email || adminUid, updatedAt: now
      });
      if (txSnap.exists) transaction.update(txRef, { status: 'under_review', updatedAt: now });
      transaction.create(auditRef, {
        action: 'withdrawal_under_review', withdrawalId: reference,
        walletTransactionId: txRef.id, userId: row.userId, amount: row.amount,
        currency: row.currency || CURRENCY, status: 'under_review', actorUid: adminUid,
        actorEmail: adminActor.email || '', actorRole: 'admin',
        note: reason || 'Administrator opened the review.', createdAt: now
      });
      outcome = { reference, status: 'under_review' };
      return;
    }
    if (decision === 'approve') {
      transaction.update(withdrawalRef, {
        status: 'processing',
        reviewedAt: now,
        reviewedBy: adminActor.email || adminUid,
        updatedAt: now
      });
      if (txSnap.exists) transaction.update(txRef, { status: 'processing', reviewedAt: now, updatedAt: now });
      transaction.create(auditRef, {
        action: 'withdrawal_approved',
        withdrawalId: reference,
        walletTransactionId: txRef.id,
        userId: row.userId,
        amount: row.amount,
        currency: row.currency || CURRENCY,
        status: 'processing',
        actorUid: adminUid,
        actorEmail: adminActor.email || '',
        actorRole: 'admin',
        note: 'Approved for payment. The balance is deducted only after the payment is confirmed.',
        createdAt: now
      });
      outcome = { reference, status: 'processing' };
      return;
    }

    // Rejection: release the hold. The verified balance must not move.
    const walletRef = db.collection('wallets').doc(row.userId);
    const walletSnap = await transaction.get(walletRef);
    if (walletSnap.exists) {
      const wallet = walletSnap.data() || {};
      const held = Math.max(0, Math.round(((Number(wallet.heldBalance) || 0) - Number(row.amount || 0)) * 100) / 100);
      transaction.update(walletRef, { heldBalance: held, updatedAt: now });
    }
    transaction.update(withdrawalRef, {
      status: 'rejected',
      rejectionReason: reason,
      rejectedAt: now,
      reviewedAt: now,
      reviewedBy: adminActor.email || adminUid,
      updatedAt: now
    });
    if (txSnap.exists) transaction.update(txRef, { status: 'rejected', rejectionReason: reason, updatedAt: now });
    transaction.create(auditRef, {
      action: 'withdrawal_rejected',
      withdrawalId: reference,
      walletTransactionId: txRef.id,
      userId: row.userId,
      amount: row.amount,
      currency: row.currency || CURRENCY,
      status: 'rejected',
      actorUid: adminUid,
      actorEmail: adminActor.email || '',
      actorRole: 'admin',
      note: reason,
      createdAt: now
    });
    outcome = { reference, status: 'rejected' };
  });

  return outcome || { reference, status: decision === 'approve' ? 'processing' : 'rejected' };
}

async function settleWithdrawal(data, context) {
  const adminUid = await requireAdmin(context);
  const adminActor = actor(context);
  if (data.confirmed !== true) {
    fail('failed-precondition', 'Confirm that the Mobile Money payment to the member has actually been made.');
  }
  const reference = withdrawalReferenceId(data.reference);
  const paidReference = text(data.paidReference, 120);
  if (!reference) fail('invalid-argument', 'Choose a withdrawal to settle.');
  if (paidReference.length < 4) {
    fail('invalid-argument', 'Enter the Mobile Money transaction reference from the payment you sent.');
  }
  const db = admin.firestore();
  const withdrawalRef = db.collection('withdrawals').doc(reference);
  const auditRef = db.collection('billingAudit').doc();
  const now = new Date();
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(withdrawalRef);
    if (!snapshot.exists) fail('not-found', 'That withdrawal was not found.');
    const row = snapshot.data() || {};
    if (row.status === 'paid') {
      outcome = { reference, status: 'paid', alreadyPaid: true, paidReference: row.paidReference || '' };
      return;
    }
    if (row.status !== 'processing') {
      fail('failed-precondition', 'Approve the withdrawal before confirming its payment.');
    }
    const walletRef = db.collection('wallets').doc(row.userId);
    const walletSnap = await transaction.get(walletRef);
    if (!walletSnap.exists) fail('failed-precondition', 'The member wallet was not found.');
    const wallet = walletSnap.data() || {};
    const balance = Math.round((Number(wallet.balance) || 0) * 100) / 100;
    const held = Math.round((Number(wallet.heldBalance) || 0) * 100) / 100;
    const value = Math.round(Number(row.amount) * 100) / 100;
    if (held + 0.001 < value) {
      fail('failed-precondition', 'The withdrawal hold is missing. Do not pay until finance reconciles this wallet.');
    }
    if (balance + 0.001 < value) {
      fail('failed-precondition', 'The wallet balance is lower than this withdrawal. Do not pay until finance reconciles this wallet.');
    }
    const newBalance = Math.round((balance - value) * 100) / 100;
    const newHeld = Math.round((held - value) * 100) / 100;
    // Every read must happen before the first write in a Firestore transaction.
    const txRef = db.collection('walletTransactions').doc('wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const txSnap = await transaction.get(txRef);
    transaction.update(walletRef, {
      balance: newBalance,
      heldBalance: newHeld,
      updatedAt: now,
      updatedBy: adminActor.email || adminUid
    });
    transaction.update(withdrawalRef, {
      status: 'paid',
      paidAt: now,
      paidBy: adminActor.email || adminUid,
      paidReference,
      updatedAt: now
    });
    if (txSnap.exists) {
      transaction.update(txRef, {
        status: 'paid',
        balanceAfter: newBalance,
        paidAt: now,
        paidBy: adminActor.email || adminUid,
        paidReference,
        updatedAt: now
      });
    }
    transaction.create(auditRef, {
      action: 'withdrawal_paid',
      withdrawalId: reference,
      walletTransactionId: txRef.id,
      userId: row.userId,
      amount: value,
      currency: row.currency || CURRENCY,
      status: 'paid',
      actorUid: adminUid,
      actorEmail: adminActor.email || '',
      actorRole: 'admin',
      note: 'Paid by Mobile Money. Confirmation: ' + paidReference,
      createdAt: now
    });
    outcome = {
      reference,
      status: 'paid',
      balance: newBalance,
      heldBalance: newHeld,
      paidReference
    };
  });

  return outcome || { reference, status: 'paid' };
}

/* Cancellation releases a reserved amount without moving the verified balance.
   A member may cancel only while the request is still open for review; an
   administrator may also cancel an approved-but-unpaid request. */
async function cancelWithdrawal(data, context) {
  const uid = requireAuth(context);
  const reference = withdrawalReferenceId(data.reference);
  if (!reference) fail('invalid-argument', 'Choose a withdrawal to cancel.');
  const db = admin.firestore();
  const withdrawalRef = db.collection('withdrawals').doc(reference);
  const auditRef = db.collection('billingAudit').doc();
  const isAdminUser = await isAdmin(uid);
  const now = new Date();
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(withdrawalRef);
    if (!snapshot.exists) fail('not-found', 'That withdrawal was not found.');
    const row = snapshot.data() || {};
    if (row.userId !== uid && !isAdminUser) {
      fail('permission-denied', 'This withdrawal belongs to another member.');
    }
    if (row.status === 'cancelled') {
      outcome = { reference, status: 'cancelled', alreadyCancelled: true };
      return;
    }
    if (row.status === 'paid') fail('failed-precondition', 'A paid withdrawal cannot be cancelled.');
    if (!['pending_review', 'under_review', 'processing'].includes(row.status)) {
      fail('failed-precondition', 'Only an open withdrawal can be cancelled.');
    }
    if (row.status === 'processing' && !isAdminUser) {
      fail('permission-denied', 'This withdrawal is being processed. Contact the ministry office to cancel it.');
    }
    const walletRef = db.collection('wallets').doc(row.userId);
    const walletSnap = await transaction.get(walletRef);
    const txRef = db.collection('walletTransactions').doc('wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const txSnap = await transaction.get(txRef);
    if (walletSnap.exists) {
      const wallet = walletSnap.data() || {};
      const held = Math.max(0, Math.round(((Number(wallet.heldBalance) || 0) - Number(row.amount || 0)) * 100) / 100);
      transaction.update(walletRef, { heldBalance: held, updatedAt: now });
    }
    transaction.update(withdrawalRef, {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: uid,
      updatedAt: now
    });
    if (txSnap.exists) transaction.update(txRef, { status: 'cancelled', updatedAt: now });
    transaction.create(auditRef, {
      action: 'withdrawal_cancelled', withdrawalId: reference, walletTransactionId: txRef.id,
      userId: row.userId, amount: row.amount, currency: row.currency || CURRENCY,
      status: 'cancelled', actorUid: uid, actorRole: isAdminUser ? 'admin' : 'member',
      note: 'Reserved amount released; the verified balance was not changed.', createdAt: now
    });
    outcome = { reference, status: 'cancelled' };
  });
  return outcome || { reference, status: 'cancelled' };
}

async function savePaymentSettings(data, context) {
  const adminUid = await requireAdmin(context);
  const rawMethods = Array.isArray(data.methods) ? data.methods : [];
  const legacyNumberProvided = Object.prototype.hasOwnProperty.call(data, 'mobileMoneyNumber');
  if (rawMethods.length > 12) {
    fail('invalid-argument', 'Keep the number of payment methods to 12 or fewer.');
  }
  const incoming = rawMethods.length ? rawMethods : (legacyNumberProvided ? [{
    id: 'official-mobile-money',
    type: 'mobile-money',
    label: text(data.network, 80) || PAYMENT_METHOD_LABELS['mobile-money'],
    enabled: true,
    scope: 'both',
    number: data.mobileMoneyNumber,
    accountName: data.accountName,
    network: data.network,
    instructions: data.instructions
  }] : []);
  if (!incoming.length) {
    fail('invalid-argument', 'Add at least one payment method donors can use.');
  }

  const usedIds = new Set();
  const methods = incoming.map((value, index) => {
    const method = normalizePaymentMethod(value, index);
    if (!method) return null;
    let id = method.id;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = method.id + '-' + suffix;
      suffix += 1;
    }
    usedIds.add(id);
    method.id = id;
    method.order = index + 1;
    method.accountName = method.accountName || 'PRAYER DOME';
    const digits = method.number.replace(/\D/g, '');
    // Disabled rows are drafts: finance may save a half-typed method while
    // still checking it. Only a method that is about to go live is validated.
    if (!method.enabled) return method;
    if (method.checkoutUrl && !/^https:\/\/[^\s]+$/i.test(method.checkoutUrl)) {
      fail('invalid-argument', 'The hosted checkout URL for “' + method.label + '” must start with https://.');
    }
    if (method.type === 'hosted-checkout' && !methodCheckoutUrl(method)) {
      fail('invalid-argument', 'A hosted checkout method needs a secure https:// checkout URL before it can be enabled.');
    }
    // A provider-hosted checkout URL is complete on its own: the donor pays on
    // the provider page and returns with a transaction reference.
    if (methodCheckoutUrl(method)) return method;
    if (method.type === 'bank-transfer') {
      if (!method.bankName || !method.accountNumber || method.accountNumber.length < 4) {
        fail('invalid-argument', 'A bank transfer method needs a bank name and account number before it can be enabled.');
      }
    } else if (method.type === 'cash-office') {
      if (!method.instructions) {
        fail('invalid-argument', 'Add office payment instructions before enabling “' + method.label + '”.');
      }
    } else if (digits.length < 9 || digits.length > 20) {
      fail('invalid-argument', 'The mobile-money or WhatsApp number for “' + method.label + '” must include the country code (9 to 20 digits).');
    }
    return method;
  }).filter(Boolean);

  if (!methods.some(usablePaymentMethod)) {
    fail('invalid-argument', 'Add at least one complete, enabled payment method. Donors must never be shown an unverified number.');
  }

  const primary = methods.find(usablePaymentMethod) || methods[0];
  const primaryNumber = primary ? (primary.type === 'bank-transfer' ? primary.accountNumber : primary.number) : '';
  const primaryDigits = String(primaryNumber || '').replace(/\D/g, '');
  const db = admin.firestore();
  const now = new Date();
  await db.doc(PAYMENT_SETTINGS_DOC).set({
    // Keep the legacy single-method fields in step for older clients that read
    // settings/payments directly. New clients always use methods[].
    mobileMoneyNumber: primary && primary.type !== 'bank-transfer' && primary.type !== 'cash-office' ? primary.number : '',
    accountName: primary ? primary.accountName : 'PRAYER DOME',
    network: primary ? (primary.network || primary.bankName || paymentMethodLabel(primary)) : 'Mobile Money',
    instructions: text(data.instructions, 1000) || (primary ? paymentMethodInstructions(primary) : ''),
    methods,
    primaryMethodId: primary ? primary.id : '',
    updatedAt: now,
    updatedBy: actor(context).email || adminUid
  }, { merge: true });
  await db.collection('billingAudit').add({
    action: 'payment_settings_updated',
    userId: '',
    amount: 0,
    currency: CURRENCY,
    status: 'configured',
    actorUid: adminUid,
    actorEmail: actor(context).email || '',
    actorRole: 'admin',
    note: 'Payment methods updated (' + methods.length + ' configured; primary ending ' + (primaryDigits.slice(-4) || 'n/a') + ').',
    methodCount: methods.length,
    createdAt: now
  });
  return { settings: await loadPaymentSettings() };
}

async function signedEvidenceUrl(data, context) {
  requireAuth(context);
  // Kept as a no-op compatibility action so an old browser tab gets a clear
  // answer instead of an opaque error. No Firebase Storage SDK or bucket is
  // contacted: new receipts are Cloudinary https links stored on the request.
  fail('failed-precondition',
    'Private Storage receipts are retired. Open legacy receipts in the Firebase console; new receipts use the attached link.');
}

async function routeBilling(data, context) {
  const payload = data && typeof data === 'object' ? data : {};
  const action = text(payload.action, 60) || 'plans.list';
  switch (action) {
    case 'plans.list':
      requireAuth(context);
      return { plans: await listPlans() };
    case 'plans.install': {
      await requireAdmin(context);
      const count = await installPlans();
      return { installed: count };
    }
    case 'plans.save':
      return savePlan(payload, context);
    case 'checkout.create':
      return createCheckout(payload, context);
    case 'checkout.evidence':
      return submitEvidence(payload, context);
    case 'evidence.signedUrl':
      return signedEvidenceUrl(payload, context);
    case 'checkout.cancel':
      return cancelCheckout(payload, context);
    case 'payment.approve':
      return approvePayment(payload, context);
    case 'payment.reject':
      return rejectPayment(payload, context);
    case 'payment.settings.get': {
      requireAuth(context);
      return { settings: await loadPaymentSettings() };
    }
    case 'payment.settings.public':
      // The public giving page must show the same official methods the wallet
      // and checkout use, but never a disabled or incomplete one.
      return { settings: publicPaymentSettings(await loadPaymentSettings(), 'give') };
    case 'payment.settings.save':
      return savePaymentSettings(payload, context);
    case 'payment.webhook':
      return confirmProviderPayment(payload, context);
    case 'withdrawal.request':
      return requestWithdrawal(payload, context);
    case 'withdrawal.review':
      return reviewWithdrawal(payload, context, 'review');
    case 'withdrawal.approve':
      return reviewWithdrawal(payload, context, 'approve');
    case 'withdrawal.reject':
      return reviewWithdrawal(payload, context, 'reject');
    case 'withdrawal.cancel':
      return cancelWithdrawal(payload, context);
    case 'withdrawal.paid':
      return settleWithdrawal(payload, context);
    case 'subscriptions.cancel':
      return cancelSubscription(payload, context);
    case 'subscriptions.resume':
      return resumeSubscription(payload, context);
    case 'subscriptions.expire': {
      await requireAdmin(context);
      return { expired: await expireSubscriptions() };
    }
    default:
      fail('invalid-argument', 'Unknown billing action.');
  }
}

async function handler(data, context) {
  const payload = data && typeof data === 'object' ? data : {};
  const action = text(payload.action, 60) || 'plans.list';
  try {
    return await routeBilling(payload, context);
  } catch (error) {
    if (isHttpsError(error)) throw error;
    // Firestore/Storage failures used to reach the caller as a bare
    // "internal", which the page could only show as one catch-all notice.
    // Keep the failed action and the real cause in the log, and turn the
    // causes an administrator can actually act on into precise messages.
    console.error('Billing action ' + action + ' failed:', error && (error.stack || error.message) || error);
    const raw = String((error && (error.code || error.status || error.message)) || '').toUpperCase();
    if (/PERMISSION_DENIED|MISSING OR INSUFFICIENT PERMISSIONS/.test(raw)) {
      fail('failed-precondition',
        'Billing cannot access Firestore. Ask the ministry administrator to grant the Cloud Functions service account access to the database, then retry.',
        { cause: 'PERMISSION_DENIED' });
    }
    if (/NOT_FOUND|DATABASE .* NOT FOUND/.test(raw)) {
      fail('failed-precondition',
        'The billing database is not reachable. Ask the ministry administrator to confirm the Firestore database and project, then retry.',
        { cause: 'FIRESTORE_NOT_FOUND' });
    }
    if (/UNAVAILABLE|DEADLINE_EXCEEDED|ETIMEDOUT/.test(raw)) {
      fail('unavailable',
        'Billing could not reach the database in time. Please retry in a moment.',
        { cause: 'UNAVAILABLE' });
    }
    fail('internal', 'Billing could not complete this request. The server did not confirm it; please retry.',
      { cause: raw.slice(0, 80) || 'UNKNOWN' });
  }
}

/* The Vercel serverless gateway calls `handler` directly. Previously this file
   registered a Firebase callable and a pub/sub job here, which made every
   support payment depend on a deployed, billable Google Cloud Function. The
   member page evaluates expiry from the stored date and an administrator can
   run `subscriptions.expire` through the same authenticated endpoint, so no
   scheduled Cloud job is needed. */
module.exports = {
  handler,
  routeBilling,
  expireSubscriptions,
  addMonths,
  subscriptionId,
  HttpsError
};
