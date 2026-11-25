'use strict';

/*
 * Brevo (formerly Sendinblue) integration.
 * ===========================================================================
 * Two jobs, both optional and both fail-safe:
 *
 *   1. Transactional verification email — the Cloud Function generates the
 *      Firebase verification link and Brevo delivers it from the ministry's
 *      own authenticated domain, so it does not look like a firebaseapp.com
 *      message. If Brevo is not configured the client falls back to Firebase's
 *      built-in sender; an account is never blocked on this.
 *   2. Newsletter / update signup — the support page posts an email address
 *      with explicit consent. When a double opt-in template is configured the
 *      contact receives Brevo's confirmation email; otherwise the contact is
 *      added to the list (still unsubscribeable from every mailing).
 *
 * Credentials are read from the environment only. Nothing in this file (or the
 * repository) contains an API key. Required:
 *
 *   BREVO_API_KEY          Brevo API v3 key (Secret Manager on Firebase,
 *                          environment variable on Vercel)
 * Optional:
 *   BREVO_SENDER_EMAIL     verified sender, default noreply@prayerdome.net
 *   BREVO_SENDER_NAME      default "Prayer Dome"
 *   BREVO_LIST_ID          numeric list for update subscribers
 *   BREVO_DOI_TEMPLATE_ID  numeric double opt-in template id
 *   PD_SITE_URL            default https://prayerdome.net
 */

const BREVO_API = 'https://api.brevo.com/v3';
const DEFAULT_SITE = 'https://prayerdome.net';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const design = require('./email-design');
const REQUEST_TIMEOUT_MS = 7000;

function config(env) {
  const source = env || process.env;
  return {
    apiKey: String(source.BREVO_API_KEY || '').trim(),
    senderEmail: String(source.BREVO_SENDER_EMAIL || 'noreply@prayerdome.net').trim(),
    senderName: String(source.BREVO_SENDER_NAME || 'Prayer Dome').trim(),
    listId: Number(source.BREVO_LIST_ID) || 0,
    doiTemplateId: Number(source.BREVO_DOI_TEMPLATE_ID) || 0,
    replyTo: String(source.BREVO_REPLY_TO || '').trim(),
    siteUrl: String(source.PD_SITE_URL || DEFAULT_SITE).replace(/\/+$/, '')
  };
}

function isConfigured(env) {
  return Boolean(config(env).apiKey);
}

function cleanEmail(value) {
  const email = String(value == null ? '' : value).trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return '';
  return email;
}

function cleanName(value) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function providerFailure(response, payload) {
  const status = Number(response && response.status) || 0;
  const providerCode = String((payload && (payload.code || payload.error)) || '').slice(0, 80);
  const providerMessage = String((payload && payload.message) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
  let code = 'provider_error';
  let message = 'The mail service rejected the request.';
  if (status === 401 || status === 403) {
    code = 'auth_failed';
    message = 'Brevo rejected the API key. Check that BREVO_API_KEY is the current v3 key for this account.';
  } else if (status === 429) {
    code = 'rate_limited';
    message = 'Brevo is rate-limiting this account. Please wait a few minutes before trying again.';
  } else if (status === 400 || status === 422) {
    if (/sender|from|domain|verified/i.test(providerMessage)) {
      code = 'sender_not_verified';
      message = 'Brevo rejected the sender address. Verify the sender or authenticate the prayerdome.net domain in Brevo.';
    } else if (/recipient|email|to/i.test(providerMessage)) {
      code = 'recipient_rejected';
      message = 'Brevo rejected the recipient address.';
    } else {
      code = 'invalid_request';
      message = providerMessage || 'Brevo rejected the request as invalid.';
    }
  } else if (status >= 500) {
    code = 'provider_error';
    message = 'Brevo is temporarily unavailable. The message will be retried.';
  }
  const failure = new Error(message);
  failure.code = code;
  failure.status = status;
  failure.providerCode = providerCode;
  failure.providerMessage = providerMessage;
  // Never attach response headers: they can contain account identifiers.
  return failure;
}

async function requestBrevo(method, path, body, options) {
  const cfg = options || config();
  if (!cfg.apiKey) {
    const missing = new Error('Brevo is not configured.');
    missing.code = 'not_configured';
    throw missing;
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  let response;
  try {
    const headers = {
      accept: 'application/json',
      'api-key': cfg.apiKey
    };
    const init = { method: method, headers: headers, signal: controller ? controller.signal : undefined };
    if (body !== undefined && body !== null) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    response = await fetch(BREVO_API + path, init);
  } catch (error) {
    const failure = new Error(error && error.name === 'AbortError'
      ? 'The mail service timed out.'
      : 'The mail service could not be reached.');
    failure.code = 'unreachable';
    throw failure;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); } catch (error) { payload = {}; }
  }
  if (!response.ok && response.status !== 201 && response.status !== 204) {
    throw providerFailure(response, payload);
  }
  return payload;
}

