'use strict';
/*
 * Vercel gateway for the Prayer Dome money system.
 *
 * Replaces the retired `billing` Google Cloud Function. All secrets stay on the
 * server: Firebase Admin uses a service-account JSON supplied through Vercel
 * environment variables, and provider webhooks are accepted only after an
 * HMAC-SHA256 signature check. The browser sends a Firebase ID token, which is
 * verified here before any action reaches the shared transaction logic.
 */

const crypto = require('crypto');
const billing = require('../functions/billing');

const { HttpsError } = billing;
const HTTP_STATUS = {
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  'invalid-argument': 400,
  'failed-precondition': 400,
  'out-of-range': 400,
  cancelled: 400,
  unavailable: 503,
  'resource-exhausted': 429,
  internal: 500,
  unknown: 500
};

const ACTIONS = new Set([
  'plans.list', 'checkout.create', 'checkout.evidence', 'evidence.signedUrl',
  'checkout.cancel', 'payment.settings.public', 'payment.settings.get',
  'payment.settings.save', 'withdrawal.request', 'withdrawal.review',
  'withdrawal.approve', 'withdrawal.reject', 'withdrawal.cancel',
  'withdrawal.paid', 'subscriptions.cancel', 'subscriptions.resume'
]);

const ADMIN_ACTIONS = new Set([
  'plans.install', 'plans.save', 'payment.approve', 'payment.reject',
  'payment.settings.save', 'withdrawal.review', 'withdrawal.approve',
  'withdrawal.reject', 'withdrawal.paid', 'subscriptions.expire'
]);

/* Best-effort fixed-window limiter for a single serverless instance. It stops
   accidental double submits and casual abuse; Firestore transactions and
   idempotency documents remain the authoritative duplicate protection. */
const windows = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const previous = windows.get(key);
  if (!previous || now >= previous.reset) {
    windows.set(key, { count: 1, reset: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  previous.count += 1;
  if (previous.count > max) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((previous.reset - now) / 1000)) };
  }
  return { allowed: true, retryAfter: 0 };
}

function cleanEnvValue(value) {
  return String(value == null ? '' : value).trim();
}

let cachedAdmin = null;
function firebaseAdmin() {
  if (cachedAdmin) return cachedAdmin;
  let admin;
  try {
    admin = require('firebase-admin');
  } catch (error) {
    throw new HttpsError('failed-precondition',
      'Billing is not configured on this deployment. Ask the administrator to install the server dependencies.',
      { billing: true, cause: 'ADMIN_SDK_MISSING' });
  }
  if (!admin.apps.length) {
    const json = cleanEnvValue(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT);
    if (json) {
      let credential;
      try {
        credential = JSON.parse(json);
      } catch (error) {
        throw new HttpsError('failed-precondition',
          'Billing service credentials are invalid. Ask the administrator to check the Vercel environment variable.',
          { billing: true, cause: 'SERVICE_ACCOUNT_INVALID' });
      }
      if (!credential.project_id || !credential.private_key || !credential.client_email) {
        throw new HttpsError('failed-precondition',
          'Billing service credentials are incomplete. Ask the administrator to use a full Firebase service-account JSON.',
          { billing: true, cause: 'SERVICE_ACCOUNT_INCOMPLETE' });
      }
      admin.initializeApp({ credential: admin.credential.cert(credential) });
    } else if (cleanEnvValue(process.env.GOOGLE_APPLICATION_CREDENTIALS) ||
      cleanEnvValue(process.env.FIREBASE_PROJECT_ID) || cleanEnvValue(process.env.GCLOUD_PROJECT)) {
      // Application Default Credentials work on a machine or runtime that
      // already has a Google identity; Vercel uses the JSON variable above.
      admin.initializeApp();
    } else {
      throw new HttpsError('failed-precondition',
        'Billing is not configured yet. Ask the administrator to set FIREBASE_SERVICE_ACCOUNT_JSON in Vercel.',
        { billing: true, cause: 'SERVICE_ACCOUNT_MISSING' });
    }
  }
  try {
    admin.firestore().settings({ ignoreUndefinedProperties: true });
  } catch (error) {
    // Already configured on this instance; not a payment failure.
  }
  cachedAdmin = admin;
  return admin;
}

