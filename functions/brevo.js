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
const REQUEST_TIMEOUT_MS = 7000;

function config(env) {
  const source = env || process.env;
  return {
    apiKey: String(source.BREVO_API_KEY || '').trim(),
    senderEmail: String(source.BREVO_SENDER_EMAIL || 'noreply@prayerdome.net').trim(),
    senderName: String(source.BREVO_SENDER_NAME || 'Prayer Dome').trim(),
    listId: Number(source.BREVO_LIST_ID) || 0,
    doiTemplateId: Number(source.BREVO_DOI_TEMPLATE_ID) || 0,
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

async function callBrevo(path, body, options) {
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
    response = await fetch(BREVO_API + path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': cfg.apiKey
      },
      body: JSON.stringify(body || {}),
      signal: controller ? controller.signal : undefined
    });
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
    const failure = new Error(payload.message || 'Brevo rejected the request.');
    failure.code = payload.code || ('http_' + response.status);
    failure.status = response.status;
    // Never surface the request headers (which contain the key) to a caller.
    throw failure;
  }
  return payload;
}

function verificationEmailHtml(cfg, name, link) {
  const safeName = escapeHtml(cleanName(name) || 'friend');
  const safeLink = escapeHtml(link);
  const safeSite = escapeHtml(cfg.siteUrl.replace(/^https?:\/\//, ''));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm your email — Prayer Dome</title></head>
<body style="margin:0;padding:0;background:#f3f6fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;">Confirm your email address to finish setting up your Prayer Dome account.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6fb;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #dbe3ee;">
        <tr><td style="background:#0A4D9B;padding:22px 26px;">
          <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#f6df8a;font-weight:800;">Prayer Dome</div>
          <div style="font-size:19px;font-weight:800;color:#ffffff;margin-top:4px;">A House of Prayer for All Nations</div>
        </td></tr>
        <tr><td style="padding:28px 26px 10px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#07244d;">Confirm your email address</h1>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.65;">Hello ${safeName},</p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.65;">Thank you for creating a Prayer Dome account. Confirm this address so we know it is yours. Your account already works — this step keeps it secure and lets us reach you with service updates you ask for.</p>
          <p style="margin:0 0 24px;"><a href="${safeLink}" style="display:inline-block;background:#0A4D9B;color:#ffffff;text-decoration:none;font-weight:800;font-size:15px;padding:13px 22px;border-radius:10px;">Confirm my email</a></p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5b6b82;">If the button does not open, copy this link into your browser:</p>
          <p style="margin:0 0 22px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${safeLink}" style="color:#0A4D9B;">${safeLink}</a></p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5b6b82;">If you did not create this account, you can ignore this message.</p>
        </td></tr>
        <tr><td style="padding:16px 26px 24px;border-top:1px solid #e6edf6;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#5b6b82;">Prayer Dome Ministry · ${safeSite}<br>You received this because an account was created with this address.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function verificationEmailText(cfg, name, link) {
  return [
    'Prayer Dome — confirm your email address',
    '',
    'Hello ' + (cleanName(name) || 'friend') + ',',
    '',
    'Thank you for creating a Prayer Dome account. Confirm this address so we know it is yours. Your account already works — this step keeps it secure and lets us reach you with service updates you ask for.',
    '',
    'Open this link to confirm:',
    link,
    '',
    'If you did not create this account, you can ignore this message.',
    '',
    'Prayer Dome Ministry · ' + cfg.siteUrl.replace(/^https?:\/\//, '')
  ].join('\n');
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
  await callBrevo('/smtp/email', {
    sender: { name: cfg.senderName, email: cfg.senderEmail },
    to: [{ email, name: cleanName(options && options.name) || undefined }],
    replyTo: { email: cfg.senderEmail, name: cfg.senderName },
    subject: 'Confirm your email — Prayer Dome',
    htmlContent: verificationEmailHtml(cfg, options && options.name, link),
    textContent: verificationEmailText(cfg, options && options.name, link),
    tags: ['account-verification']
  }, cfg);
  return { sent: true, provider: 'brevo' };
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
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    if (!req || typeof req.on !== 'function') return finish(null);
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024) { req.destroy && req.destroy(); finish(null); }
    });
    req.on('end', () => {
      try { finish(raw ? JSON.parse(raw) : {}); } catch (error) { finish(null); }
    });
    req.on('error', () => finish(null));
    setTimeout(() => finish(null), 5000);
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
    const result = await subscribe({ email, name: body.name, consent: true, env: process.env });
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
  newsletterHandler,
  verificationEmailHtml,
  verificationEmailText,
  config
};
