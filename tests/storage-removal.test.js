/*
 * Firebase Storage removal + shared design-polish regression checks.
 *
 * The app keeps Firebase Authentication and Firestore. Media and documents
 * now go through the existing Cloudinary upload service (PDUpload) or, for
 * radio broadcast audio, the optional Cloudflare R2 endpoint. This suite
 * stops the old bucket, SDK import and public preset from creeping back in.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sourceFiles = [
  ...fs.readdirSync(ROOT).filter((name) => name.endsWith('.html')).map((name) => name),
  ...fs.readdirSync(path.join(ROOT, 'assets')).filter((name) => name.endsWith('.js')).map((name) => path.join('assets', name)),
  'api/system.js', 'api/radio.js', 'lib/billing-server.js',
  'functions/billing.js', 'functions/index.js', 'functions/r2.js',
  'sw.js', 'firebase-messaging-sw.js'
];

test('no shipped source imports or configures Firebase Storage', () => {
  const banned = [
    /firebase-storage\.js/,
    /getStorage\s*\(/,
    /storageBucket\s*:/,
    /firebasestorage\.app/,
    /admin\.storage\s*\(/,
    /getSignedUrl\s*\(/
  ];
  for (const file of sourceFiles) {
    const source = read(file);
    for (const pattern of banned) {
      assert.doesNotMatch(source, pattern, `${file} still references Firebase Storage (${pattern})`);
    }
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'storage.rules')), false,
    'storage.rules must be removed with the bucket');
  const firebase = JSON.parse(read('firebase.json'));
  assert.equal(firebase.storage, undefined, 'firebase.json must not deploy a Storage bucket');
});

test('all user uploads use the shared Cloudinary service', () => {
  const support = read('support.html');
  assert.match(support, /PDUpload\.uploadPrivate\(file, 'billingEvidence'\)/);
  assert.match(support, /PDUpload\.uploadPrivate\(file, 'givingEvidence'\)/);
  assert.match(support, /payload\.evidenceUrl = checkoutEvidence\.url/);

  const give = read('give.html');
  assert.match(give, /PDUpload\.uploadPrivate\(file, 'givingEvidence'\)/);
  assert.match(give, /\/assets\/pd-upload\.js/);

  for (const page of ['event.html', 'events.html']) {
    assert.match(read(page), /PDUpload\.upload\(eventImage, \{ preset: 'news_images', folder: 'events' \}\)/,
      `${page} must upload event images through Cloudinary`);
  }
  assert.match(read('chat.html'), /PDUpload\.upload\(file, \{ preset: 'gallery_uploads', folder: 'chat_media' \}\)/);
  assert.match(read('assets/pd-radio-admin.js'), /PDUpload\.uploadPrivate\(file, 'radioAudio\/' \+ kind/);
  assert.match(read('admin.html'), /\/assets\/pd-upload\.js/);
});

test('private uploads get unguessable ids and no browser-held secrets', () => {
  const uploader = read('assets/pd-upload.js');
  assert.match(uploader, /uploadPrivate: function/);
  assert.match(uploader, /publicId: 'pd-' \+ random/);
  assert.match(uploader, /form\.append\('public_id', opts\.publicId\)/);
  assert.doesNotMatch(uploader, /api_secret|apiSecret|CLOUDINARY_API_SECRET/);
  const billing = read('functions/billing.js');
  assert.doesNotMatch(billing, /admin\.storage\(\)|getSignedUrl\(/);
  assert.match(billing, /retired Firebase Storage bucket/);
});

test('the shared interaction polish is loaded on every page', () => {
  const css = read('assets/pd-responsive-fix.css');
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /font-size: 16px/);
  assert.match(css, /prefers-reduced-motion/);
  for (const page of fs.readdirSync(ROOT).filter((name) => name.endsWith('.html'))) {
    assert.match(read(page), /\/assets\/pd-responsive-fix\.css/,
      `${page} must load the shared design polish`);
  }
});
