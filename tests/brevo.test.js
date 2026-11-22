'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const brevo = require('../functions/brevo');

const CONFIGURED = {
  BREVO_API_KEY: 'test-key-not-real',
  BREVO_SENDER_EMAIL: 'noreply@prayerdome.net',
  BREVO_SENDER_NAME: 'Prayer Dome',
  BREVO_LIST_ID: '7',
  BREVO_DOI_TEMPLATE_ID: '9',
  PD_SITE_URL: 'https://prayerdome.net'
};

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.body = body || ''; },
    json() { return JSON.parse(this.body); }
  };
}

function mockRequest({ method = 'POST', body = {}, ip = '203.0.113.1' } = {}) {
  return {
    method,
    body,
    headers: { 'x-forwarded-for': ip },
    on() {}
  };
}

function captureFetch(payload = {}, status = 201) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload)
    };
  };
  return { calls, restore() { global.fetch = original; } };
}

test('isConfigured only needs the API key and never a baked-in key', () => {
  assert.equal(brevo.isConfigured({}), false);
  assert.equal(brevo.isConfigured({ BREVO_API_KEY: '   ' }), false);
  assert.equal(brevo.isConfigured({ BREVO_API_KEY: 'x' }), true);
});

test('cleanEmail normalises and rejects unusable addresses', () => {
  assert.equal(brevo.cleanEmail('  Member@Example.COM '), 'member@example.com');
  assert.equal(brevo.cleanEmail('not-an-email'), '');
  assert.equal(brevo.cleanEmail('a@b'), '');
  assert.equal(brevo.cleanEmail('x@y.z'), '');
  assert.equal(brevo.cleanEmail('a'.repeat(250) + '@example.com'), '');
  assert.equal(brevo.cleanEmail(null), '');
});

test('sendVerificationEmail returns not-configured instead of throwing', async () => {
  const result = await brevo.sendVerificationEmail({
    email: 'member@example.com',
    link: 'https://prayerdome.net/__/auth/action?mode=verifyEmail',
    env: {}
  });
  assert.deepEqual(result, { sent: false, reason: 'not-configured' });
});

test('sendVerificationEmail sends a branded transactional message', async () => {
  const fetchMock = captureFetch({ messageId: 'abc' });
  try {
    const result = await brevo.sendVerificationEmail({
      email: 'Member@Example.com',
      name: 'Thandi <script>',
      link: 'https://prayerdome.net/__/auth/action?mode=verifyEmail&oobCode=1',
      env: CONFIGURED
    });
    assert.deepEqual(result, { sent: true, provider: 'brevo' });
    assert.equal(fetchMock.calls.length, 1);
    const { url, options, body } = fetchMock.calls[0];
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(options.headers['api-key'], CONFIGURED.BREVO_API_KEY);
    assert.equal(body.to[0].email, 'member@example.com');
    assert.equal(body.sender.email, 'noreply@prayerdome.net');
    assert.match(body.subject, /Confirm your email/);
    assert.match(body.htmlContent, /Confirm my email/);
    assert.match(body.textContent, /verifyEmail/);
    assert.ok(!body.htmlContent.includes('<script>'), 'name must be escaped in HTML');
    assert.ok(!JSON.stringify(body).includes('test-key-not-real'), 'API key must not leak into the message');
  } finally {
    fetchMock.restore();
  }
});

test('sendVerificationEmail validates its inputs before calling Brevo', async () => {
  await assert.rejects(
    brevo.sendVerificationEmail({ email: 'bad', link: 'https://x.test', env: CONFIGURED }),
    /valid email/i
  );
  await assert.rejects(
    brevo.sendVerificationEmail({ email: 'a@example.com', link: 'javascript:alert(1)', env: CONFIGURED }),
    /verification link/i
  );
});

test('subscribe prefers double opt-in when list and template are configured', async () => {
  const fetchMock = captureFetch({ messageId: 'doi' });
  try {
    const result = await brevo.subscribe({ email: 'member@example.com', name: ' Ada ', consent: true, env: CONFIGURED });
    assert.deepEqual(result, { ok: true, doubleOptIn: true });
    const { url, body } = fetchMock.calls[0];
    assert.equal(url, 'https://api.brevo.com/v3/contacts/doubleOptinConfirmation');
    assert.deepEqual(body.includeListIds, [7]);
    assert.equal(body.templateId, 9);
    assert.equal(body.redirectionUrl, 'https://prayerdome.net/support?subscribed=1');
    assert.equal(body.attributes.FIRSTNAME, 'Ada');
    assert.equal(body.attributes.SOURCE, 'support-page');
  } finally {
    fetchMock.restore();
  }
});

