'use strict';
/*
 * Support-plan billing and wallet credits
 * ---------------------------------------------------------------------------
 * Every money change happens here, behind a Firebase callable. The browser can
 * read a plan catalogue, but it can never create an active subscription, mark
 * a payment approved, or move a wallet balance.
 *
 * Lifecycle
 *   catalogue -> pending_payment -> pending_verification -> approved
 *   subscription: pending_payment -> active -> expired
 *   wallet:       pending_payment -> approved (credited exactly once)
 *
 * A payment screenshot is never proof on its own: an administrator must open
 * the receipt, check it against the ministry account, and explicitly confirm
 * the verification before the transaction runs.
 */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const crypto = require('crypto');
const catalog = require('./billing-catalog');

const REGION = 'us-central1';
const CURRENCY = 'USD';
const MIN_WALLET_DEPOSIT = 5;
const MIN_WITHDRAWAL = 10;
const PAYMENT_SETTINGS_DOC = 'settings/payments';
const MAX_AMOUNT = 1000000;
const ALLOWED_METHODS = ['mobile-money', 'bank-transfer', 'cash-office'];
const { HttpsError } = functions.https;

function fail(code, message, details) {
  // The marker lets the browser tell a real server decision ("that payment
  // belongs to another member") from a transport/deployment failure with the
  // same gRPC code. Without it every not-found or permission-denied would look
  // like a missing function.
  throw new HttpsError(code, message, Object.assign({ billing: true }, details || {}));
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
 * finance team through the billing callable. No Mobile Money number is stored
 * in this repository: if finance has not configured one, checkout stops
 * instead of showing a number nobody verified.
 */
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
  const number = text(data.mobileMoneyNumber, 40);
  const accountName = text(data.accountName, 120);
  const network = text(data.network, 80);
  const custom = text(data.instructions, 1000);
  const instructions = custom || (number
    ? 'Send the exact amount by ' + (network || 'Mobile Money') + ' to ' + number +
      (accountName ? ' (' + accountName + ')' : '') +
      '. Put the payment reference in the mobile-money reference field, then upload a clear receipt. ' +
      'A plan is activated only after the finance team checks the payment against the ministry account.'
    : catalog.PAYMENT_INSTRUCTIONS);
  return { number, accountName, network, instructions, configured: Boolean(number) };
}

function requirePaymentSettings(settings) {
  if (!settings || !settings.number) {
    fail('failed-precondition',
      'The official Mobile Money number has not been configured in Finance settings yet. Please contact the ministry office before sending any money.');
  }
  return settings;
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
      await ref.set(Object.assign({}, row, {
        source: 'standard-catalogue',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }), { merge: true });
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
    evidenceUrl: data.evidenceUrl || '',
    evidencePath: data.evidencePath || '',
    evidenceName: data.evidenceName || '',
    evidenceType: data.evidenceType || '',
    createdAt: data.createdAt || null
  };
}

async function createCheckout(data, context) {
  const uid = requireAuth(context);
  const db = admin.firestore();
  const kind = data.kind === 'wallet_deposit' ? 'wallet_deposit' : 'subscription';
  const method = ALLOWED_METHODS.includes(data.method) ? data.method : 'mobile-money';
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
  const paySettings = requirePaymentSettings(await loadPaymentSettings());

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
      userName: text(user.fullName || member.fullName || context.auth.token.name || user.email || 'Member', 140),
      userEmail: text(user.email || member.email || context.auth.token.email || '', 180),
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
      paymentInstructions: paySettings.instructions,
      payToNumber: paySettings.number,
      payToName: paySettings.accountName || 'PRAYER DOME',
      payToNetwork: paySettings.network || 'Mobile Money',
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
      paymentInstructions: paySettings.instructions,
      payToNumber: paySettings.number,
      payToName: paySettings.accountName || 'PRAYER DOME',
      payToNetwork: paySettings.network || 'Mobile Money'
    }
  };
}

