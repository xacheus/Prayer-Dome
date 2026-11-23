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
const MAX_AMOUNT = 1000000;
const ALLOWED_METHODS = ['mobile-money', 'bank-transfer', 'cash-office'];
const { HttpsError } = functions.https;

function fail(code, message) {
  throw new HttpsError(code, message);
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
  const prefix = kind === 'wallet_deposit' ? 'PD-WAL' : 'PD-SUB';
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
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
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
    paymentInstructions: data.paymentInstructions || '',
    evidenceUrl: data.evidenceUrl || '',
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
      paymentInstructions: plan ? plan.paymentInstructions : catalog.PAYMENT_INSTRUCTIONS,
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
      const subscriptionSnap = await transaction.get(subRef);
      const previous = subscriptionSnap.exists ? subscriptionSnap.data() : null;
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

    transaction.create(idemRef, {
      userId: uid,
      reference,
      kind,
      idempotencyKey: key,
      createdAt: now
    });

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
      paymentInstructions: plan ? plan.paymentInstructions : catalog.PAYMENT_INSTRUCTIONS
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
      const subSnap = await transaction.get(subRef);
      const active = subSnap.exists && subSnap.data().status === 'active';
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

    transaction.update(paymentRef, {
      status: 'rejected',
      rejectedAt: now,
      rejectedBy: adminActor.email || adminUid,
      rejectionReason: reason,
      updatedAt: now
    });

    if (payment.subscriptionId) {
      const subRef = db.collection('subscriptions').doc(payment.subscriptionId);
      const subSnap = await transaction.get(subRef);
      if (subSnap.exists) {
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
    transaction.update(paymentRef, { status: 'cancelled', cancelledAt: now, updatedAt: now });
    if (payment.subscriptionId) {
      const subRef = db.collection('subscriptions').doc(payment.subscriptionId);
      const subSnap = await transaction.get(subRef);
      if (subSnap.exists && subSnap.data().status === 'pending_payment') {
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

async function handler(data, context) {
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
