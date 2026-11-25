'use strict';

/*
 * Transactional email system checks.
 *
 * These run without Firebase or a Brevo account. They pin the parts that a
 * member actually sees and the parts that keep credentials and verification
 * codes out of the wrong place:
 *
 *   • one branded renderer with the real logo, colours, website and contacts,
 *   • a plain-text alternative and a call to action for every event,
 *   • every requested event exists and no template leaves {{placeholders}} in
 *     the delivered message,
 *   • the six-digit code is present in the message but never in logs,
 *   • Brevo failures are classified instead of becoming one generic sentence,
 *   • the admin console says "accepted", not "delivered", until Brevo reports
 *     a real delivery.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const design = require('../functions/email-design');
const brevo = require('../functions/brevo');
const notifications = require('../functions/notifications');

const SETTINGS = {
  enabled: true,
  senderName: 'Prayer Dome',
  senderEmail: 'noreply@prayerdome.net',
  replyTo: '',
  categories: Object.keys(notifications.EMAIL_CATEGORIES).reduce((out, key) => { out[key] = true; return out; }, {})
};

test('the brand identity comes from the live site', () => {
  assert.equal(design.BRAND.name, 'Prayer Dome');
  assert.equal(design.BRAND.tagline, 'A House of Prayer for All Nations');
  assert.equal(design.BRAND.siteUrl, 'https://prayerdome.net');
  assert.equal(design.BRAND.logoUrl, 'https://prayerdome.net/assets/logo.png');
  assert.equal(design.BRAND.contactEmail, 'info@prayerdome.net');
  assert.equal(design.BRAND.contactPhone, '+260 973 028 342');
  assert.equal(design.BRAND.blue, '#0A4D9B');
  assert.equal(design.BRAND.gold, '#D4AF37');
});

test('one renderer produces a responsive branded message and a text fallback', () => {
  const rendered = design.renderEmail({
    subject: 'Welcome, Grace',
    heading: 'Your account is ready',
    greeting: 'Dear Grace,',
    paragraphs: ['First line.', 'Second line.'],
    details: [['Reference', 'PD-1234'], ['Status', 'Active']],
    action: { label: 'Open my account', url: 'https://prayerdome.net/account.html' }
  });
  assert.equal(rendered.subject, 'Welcome, Grace');
  assert.match(rendered.html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(rendered.html, /@media only screen and \(max-width:620px\)/);
  assert.match(rendered.html, /assets\/logo\.png/);
  assert.match(rendered.html, /A House of Prayer for All Nations/);
  assert.match(rendered.html, /https:\/\/prayerdome\.net\/account\.html/);
  assert.match(rendered.html, /info@prayerdome\.net/);
  assert.match(rendered.text, /Dear Grace,/);
  assert.match(rendered.text, /Reference: PD-1234/);
  assert.match(rendered.text, /Open my account: https:\/\/prayerdome\.net\/account\.html/);
  assert.ok(!rendered.html.includes('{{'));
});

test('member-supplied values are escaped in HTML and the plain text is not', () => {
  const rendered = design.renderEmail({
    subject: 'A <b>subject</b>',
    heading: 'Hello <script>alert(1)</script>',
    paragraphs: ['<img src=x onerror=alert(1)>'],
    details: [['Reason', '<b>ID unclear</b>']]
  });
  assert.ok(!rendered.html.includes('<script>alert(1)</script>'));
  assert.ok(!rendered.html.includes('<img src=x'));
  assert.ok(rendered.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(rendered.html.includes('&lt;b&gt;ID unclear&lt;/b&gt;'));
  assert.ok(rendered.text.includes('<b>ID unclear</b>'));
});

test('only Prayer Dome and Firebase auth links may be used as a button', () => {
  assert.equal(design.safeActionUrl('/account.html'), 'https://prayerdome.net/account.html');
  assert.equal(design.safeActionUrl('https://prayerdome.net/give.html#record'), 'https://prayerdome.net/give.html#record');
  assert.equal(design.safeActionUrl('https://prayer-dome.firebaseapp.com/__/auth/action?x=1'),
    'https://prayer-dome.firebaseapp.com/__/auth/action?x=1');
  assert.match(design.safeActionUrl('javascript:alert(1)'), /^https:\/\/prayerdome\.net\//);
  assert.match(design.safeActionUrl('https://evil.example/phish'), /^https:\/\/prayerdome\.net\//);
});

const requestedEvents = [
  'email_verification', 'welcome', 'password_reset', 'password_changed', 'new_login',
  'account_security_alert', 'giving_submitted', 'giving_confirmed', 'giving_rejected',
  'prayer_request_confirmation', 'prayer_request_update', 'ministry_announcement',
  'newsletter_welcome'
];

test('every requested automatic email has a template and a category', () => {
  requestedEvents.forEach((event) => {
    const template = notifications.EVENTS[event];
    assert.ok(template, `${event} exists`);
    assert.ok(template.subject && template.heading && template.message, `${event} has copy`);
    assert.ok(Object.prototype.hasOwnProperty.call(notifications.EMAIL_CATEGORIES, template.category),
      `${event} has a known category`);
  });
  assert.equal(notifications.EVENTS.giving_submitted.category, 'giving');
  assert.equal(notifications.EVENTS.ministry_announcement.category, 'announcement');
  assert.equal(notifications.EVENTS.newsletter_welcome.category, 'newsletter');
});

test('every event renders without leaving a placeholder or an empty button', () => {
  const values = {
    name: 'Grace Phiri', status: 'Received', reference: 'PD-2026-001', plan: 'Education Bronze',
    amount: 'USD 5.00', reason: 'The reference did not match.', date: '22 November 2026',
    minutes: 10, code: '482913', resetLink: 'https://prayer-dome.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc',
    title: 'Prayer night', message: 'Join us on Friday at 19:00.', device: 'Chrome on Android'
  };
  Object.keys(notifications.EVENTS).forEach((event) => {
    const rendered = notifications.buildEmail(event, values, SETTINGS);
    assert.ok(rendered.subject.length > 3, `${event} has a subject`);
    assert.ok(rendered.html.includes('Prayer Dome'), `${event} carries the brand`);
    assert.ok(rendered.text.length > 50, `${event} has a text body`);
    assert.ok(!rendered.html.includes('{{'), `${event} left a placeholder`);
    assert.ok(!rendered.text.includes('{{'), `${event} left a text placeholder`);
    assert.match(rendered.html, /https:\/\/prayerdome\.net\//, `${event} has a safe link`);
  });
});

test('the verification code appears once in the email but not in its metadata', () => {
  const rendered = notifications.buildEmail('email_verification', {
    name: 'Grace', code: '482913', minutes: 10
  }, SETTINGS);
  assert.match(rendered.subject, /verification code/i);
  assert.match(rendered.html, /4 8 2 9 1 3/);
  assert.match(rendered.text, /482913/);
  assert.match(rendered.text, /expires in 10 minutes/i);
  assert.ok(!JSON.stringify({ subject: rendered.subject, actionUrl: rendered.actionUrl }).includes('482913'));
});

test('the password reset button uses the generated one-time link', () => {
  const link = 'https://prayer-dome.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc';
  const rendered = notifications.buildEmail('password_reset', { name: 'Grace', resetLink: link }, SETTINGS);
  assert.match(rendered.html, /__\/auth\/action\?mode=resetPassword&amp;oobCode=abc/);
  assert.match(rendered.text, /__\/auth\/action\?mode=resetPassword&oobCode=abc/);
  assert.equal(rendered.actionUrl, link);
});

/* ------------------------------------------------------------- Brevo */