function callBrevo(path, body, options) {
  return requestBrevo('POST', path, body || {}, options);
}

/**
 * Verify the credential and sender without sending mail.
 * Returns booleans and provider-safe labels only; never the API key.
 */
async function checkConnection(env) {
  const cfg = config(env);
  if (!cfg.apiKey) {
    return { configured: false, ok: false, code: 'not_configured', message: 'BREVO_API_KEY is not set on this deployment.' };
  }
  try {
    const account = await requestBrevo('GET', '/account', null, cfg);
    let senderVerified = null;
    try {
      const senders = await requestBrevo('GET', '/senders', null, cfg);
      const list = Array.isArray(senders.senders) ? senders.senders : [];
      const match = list.find(function (entry) {
        return cleanEmail(entry && entry.email) === cleanEmail(cfg.senderEmail);
      });
      senderVerified = match ? match.active !== false : false;
    } catch (error) { /* sender listing is optional; the send result is authoritative */ }
    return {
      configured: true,
      ok: true,
      companyName: String(account.companyName || account.enterpriseName || '').slice(0, 120),
      senderEmail: cfg.senderEmail,
      senderName: cfg.senderName,
      senderVerified: senderVerified,
      message: senderVerified === false
        ? 'Brevo accepted the API key, but the sender address is not in the verified senders list.'
        : 'Brevo accepted the API key.'
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      code: error.code || 'provider_error',
      status: error.status || 0,
      senderEmail: cfg.senderEmail,
      senderName: cfg.senderName,
      message: error.message || 'Brevo could not be reached.'
    };
  }
}

/**
 * Ask Brevo for the delivery state of one accepted message. "sent" here means
 * the provider accepted it, not that the recipient's mailbox displayed it.
 */
async function getEmailStatus(messageId, env, recipient) {
  const cfg = config(env);
  const id = String(messageId || '').trim();
  if (!cfg.apiKey) return { ok: false, code: 'not_configured', message: 'BREVO_API_KEY is not set.' };
  if (!id) return { ok: false, code: 'invalid_message_id', message: 'A provider message id is required.' };
  try {
    const query = '/smtp/emails?messageId=' + encodeURIComponent(id) + '&limit=5'
      + (cleanEmail(recipient) ? '&email=' + encodeURIComponent(cleanEmail(recipient)) : '');
    const payload = await requestBrevo('GET', query, null, cfg);
    const rows = Array.isArray(payload.transactionalEmails) ? payload.transactionalEmails : [];
    const row = rows[0] || {};
    return {
      ok: true,
      messageId: String(row.messageId || id),
      status: String(row.status || '').toLowerCase(),
      reason: String(row.reason || row.errorReason || '').slice(0, 240),
      date: row.date || row.createdAt || ''
    };
  } catch (error) {
    return { ok: false, code: error.code || 'provider_error', status: error.status || 0, message: error.message || 'Brevo could not be queried.' };
  }
}

function verificationEmailHtml(cfg, name, link) {
  return design.renderEmail({
    subject: 'Confirm your email — Prayer Dome',
    heading: 'Confirm your email address',
    preheader: 'Confirm this address to finish setting up your Prayer Dome account.',
    greeting: 'Hello ' + (cleanName(name) || 'friend') + ',',
    paragraphs: [
      'Thank you for creating a Prayer Dome account. Confirm this address so we know it is yours. Your account already works; this step keeps it secure and lets us reach you with service updates you ask for.',
      'If you did not create this account, you can ignore this message.'
    ],
    action: { label: 'Confirm my email', url: link },
    footerNote: 'You received this because an account was created with this address.',
    siteUrl: cfg.siteUrl
  }).html;
}