function send(res, status, payload, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  Object.keys(headers || {}).forEach((name) => res.setHeader(name, headers[name]));
  res.end(JSON.stringify(payload));
}

function errorStatus(error) {
  const code = String((error && error.code) || 'unknown').replace(/^(firebase|functions)\//, '');
  return HTTP_STATUS[code] || 500;
}

function safeDetails(error) {
  const details = (error && error.details && typeof error.details === 'object') ? error.details : {};
  const safe = { billing: true };
  if (details.cause) safe.cause = String(details.cause).slice(0, 80);
  return safe;
}

function reportServerError(error, action, marker) {
  // Full technical detail goes only to protected server logs. Never log the
  // request body: it may contain an ID token or a provider secret.
  console.error('[billing:' + marker + '] ' + action + ' failed:',
    (error && (error.stack || error.message)) || error);
}

function clientError(res, error, action, marker) {
  const status = errorStatus(error);
  if (status >= 500 && !(error instanceof HttpsError)) reportServerError(error, action, marker);
  else if (status >= 500) reportServerError(error, action, marker);
  const message = status >= 500 && !(error instanceof HttpsError)
    ? 'Billing could not complete this request. The server did not confirm it; please retry.'
    : String((error && error.message) || 'Billing could not complete this request.');
  return send(res, status, {
    ok: false,
    error: {
      code: String((error && error.code) || 'unknown'),
      message,
      details: safeDetails(error)
    }
  });
}

function requestBody(req) {
  if (req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof (req && req.body) === 'string') {
    try { return JSON.parse(req.body); } catch (error) { return null; }
  }
  return null;
}

function clientIp(req) {
  const forwarded = cleanEnvValue(req && req.headers && req.headers['x-forwarded-for']);
  return forwarded.split(',')[0].trim().slice(0, 64) || 'local';
}

async function authenticate(req) {
  const header = cleanEnvValue(req && req.headers && req.headers.authorization);
  const match = /^Bearer ([A-Za-z0-9._-]{20,2048})$/.exec(header);
  if (!match) {
    throw new HttpsError('unauthenticated', 'Your sign-in has expired. Sign in again and retry.', { billing: true });
  }
  const admin = firebaseAdmin();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1], true);
  } catch (error) {
    throw new HttpsError('unauthenticated', 'Your sign-in could not be verified. Sign in again and retry.', { billing: true });
  }
  if (!decoded || !decoded.uid) {
    throw new HttpsError('unauthenticated', 'Your sign-in could not be verified. Sign in again and retry.', { billing: true });
  }
  return { auth: { uid: decoded.uid, token: decoded } };
}

async function billingHandler(req, res) {
  if ((req && req.method) !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Method not allowed.' } });
  }
  const body = requestBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(res, 400, { ok: false, error: { code: 'invalid-argument', message: 'Send a JSON billing request.' } });
  }
  const action = String(body.action || 'plans.list').slice(0, 60);
  if (!ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) {
    return send(res, 400, {
      ok: false,
      error: { code: 'invalid-argument', message: 'Unknown billing action.', details: { billing: true } }
    });
  }
  const limit = rateLimit('billing|' + clientIp(req) + '|' + action,
    ADMIN_ACTIONS.has(action) ? 20 : 90, 60 * 1000);
  if (!limit.allowed) {
    return send(res, 429, {
      ok: false,
      error: { code: 'resource-exhausted', message: 'Billing is busy right now. Wait a moment and retry.', details: { billing: true } }
    }, { 'Retry-After': String(limit.retryAfter) });
  }
  try {
    const context = await authenticate(req);
    const result = await billing.handler(Object.assign({}, body, { action }), context);
    return send(res, 200, Object.assign({ ok: true }, result || {}));
  } catch (error) {
    return clientError(res, error, action, 'http');
  }
}

