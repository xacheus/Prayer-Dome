'use strict';

/*
 * Transactional email content and idempotency checks. These run without a
 * Firebase project: buildEmail, eventId and normalizeSettings are pure, so the
 * wording, escaping and deterministic event ids can be verified in CI.
 */

const assert = require('assert');
const {
  EVENTS,
  EMAIL_CATEGORIES,
  buildEmail,
  eventId,
  normalizeSettings
} = require('../functions/notifications');

const SETTINGS = {
  enabled: true,
  senderName: 'Prayer Dome',
  senderEmail: 'noreply@prayerdome.net',
  replyTo: '',
  categories: Object.keys(EMAIL_CATEGORIES).reduce((out, key) => { out[key] = true; return out; }, {})
};

const required = [
  'membership_submitted', 'membership_approved', 'membership_rejected', 'membership_info_required',
  'membership_suspended', 'church_id_issued', 'church_id_rejected', 'church_id_suspended',
  'church_id_revoked', 'payment_submitted', 'payment_approved', 'payment_rejected',
  'subscription_activated', 'subscription_expiring', 'subscription_expired', 'subscription_renewed',
  'certificate_requested', 'certificate_approved', 'certificate_rejected', 'certificate_ready',
  'prayer_received', 'testimony_submitted', 'testimony_approved', 'testimony_rejected',
  'support_claim_submitted', 'support_claim_approved', 'support_claim_rejected'
];

required.forEach((event) => {
  assert.ok(EVENTS[event], `${event} is a supported notification event`);
  assert.ok(EVENTS[event].subject, `${event} has a subject`);
  assert.ok(EVENTS[event].heading, `${event} has a heading`);
  assert.ok(EVENTS[event].message, `${event} has a message`);
  assert.ok(EVENTS[event].inAppTitle, `${event} has an in-app title`);
  assert.ok(Object.prototype.hasOwnProperty.call(EMAIL_CATEGORIES, EVENTS[event].category),
    `${event} belongs to a known email category`);
});

// Approval and rejection copy must state the actual outcome, not a generic
// thank-you, and the rejection must carry the administrator's real reason.
const approved = buildEmail('payment_approved', {
  name: 'Grace Phiri', reference: 'PD-SUB-20261122-AB12CD34EF', amount: 'USD 5.00',
  plan: 'Education Bronze', status: 'Approved', date: '22 November 2026'
}, SETTINGS);
assert.match(approved.subject, /approved/i);
assert.match(approved.html, /PRAYER DOME/);
assert.match(approved.html, /https:\/\/prayerdome\.net\/support\.html#myplans/);
assert.match(approved.text, /Grace Phiri/);
assert.match(approved.text, /PD-SUB-20261122-AB12CD34EF/);

const rejected = buildEmail('payment_rejected', {
  name: 'Grace Phiri', reference: 'PD-SUB-20261122-AB12CD34EF', amount: 'USD 5.00',
  status: 'Rejected', reason: 'The proof of payment is unreadable.'
}, SETTINGS);
assert.match(rejected.subject, /payment/i);
assert.match(rejected.html, /The proof of payment is unreadable\./);
assert.match(rejected.text, /Reason: The proof of payment is unreadable\./);
assert.match(rejected.html, /Status/);

// Member-supplied text is HTML-escaped in the real email, and a custom template
// keeps intentional paragraph breaks.
const escaped = buildEmail('membership_rejected', {
  name: '<img src=x onerror=alert(1)>', status: 'Rejected', reason: '<b>ID unclear</b>'
}, SETTINGS);
assert.ok(!escaped.html.includes('<img src=x'));
assert.ok(escaped.html.includes('&lt;img src=x'));
assert.ok(escaped.html.includes('&lt;b&gt;ID unclear&lt;/b&gt;'));

const custom = buildEmail('membership_approved', {
  name: 'Grace', status: 'Approved', reference: 'PD20260001'
}, SETTINGS, {
  subject: 'Welcome, {{name}}',
  heading: 'Your membership is active',
  message: 'First paragraph.\nSecond paragraph about {{reference}}.',
  actionLabel: 'Open my account',
  actionPath: '/account.html'
});
assert.match(custom.subject, /Welcome, Grace/);
assert.ok(custom.html.includes('First paragraph.'));
assert.ok(custom.html.includes('Second paragraph about PD20260001.'));

// A deterministic id is both the outbox document id and the duplicate guard.
const one = eventId('payment_approved', 'uid with spaces/and#symbols', 'PD-SUB-1');
const two = eventId('payment_approved', 'uid with spaces/and#symbols', 'PD-SUB-1');
assert.strictEqual(one, two, 'the same event produces the same id');
assert.match(one, /^evt_payment_approved_uid-with-spaces-and-symbols_PD-SUB-1$/);
assert.ok(one.length <= 180);
assert.notStrictEqual(one, eventId('payment_approved', 'other-user', 'PD-SUB-1'));

// Settings default to the verified Prayer Dome sender and allow an admin to
// disable a category without inventing a credential.
const defaults = normalizeSettings(null);
assert.strictEqual(defaults.senderEmail, 'noreply@prayerdome.net');
assert.strictEqual(defaults.enabled, true);
assert.strictEqual(defaults.categories.billing, true);
const changed = normalizeSettings({
  enabled: false,
  senderName: 'Prayer Dome Ministry',
  senderEmail: 'noreply@prayerdome.net',
  categories: { billing: false }
});
assert.strictEqual(changed.enabled, false);
assert.strictEqual(changed.categories.billing, false);
assert.strictEqual(changed.categories.account, true);
assert.ok(!changed.senderName.includes('{{'));

// Essential mail ignores opt-out at the category level; optional categories are
// represented in the prefs UI.
assert.strictEqual(EVENTS.membership_approved.essential, true);
assert.strictEqual(EVENTS.payment_approved.essential, true);
assert.strictEqual(EVENTS.prayer_received.essential, false);
assert.strictEqual(EVENTS.testimony_rejected.essential, false);

console.log(`Email notification content checks passed (${required.length} events).`);