function verificationEmailText(cfg, name, link) {
  return design.renderEmail({
    subject: 'Confirm your email — Prayer Dome',
    heading: 'Confirm your email address',
    greeting: 'Hello ' + (cleanName(name) || 'friend') + ',',
    paragraphs: [
      'Thank you for creating a Prayer Dome account. Confirm this address so we know it is yours. Your account already works; this step keeps it secure and lets us reach you with service updates you ask for.',
      'If you did not create this account, you can ignore this message.'
    ],
    action: { label: 'Confirm my email', url: link },
    footerNote: 'You received this because an account was created with this address.',
    siteUrl: cfg.siteUrl
  }).text;
}

/*
 * Send the Firebase verification link through Brevo.
 * `link` is produced by admin.auth().generateEmailVerificationLink().
 */
async function sendVerificationEmail(options) {
  const cfg = config(options && options.env);
  const email = cleanEmail(options && options.email);
  const link = String((options && options.link) || '');
  if (!email) {
    const error = new Error('A valid email address is required.');
    error.code = 'invalid_email';
    throw error;
  }
  if (!/^https?:\/\//i.test(link)) {
    const error = new Error('A verification link is required.');
    error.code = 'invalid_link';
    throw error;
  }
  if (!cfg.apiKey) return { sent: false, reason: 'not-configured' };
  const provider = await callBrevo('/smtp/email', {
    sender: { name: cfg.senderName, email: cfg.senderEmail },
    to: [{ email, name: cleanName(options && options.name) || undefined }],
    replyTo: { email: cfg.senderEmail, name: cfg.senderName },
    subject: 'Confirm your email — Prayer Dome',
    htmlContent: verificationEmailHtml(cfg, options && options.name, link),
    textContent: verificationEmailText(cfg, options && options.name, link),
    tags: ['account-verification']
  }, cfg);
  return { sent: true, provider: 'brevo', messageId: String(provider && provider.messageId || '') };
}

function registrationCodeEmailHtml(cfg, name, code, minutes) {
  return design.renderEmail({
    subject: 'Your Prayer Dome verification code',
    heading: 'Verify your email address',
    preheader: 'Your Prayer Dome verification code expires in ' + Math.max(1, Number(minutes) || 10) + ' minutes.',
    greeting: 'Hello ' + (cleanName(name) || 'friend') + ',',
    paragraphs: [
      'Enter this six-digit code in Prayer Dome to finish creating your account. It expires in ' + Math.max(1, Number(minutes) || 10) + ' minutes.',
      'Prayer Dome will never ask you for this code by phone, WhatsApp or social media.',
      'If you did not create this account, ignore this message and do not share the code.'
    ],
    code: code,
    action: { label: 'Open Prayer Dome', url: cfg.siteUrl + '/account.html' },
    footerNote: 'You received this because an account was created with this address.',
    siteUrl: cfg.siteUrl
  }).html;
}

function registrationCodeEmailText(cfg, name, code, minutes) {
  return design.renderEmail({
    subject: 'Your Prayer Dome verification code',
    heading: 'Verify your email address',
    greeting: 'Hello ' + (cleanName(name) || 'friend') + ',',
    paragraphs: [
      'Enter this six-digit code in Prayer Dome to finish creating your account. It expires in ' + Math.max(1, Number(minutes) || 10) + ' minutes.',
      'Prayer Dome will never ask you for this code by phone, WhatsApp or social media.',
      'If you did not create this account, ignore this message and do not share the code.'
    ],
    code: code,
    action: { label: 'Open Prayer Dome', url: cfg.siteUrl + '/account.html' },
    footerNote: 'You received this because an account was created with this address.',
    siteUrl: cfg.siteUrl
  }).text;
}

/**
 * Deliver a genuine six-digit registration code through Brevo. The code is
 * generated and hashed by the caller; this function only transports it.
 */
async function sendRegistrationCodeEmail(options) {
  const cfg = config(options && options.env);
  const email = cleanEmail(options && options.email);
  const code = String((options && options.code) || '');
  const minutes = Math.max(1, Number(options && options.minutes) || 10);
  if (!email) {
    const error = new Error('A valid email address is required.');
    error.code = 'invalid_email';
    throw error;
  }
  if (!/^\d{6}$/.test(code)) {
    const error = new Error('A six-digit registration code is required.');
    error.code = 'invalid_code';
    throw error;
  }
  if (!cfg.apiKey) return { sent: false, reason: 'not-configured' };
  const provider = await callBrevo('/smtp/email', {
    sender: { name: cfg.senderName, email: cfg.senderEmail },
    to: [{ email, name: cleanName(options && options.name) || undefined }],
    replyTo: { email: cfg.senderEmail, name: cfg.senderName },
    subject: 'Your Prayer Dome verification code',
    htmlContent: registrationCodeEmailHtml(cfg, options && options.name, code, minutes),
    textContent: registrationCodeEmailText(cfg, options && options.name, code, minutes),
    tags: ['registration-code']
  }, cfg);
  return { sent: true, provider: 'brevo', messageId: String(provider && provider.messageId || '') };
}

