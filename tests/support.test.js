'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const page = fs.readFileSync('support.html', 'utf8');

test('the support page shows more than the three programme cards', () => {
  const dom = new JSDOM(page);
  const document = dom.window.document;
  const view = document.querySelector('#view-programs');
  assert.ok(view, 'programme view must exist');
  const sections = [...view.querySelectorAll(':scope > section.sp-section')];
  assert.ok(sections.length >= 5, `expected the new information sections, found ${sections.length}`);

  for (const id of ['howSupportWorks', 'supportImpact', 'supportQuestions', 'supportUpdates', 'supportHelp']) {
    assert.ok(document.getElementById(id), `missing #${id}`);
  }
  assert.equal(document.querySelectorAll('.sp-steps .sp-step').length, 4);
  assert.equal(document.querySelectorAll('.sp-impact-card').length, 3);
  assert.equal(document.querySelectorAll('.sp-faq details').length, 7);
});

test('every new support image is a real file with dimensions set', () => {
  const dom = new JSDOM(page);
  const images = [...dom.window.document.querySelectorAll('.sp-impact-card img')];
  assert.equal(images.length, 3);
  for (const image of images) {
    const src = image.getAttribute('src');
    assert.match(src, /^\/assets\/support\/support-[a-z-]+\.jpg$/);
    assert.ok(fs.existsSync(src.slice(1)), `${src} must exist`);
    assert.ok(Number(image.getAttribute('width')) > 0);
    assert.ok(Number(image.getAttribute('height')) > 0);
    assert.ok((image.getAttribute('alt') || '').length > 20, 'alt text must describe the photo');
    assert.equal(image.getAttribute('loading'), 'lazy');
  }
});

function harness(url = 'https://prayerdome.net/support') {
  const dom = new JSDOM(page, { url, runScripts: 'outside-only' });
  const { window } = dom;
  window.eval(fs.readFileSync('assets/pd-newsletter.js', 'utf8'));
  window.PDNewsletter.init();
  const form = window.document.querySelector('form[data-pd-newsletter]');
  const email = form.querySelector('[name="email"]');
  const consent = form.querySelector('[name="consent"]');
  const name = form.querySelector('[name="name"]');
  const status = form.querySelector('[data-pd-newsletter-status]');
  return { window, form, email, consent, name, status };
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test('the updates form posts one consenting address to /api/newsletter', async () => {
  const { window, form, email, consent, name, status } = harness();
  const calls = [];
  window.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, doubleOptIn: true }) };
  };
  email.value = '  Member@Example.com ';
  name.value = 'Ada';
  consent.checked = true;
  await submit(window, form);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/newsletter');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].body.email, 'member@example.com');
  assert.equal(calls[0].body.name, 'Ada');
  assert.equal(calls[0].body.consent, true);
  assert.equal(calls[0].body.website, '');
  assert.match(status.textContent, /confirm the subscription/i);
  assert.equal(status.dataset.state, 'success');
});

test('the updates form refuses a bad address or missing consent without a request', async () => {
  const { window, form, email, consent, status } = harness();
  let called = 0;
  window.fetch = async () => { called += 1; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };

  email.value = 'not-an-email';
  consent.checked = true;
  await submit(window, form);
  assert.equal(called, 0);
  assert.match(status.textContent, /valid email/i);
  assert.equal(status.dataset.state, 'error');

  email.value = 'member@example.com';
  consent.checked = false;
  await submit(window, form);
  assert.equal(called, 0);
  assert.match(status.textContent, /tick the box/i);
});

test('the updates form explains an unconfigured or failing endpoint', async () => {
  const { window, form, email, consent, status } = harness();
  email.value = 'member@example.com';
  consent.checked = true;

  window.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'NOT_CONFIGURED' }) });
  await submit(window, form);
  assert.match(status.textContent, /info@prayerdome\.net/);
  assert.equal(status.dataset.state, 'info');

  window.fetch = async () => { throw new Error('offline'); };
  await submit(window, form);
  assert.match(status.textContent, /connection failed/i);
  assert.equal(status.dataset.state, 'error');
});

test('the account page asks the Brevo callable and keeps Firebase as fallback', () => {
  const account = fs.readFileSync('account.html', 'utf8');
  assert.match(account, /httpsCallable\(cloudFunctions, 'sendBrevoVerificationEmail'\)/);
  assert.match(account, /await sendEmailVerification\(user\)/);
  assert.match(account, /firebase-functions\.js/);
});

test('the callable generates a real Firebase link and never trusts a caller link', () => {
  const source = fs.readFileSync('functions/index.js', 'utf8');
  assert.match(source, /exports\.sendBrevoVerificationEmail = functions\.runWith\(\{ secrets: \[brevoApiKey\] \}\)\.https\.onCall/);
  assert.match(source, /admin\.auth\(\)\.generateEmailVerificationLink\(email/);
  assert.match(source, /exports\.brevoSubscribe = functions\.runWith\(\{ secrets: \[brevoApiKey\] \}\)\.https\.onRequest/);
  assert.ok(!/data\.link/.test(source), 'the verification link must come from Firebase Admin, not the caller');
  const firebase = JSON.parse(fs.readFileSync('firebase.json', 'utf8'));
  assert.ok(firebase.hosting.rewrites.some((rule) => rule.source === '/api/newsletter' && rule.function === 'brevoSubscribe'));
  const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  assert.ok(vercel.rewrites.some((rule) => rule.source === '/api/newsletter' && rule.destination.startsWith('/api/system?op=newsletter')));
  assert.ok(fs.existsSync('api/system.js'));
  assert.ok(!fs.existsSync('api/newsletter.js'), 'the newsletter must not add a 13th Hobby serverless function');
});

test('the double opt-in return message is shown once and the query string is cleaned', () => {
  const { window, status } = harness('https://prayerdome.net/support?subscribed=1');
  assert.match(status.textContent, /subscription is confirmed/i);
  assert.equal(status.dataset.state, 'success');
  assert.equal(window.location.search, '');
});