async function submitEvidence(data, context) {
  const uid = requireAuth(context);
  const reference = text(data.reference, 80).toUpperCase();
  const evidencePath = text(data.evidencePath, 320);
  const evidenceUrl = text(data.evidenceUrl, 1200);
  if (evidencePath) {
    // New receipts live in private Storage under the member's own folder. A
    // member can only attach a path they own; the browser never mints a
    // public URL, and administrators read it through a short-lived signed URL.
    if (!new RegExp('^billingEvidence/' + uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[A-Za-z0-9._-]{1,140}$').test(evidencePath)) {
      fail('permission-denied', 'That receipt does not belong to your account.');
    }
  } else if (!/^https:\/\//i.test(evidenceUrl)) {
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
    receivePhone: row.receivePhone || '',
    status: row.status || 'pending_review',
    requestedAt: row.requestedAt || null,
    reviewedAt: row.reviewedAt || null,
    paidAt: row.paidAt || null,
    paidReference: row.paidReference || '',
    rejectionReason: row.rejectionReason || ''
  };
}

async function requestWithdrawal(data, context) {
  const uid = requireAuth(context);
  const db = admin.firestore();
  const value = amount(data.amount);
  if (value < MIN_WITHDRAWAL) fail('invalid-argument', 'The minimum withdrawal is $10.00.');
  const phone = text(data.phone, 40);
  const digits = phone.replace(/\D/g, '');
  if (!/^\+?[0-9][0-9 ()\-]{6,24}$/.test(phone) || digits.length < 9) {
    fail('invalid-argument', 'Enter a valid Mobile Money number, including the country code.');
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
      userName: text(user.fullName || member.fullName || context.auth.token.name || user.email || 'Member', 140),
      userEmail: text(user.email || member.email || context.auth.token.email || '', 180),
      amount: value,
      currency: CURRENCY,
      receivePhone: phone,
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
      receivePhone: phone,
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
    if (!['pending_review', 'processing'].includes(row.status)) {
      fail('failed-precondition', 'Only an open withdrawal can be reviewed.');
    }
    if (decision === 'approve') {
      const txRef = db.collection('walletTransactions').doc('wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, ''));
      const txSnap = await transaction.get(txRef);
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
    const txRef = db.collection('walletTransactions').doc('wt_' + reference.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const txSnap = await transaction.get(txRef);
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

async function savePaymentSettings(data, context) {
  const adminUid = await requireAdmin(context);
  const number = text(data.mobileMoneyNumber, 40);
  const accountName = text(data.accountName, 120);
  const network = text(data.network, 80);
  const instructions = text(data.instructions, 1000);
  const digits = number.replace(/\D/g, '');
  if (!number || digits.length < 9 || digits.length > 20) {
    fail('invalid-argument', 'Enter the official Mobile Money number, including the country code.');
  }
  if (!accountName) fail('invalid-argument', 'Enter the official account name for the number.');
  const db = admin.firestore();
  const now = new Date();
  await db.doc(PAYMENT_SETTINGS_DOC).set({
    mobileMoneyNumber: number,
    accountName,
    network: network || 'Mobile Money',
    instructions,
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
    note: 'Official payment details updated. Number ending ' + digits.slice(-4),
    createdAt: now
  });
  return { settings: await loadPaymentSettings() };
}

async function signedEvidenceUrl(data, context) {
  const uid = requireAuth(context);
  const path = text(data.path, 320);
  if (!/^billingEvidence\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,140}$/.test(path)) {
    fail('invalid-argument', 'That receipt path is not valid.');
  }
  const segments = path.split('/');
  if (segments[1] !== uid && !(await isAdmin(uid))) {
    fail('permission-denied', 'Only the owner or an administrator can open this receipt.');
  }
  try {
    const file = admin.storage().bucket().file(path);
    const [exists] = await file.exists();
    if (!exists) fail('not-found', 'The receipt file could not be found.');
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000
    });
    return { url, expiresIn: 900 };
  } catch (error) {
    if (error && error.code && String(error.code).indexOf('not-found') !== -1) throw error;
    console.error('Signed receipt URL failed:', error.message);
    fail('unavailable', 'The private receipt could not be opened right now.');
  }
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
      // The public giving page must show the same official number the wallet
      // and checkout use. It never receives anything else, and no write path
      // is exposed without an administrator.
      return { settings: await loadPaymentSettings() };
    case 'payment.settings.save':
      return savePaymentSettings(payload, context);
    case 'withdrawal.request':
      return requestWithdrawal(payload, context);
    case 'withdrawal.approve':
      return reviewWithdrawal(payload, context, 'approve');
    case 'withdrawal.reject':
      return reviewWithdrawal(payload, context, 'reject');
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
    if (error instanceof HttpsError) throw error;
    // Firestore/Storage failures used to reach the caller as a bare
    // "internal", which the page could only show as one catch-all notice.
    // Keep the code internal, but make the failed action and the real cause
    // visible in the function log with one searchable line.
    console.error('Billing action ' + action + ' failed:', error && (error.stack || error.message) || error);
    fail('internal', 'Billing could not complete this request. The server did not confirm it; please retry.');
  }
}

const billing = functions.region(REGION).https.onCall(handler);

/* Daily safety net. The member page also evaluates expiry from the stored date,
   so a delayed job can never make an expired plan look active. */
const expireJob = functions.region(REGION).pubsub.schedule('every day 03:10')
  .timeZone('Africa/Mbabane')
  .onRun(async () => {
    const count = await expireSubscriptions();
    console.log('Expired ' + count + ' subscriptions');
    return null;
  });

module.exports = { billing, expireJob, expireSubscriptions, addMonths, subscriptionId };