/*
 * Generic transactional delivery. The notification service owns the copy and
 * the event id; this function only talks to Brevo. The sender can be supplied
 * from the administrator's saved settings, but it must be an address verified
 * in the Brevo account or Brevo will reject the request (and the outbox records
 * the failure for a retry after the sender is corrected).
 */
async function sendTransactionalEmail(options) {
  const cfg = config(options && options.env);
  const email = cleanEmail(options && options.email);
  const to = cleanEmail(options && options.to) || email;
  if (!to) {
    const error = new Error('A valid recipient address is required.');
    error.code = 'invalid_email';
    throw error;
  }
  const subject = String((options && options.subject) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
  if (!subject) {
    const error = new Error('An email subject is required.');
    error.code = 'invalid_subject';
    throw error;
  }
  const html = String((options && options.html) || '');
  const plain = String((options && options.text) || '');
  if (!html && !plain) {
    const error = new Error('Email content is required.');
    error.code = 'invalid_content';
    throw error;
  }
  if (!cfg.apiKey) {
    const error = new Error('Brevo is not configured.');
    error.code = 'not_configured';
    throw error;
  }
  const senderEmail = cleanEmail(options && options.senderEmail) || cfg.senderEmail;
  const senderName = cleanName(options && options.senderName) || cfg.senderName;
  const replyTo = cleanEmail(options && options.replyTo);
  const payload = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: to, name: cleanName(options && options.toName) || undefined }],
    subject,
    htmlContent: html || undefined,
    textContent: plain || undefined,
    tags: Array.isArray(options && options.tags)
      ? options.tags.map(function (tag) { return cleanName(tag).toLowerCase(); }).filter(Boolean).slice(0, 10)
      : ['prayer-dome']
  };
  if (replyTo) payload.replyTo = { email: replyTo, name: senderName };
  return callBrevo('/smtp/email', payload, cfg);
}

/*
 * Add a consenting subscriber. Double opt-in is preferred whenever the list and
 * DOI template are configured, because it produces an auditable confirmation
 * instead of silently mailing somebody who mistyped an address.
 */
async function subscribe(options) {
  const cfg = config(options && options.env);
  const email = cleanEmail(options && options.email);
  const name = cleanName(options && options.name);
  if (!email) {
    const error = new Error('Enter a valid email address.');
    error.code = 'invalid_email';
    throw error;
  }
  if (!(options && options.consent === true)) {
    const error = new Error('Please agree to receive Prayer Dome updates.');
    error.code = 'consent_required';
    throw error;
  }
  if (!cfg.apiKey) return { ok: false, reason: 'not-configured' };

  const attributes = {
    FIRSTNAME: name || undefined,
    SOURCE: 'support-page',
    CONSENT_AT: new Date().toISOString()
  };

  if (cfg.doiTemplateId && cfg.listId) {
    await callBrevo('/contacts/doubleOptinConfirmation', {
      email,
      attributes,
      includeListIds: [cfg.listId],
      templateId: cfg.doiTemplateId,
      redirectionUrl: cfg.siteUrl + '/support?subscribed=1'
    }, cfg);
    return { ok: true, doubleOptIn: true };
  }

  const payload = { email, attributes, updateEnabled: true };
  if (cfg.listId) payload.listIds = [cfg.listId];
  try {
    await callBrevo('/contacts', payload, cfg);
  } catch (error) {
    // Brevo reports an existing contact as a 400 duplicate; that is a success
    // for this form (the person is already subscribed).
    if (!/duplicate/i.test(String(error.code || '')) && !/already/i.test(String(error.message || ''))) throw error;
  }
  if (options && options.welcome === true) {
    // The contact is already on the list. The welcome is a separate branded
    // transactional message, so a failure here must not make the signup look
    // unsuccessful.
    try {
      const rendered = design.renderEmail({
        subject: 'Welcome to Prayer Dome updates',
        heading: 'Thank you for staying connected',
        greeting: 'Hello' + (name ? ' ' + name : '') + ',',
        paragraphs: [
          'Thank you for agreeing to receive Prayer Dome ministry updates. We will share service notices, devotional encouragement and ministry news with you from time to time.',
          'You can change your email preferences at any time from your account, and every message includes a way to stop receiving updates.'
        ],
        action: { label: 'Visit Prayer Dome', url: cfg.siteUrl },
        footerNote: 'You received this because you asked to receive Prayer Dome updates.',
        category: 'newsletter',
        siteUrl: cfg.siteUrl
      });
      await sendTransactionalEmail({
        to: email,
        toName: name,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        senderName: cfg.senderName,
        senderEmail: cfg.senderEmail,
        replyTo: cfg.replyTo,
        tags: ['prayer-dome', 'newsletter-welcome']
      });
    } catch (error) {
      console.warn('Newsletter welcome could not be sent:', error.code || error.message);
    }
  }
  return { ok: true, doubleOptIn: false };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string' && req.body.trim()) {
      try { return resolve(JSON.parse(req.body)); } catch (error) { return resolve(null); }
    }
    let raw = '';
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    if (!req || typeof req.on !== 'function') return finish(null);
    timer = setTimeout(() => finish(null), 5000);
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024) { req.destroy && req.destroy(); finish(null); }
    });
    req.on('end', () => {
      try { finish(raw ? JSON.parse(raw) : {}); } catch (error) { finish(null); }
    });
    req.on('error', () => finish(null));
  });
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  Object.keys(extraHeaders || {}).forEach((key) => res.setHeader(key, extraHeaders[key]));
  if (res.end) return res.end(body);
  return undefined;
}