function response(payload, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test('a missing Brevo key is reported as not configured, without inventing one', async () => {
  const result = await brevo.checkConnection({});
  assert.equal(result.configured, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_configured');
});

test('the connection check verifies the key with a GET and never returns it', async () => {
  const original = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    if (!captured) captured = { url, options };
    if (/\/senders$/.test(url)) return response({ senders: [{ email: 'noreply@prayerdome.net', active: true }] }, 200);
    return response({ companyName: 'Prayer Dome Ministry', email: 'owner@example.com' }, 200);
  };
  try {
    const result = await brevo.checkConnection({ BREVO_API_KEY: 'secret-key', BREVO_SENDER_EMAIL: 'noreply@prayerdome.net' });
    assert.equal(result.configured, true);
    assert.equal(result.ok, true);
    assert.equal(result.companyName, 'Prayer Dome Ministry');
    assert.equal(result.senderVerified, true);
    assert.equal(captured.url, 'https://api.brevo.com/v3/account');
    assert.equal(captured.options.method, 'GET');
    assert.equal(captured.options.headers['api-key'], 'secret-key');
    assert.ok(!JSON.stringify(result).includes('secret-key'));
  } finally {
    global.fetch = original;
  }
});

test('a rejected key is named as an authentication failure, not a generic outage', async () => {
  const original = global.fetch;
  global.fetch = async () => response({ code: 'unauthorized', message: 'Key not found' }, 401);
  try {
    const result = await brevo.checkConnection({ BREVO_API_KEY: 'revoked-key' });
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_failed');
    assert.match(result.message, /API key/i);
  } finally {
    global.fetch = original;
  }
});

test('the registration code email returns the provider message id and never the code to logs', async () => {
  const original = global.fetch;
  let sentBody;
  global.fetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return response({ messageId: '<provider-id@brevo>' }, 201);
  };
  try {
    const result = await brevo.sendRegistrationCodeEmail({
      email: 'grace@example.com', name: 'Grace', code: '482913', minutes: 10,
      env: { BREVO_API_KEY: 'test-key', BREVO_SENDER_EMAIL: 'noreply@prayerdome.net' }
    });
    assert.equal(result.sent, true);
    assert.equal(result.messageId, '<provider-id@brevo>');
    assert.match(sentBody.htmlContent, /4 8 2 9 1 3/);
    assert.ok(!JSON.stringify({ to: sentBody.to, sender: sentBody.sender }).includes('482913'));
    assert.ok(!JSON.stringify(sentBody).includes('test-key'));
  } finally {
    global.fetch = original;
  }
});