test('subscribe falls back to a list contact and treats duplicates as success', async () => {
  const env = { ...CONFIGURED, BREVO_DOI_TEMPLATE_ID: '' };
  let fetchMock = captureFetch({ id: 12 });
  try {
    const result = await brevo.subscribe({ email: 'member@example.com', consent: true, env });
    assert.deepEqual(result, { ok: true, doubleOptIn: false });
    assert.equal(fetchMock.calls[0].url, 'https://api.brevo.com/v3/contacts');
    assert.deepEqual(fetchMock.calls[0].body.listIds, [7]);
    assert.equal(fetchMock.calls[0].body.updateEnabled, true);
  } finally {
    fetchMock.restore();
  }

  fetchMock = captureFetch({ code: 'duplicate_parameter', message: 'Contact already exist' }, 400);
  try {
    const result = await brevo.subscribe({ email: 'member@example.com', consent: true, env });
    assert.deepEqual(result, { ok: true, doubleOptIn: false });
  } finally {
    fetchMock.restore();
  }
});

test('subscribe requires explicit consent and a valid address', async () => {
  await assert.rejects(brevo.subscribe({ email: 'member@example.com', consent: false, env: CONFIGURED }), /agree/i);
  await assert.rejects(brevo.subscribe({ email: 'nope', consent: true, env: CONFIGURED }), /valid email/i);
  const result = await brevo.subscribe({ email: 'member@example.com', consent: true, env: {} });
  assert.deepEqual(result, { ok: false, reason: 'not-configured' });
});

test('newsletterHandler enforces POST, consent, and a valid address', async () => {
  let res = mockResponse();
  await brevo.newsletterHandler(mockRequest({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');

  res = mockResponse();
  await brevo.newsletterHandler(mockRequest({ body: { email: 'nope', consent: true }, ip: '203.0.113.2' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'INVALID_EMAIL');

  res = mockResponse();
  await brevo.newsletterHandler(mockRequest({ body: { email: 'a@example.com' }, ip: '203.0.113.3' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'CONSENT_REQUIRED');
});

test('newsletterHandler absorbs honeypot submissions', async () => {
  const res = mockResponse();
  await brevo.newsletterHandler(mockRequest({ body: { email: 'a@example.com', consent: true, website: 'spam' }, ip: '203.0.113.4' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('newsletterHandler reports not-configured without exposing internals', async () => {
  const saved = {};
  for (const key of Object.keys(CONFIGURED)) { saved[key] = process.env[key]; delete process.env[key]; }
  try {
    const res = mockResponse();
    await brevo.newsletterHandler(mockRequest({ body: { email: 'a@example.com', consent: true }, ip: '203.0.113.5' }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'NOT_CONFIGURED');
    assert.ok(!res.body.includes('test-key'));
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
});

test('newsletterHandler succeeds and reports double opt-in', async () => {
  const saved = {};
  for (const key of Object.keys(CONFIGURED)) { saved[key] = process.env[key]; process.env[key] = CONFIGURED[key]; }
  const fetchMock = captureFetch({ messageId: 'doi' });
  try {
    const res = mockResponse();
    await brevo.newsletterHandler(mockRequest({ body: { email: 'Member@Example.com', name: 'Ada', consent: true }, ip: '203.0.113.6' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(res.json().doubleOptIn, true);
    assert.match(res.json().message, /confirm/i);
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    fetchMock.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('newsletterHandler returns 502 when Brevo rejects the request', async () => {
  const saved = {};
  for (const key of Object.keys(CONFIGURED)) { saved[key] = process.env[key]; process.env[key] = CONFIGURED[key]; }
  const fetchMock = captureFetch({ code: 'unauthorized', message: 'Key not found' }, 401);
  try {
    const res = mockResponse();
    await brevo.newsletterHandler(mockRequest({ body: { email: 'a@example.com', consent: true }, ip: '203.0.113.7' }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'BREVO_UNAVAILABLE');
    assert.ok(!res.body.includes(CONFIGURED.BREVO_API_KEY));
  } finally {
    fetchMock.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('newsletterHandler spaces out repeated requests from one address', async () => {
  const ip = '198.51.100.42';
  let statuses = [];
  for (let i = 0; i < 7; i += 1) {
    const res = mockResponse();
    await brevo.newsletterHandler(mockRequest({ body: { email: 'nope', consent: true }, ip }), res);
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses.slice(0, 6), [400, 400, 400, 400, 400, 400]);
  assert.equal(statuses[6], 429);
});