/* Simple per-instance flood guard. Serverless instances are short-lived, so
   this is a speed bump, not a replacement for Brevo's own abuse controls. */
const recent = new Map();
function rateLimited(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const hits = (recent.get(key) || []).filter((at) => now - at < 60 * 1000);
  if (hits.length >= 6) { recent.set(key, hits); return true; }
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 500) {
    for (const [entry, times] of recent) {
      if (!times.some((at) => now - at < 60 * 1000)) recent.delete(entry);
    }
  }
  return false;
}

async function newsletterHandler(req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
  }
  const ip = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
  if (rateLimited(String(ip).split(',')[0].trim())) {
    return sendJson(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS', message: 'Please wait a minute and try again.' });
  }
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { ok: false, error: 'INVALID_BODY', message: 'Send an email address as JSON.' });
  }
  if (body.website) {
    // Honeypot filled: answer like success so a bot does not learn anything.
    return sendJson(res, 200, { ok: true });
  }
  const email = cleanEmail(body.email);
  if (!email) {
    return sendJson(res, 400, { ok: false, error: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
  }
  if (body.consent !== true) {
    return sendJson(res, 400, { ok: false, error: 'CONSENT_REQUIRED', message: 'Please agree to receive Prayer Dome updates.' });
  }
  try {
    const result = await subscribe({ email, name: body.name, consent: true, welcome: true, env: process.env });
    if (result.reason === 'not-configured') {
      return sendJson(res, 503, {
        ok: false,
        error: 'NOT_CONFIGURED',
        message: 'Email updates are being set up. Please write to info@prayerdome.net and we will add you.'
      });
    }
    return sendJson(res, 200, {
      ok: true,
      doubleOptIn: Boolean(result.doubleOptIn),
      message: result.doubleOptIn
        ? 'Almost there — check your inbox and confirm the subscription.'
        : 'You are on the Prayer Dome updates list. Every message includes an unsubscribe link.'
    });
  } catch (error) {
    const message = error && error.code === 'invalid_email'
      ? 'Enter a valid email address.'
      : 'We could not add you just now. Please try again or write to info@prayerdome.net.';
    return sendJson(res, 502, { ok: false, error: 'BREVO_UNAVAILABLE', message });
  }
}

module.exports = {
  isConfigured,
  cleanEmail,
  sendTransactionalEmail,
  subscribe,
  sendVerificationEmail,
  sendRegistrationCodeEmail,
  checkConnection,
  getEmailStatus,
  registrationCodeEmailHtml,
  registrationCodeEmailText,
  newsletterHandler,
  verificationEmailHtml,
  verificationEmailText,
  config
};