function rawBodyForSignature(req) {
  if (req && Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof (req && req.rawBody) === 'string') return req.rawBody;
  return JSON.stringify(requestBody(req) || {});
}

function verifySignature(req, secret, raw) {
  const headers = (req && req.headers) || {};
  const supplied = cleanEnvValue(headers['x-pd-signature'] || headers['x-webhook-signature'] || headers['x-signature']);
  if (!supplied) return false;
  const value = supplied.replace(/^sha256=/i, '');
  // Vercel hands the handler a parsed body. Use the raw bytes when the runtime
  // supplies them; otherwise accept the provider's canonical JSON or the exact
  // JSON.stringify form produced by the request. Every candidate still needs
  // the provider's HMAC secret, so this does not weaken verification.
  const body = requestBody(req);
  const payloads = [raw];
  if (body && typeof body === 'object') {
    payloads.push(JSON.stringify(body));
    payloads.push(JSON.stringify(body, Object.keys(body).sort()));
  }
  const suppliedBuffers = [Buffer.from(value), Buffer.from(value.toLowerCase())];
  return payloads.some((payload) => {
    const digest = crypto.createHmac('sha256', secret).update(payload).digest();
    const expected = [Buffer.from(digest.toString('hex')), Buffer.from(digest.toString('base64'))];
    return suppliedBuffers.some((candidate) => expected.some((wanted) =>
      candidate.length === wanted.length && crypto.timingSafeEqual(candidate, wanted)));
  });
}

const PROVIDER_OUTCOMES = {
  paid: 'paid', success: 'paid', successful: 'paid', completed: 'paid',
  failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled', reversed: 'failed', refunded: 'failed'
};

async function webhookHandler(req, res) {
  if ((req && req.method) !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Method not allowed.' } });
  }
  const secret = cleanEnvValue(process.env.PAYMENT_WEBHOOK_SECRET);
  if (secret.length < 16) {
    return send(res, 503, {
      ok: false,
      error: {
        code: 'failed-precondition',
        message: 'Provider confirmation is not configured. Payments still require finance verification.',
        details: { billing: true, cause: 'WEBHOOK_SECRET_MISSING' }
      }
    });
  }
  const limit = rateLimit('webhook|' + clientIp(req), 120, 60 * 1000);
  if (!limit.allowed) {
    return send(res, 429, {
      ok: false,
      error: { code: 'resource-exhausted', message: 'Too many provider notifications. Retry shortly.', details: { billing: true } }
    }, { 'Retry-After': String(limit.retryAfter) });
  }
  const body = requestBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(res, 400, { ok: false, error: { code: 'invalid-argument', message: 'Send a JSON provider event.' } });
  }
  if (!verifySignature(req, secret, rawBodyForSignature(req))) {
    return send(res, 401, {
      ok: false,
      error: { code: 'unauthenticated', message: 'The provider signature was not valid.', details: { billing: true } }
    });
  }
  const status = PROVIDER_OUTCOMES[String(body.status || '').toLowerCase()];
  if (!status) {
    return send(res, 400, {
      ok: false,
      error: { code: 'invalid-argument', message: 'The provider event outcome is not supported.', details: { billing: true } }
    });
  }
  const payload = {
    action: 'payment.webhook',
    reference: String(body.reference || '').trim().toUpperCase().slice(0, 80),
    eventId: String(body.eventId || '').trim().slice(0, 160),
    providerReference: String(body.providerReference || '').trim().slice(0, 160),
    amount: Number(body.amount),
    currency: String(body.currency || 'USD').trim().toUpperCase().slice(0, 8),
    outcome: status,
    reason: String(body.reason || '').slice(0, 300)
  };
  try {
    const result = await billing.handler(payload, { webhook: true });
    return send(res, 200, Object.assign({ ok: true, received: true }, result || {}));
  } catch (error) {
    return clientError(res, error, 'payment.webhook', 'webhook');
  }
}

module.exports = {
  billingHandler,
  webhookHandler,
  verifySignature,
  firebaseAdmin,
  rateLimit
};