test('newsletter reads a streamed JSON body exactly once', async () => {
  const saved = process.env.BREVO_API_KEY;
  process.env.BREVO_API_KEY = 'test-key';
  const original = global.fetch;
  global.fetch = async () => response({ messageId: 'newsletter-1' }, 201);
  const bodyText = JSON.stringify({ email: 'member@example.com', consent: true });
  const req = {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.90' },
    on(event, callback) {
      if (event === 'data') callback(Buffer.from(bodyText));
      if (event === 'end') callback();
    }
  };
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(value) { this.body = value || ''; }
  };
  try {
    await brevo.newsletterHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  } finally {
    global.fetch = original;
    if (saved === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = saved;
  }
});

/* ------------------------------------------------------- admin + source */

test('the admin console never calls an accepted message delivered', () => {
  const script = fs.readFileSync(path.join(ROOT, 'assets/pd-email-admin.js'), 'utf8');
  assert.ok(!script.includes('Email delivery is temporarily unavailable. Deploy the functions and try again.'));
  assert.match(script, /Brevo accepted the test message/);
  assert.match(script, /not proof of delivery/);
  assert.match(script, /refreshEmailProviderStatus/);
  assert.match(script, /checkEmailDiagnostics/);
  assert.match(script, /accepted by Brevo/i);
  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  assert.match(admin, /Provider response/);
  assert.match(admin, /Failure reason/);
  assert.match(admin, /Check connection/);
});

test('the registration code is stored before it is emailed and uses a slow hash', () => {
  const source = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  const store = source.indexOf("deliveryStatus: 'sending'");
  const send = source.indexOf('brevo.sendRegistrationCodeEmail');
  assert.ok(store > 0 && send > store, 'the record is reserved before delivery');
  assert.match(source, /crypto\.scryptSync/);
  assert.match(source, /hashAlgo: 'scrypt'/);
  assert.match(source, /cleanupRegistrationVerification/);
  assert.match(source, /status: 'accepted'/);
});

test('giving, prayer, announcement and security events are wired to a trigger', () => {
  const source = fs.readFileSync(path.join(ROOT, 'functions/notifications.js'), 'utf8');
  assert.match(source, /document\('offerings\/\{reference\}'\)\.onWrite/);
  assert.match(source, /event = 'giving_submitted'/);
  assert.match(source, /event = 'giving_confirmed'/);
  assert.match(source, /event: 'prayer_request_update'/);
  assert.match(source, /document\('announcements\/\{id\}'\)\.onCreate/);
  assert.match(source, /event: 'ministry_announcement'/);
  const index = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  assert.match(index, /event: 'welcome'/);
  assert.match(index, /exports\.requestPasswordReset/);
  assert.match(index, /exports\.notifyNewLogin/);
});

test('guest giving, Google welcome and password-change mail share the same service', () => {
  const notifications = fs.readFileSync(path.join(ROOT, 'functions/notifications.js'), 'utf8');
  assert.match(notifications, /deliverDirect\(\{ event, eventId: id, to, name: values\.name, values, link: '\/give\.html' \}\)/);
  assert.match(notifications, /document\('users\/\{uid\}'\)\.onCreate\(notifyNewUser\)/);
  assert.match(notifications, /eventId: 'evt_welcome_' \+ context\.params\.uid/);
  const index = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  assert.match(index, /exports\.notifyPasswordChanged/);
  assert.match(index, /exports\.userWelcomeNotifications/);
  const account = fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8');
  assert.match(account, /notifyPasswordChangedCall\(\{ device: pdDeviceLabel\(\) \}\)/);
  assert.match(account, /updatePassword\(user, next\)/);
});
