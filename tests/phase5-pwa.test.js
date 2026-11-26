'use strict';

/*
 * Phase 5 PWA contracts: a working Android share target, no dead file handler,
 * and the existing install/update architecture preserved.
 *
 * Run: node tests/phase5-pwa.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const vercel = JSON.parse(read('vercel.json'));
const firebase = JSON.parse(read('firebase.json'));
const intake = read('share-intake.html');
const app = read('assets/pd-app.js');
let passed = 0;
function t(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS  ' + name); }
  else { console.error('FAIL  ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1; }
}

/* ------------------------------------------------------------ share target */
t('the declared share target matches the implemented page route',
  manifest.share_target && manifest.share_target.action === '/share' &&
  ['title', 'text', 'url'].every((key) => manifest.share_target.params[key] === key));
t('Vercel and Firebase both route bare /share to the intake page',
  vercel.rewrites.some((rule) => rule.source === '/share' && rule.destination === '/share-intake.html') &&
  firebase.hosting.rewrites.some((rule) => rule.source === '/share' && rule.destination === '/share-intake.html'));
t('the typed /share/:type/:id metadata routes remain intact',
  vercel.rewrites.some((rule) => rule.source === '/share/:type/:id' && rule.destination === '/api/share?type=:type&id=:id') &&
  firebase.hosting.rewrites.some((rule) => rule.source === '/share/**' && rule.function === 'share'));
t('the local dev server honours the same exact page rewrite',
  read('scripts/dev-server.mjs').includes('pageRewrite') &&
  read('scripts/dev-server.mjs').includes("rule.source === pathname"));
t('the share target page is precached for offline use',
  read('sw.js').includes("'/share-intake.html'") && read('sw.js').includes("'/share'"));
t('no unsupported file-handler declaration remains',
  !manifest.file_handlers && !read('resource-view.html').includes('launchQueue'));

/* Exercise the real inline intake logic. */
for (const [label, query, check] of [
  ['title, text and a safe URL', '?title=Prayer+for+Zambia&text=Lord+hear+us&url=https%3A%2F%2Fprayerdome.net%2Fprayer',
    (d) => d.getElementById('siTitle').textContent === 'Prayer for Zambia' &&
      d.getElementById('siText').textContent === 'Lord hear us' &&
      d.getElementById('siUrl').href === 'https://prayerdome.net/prayer' &&
      !d.getElementById('siOpen').hidden],
  ['dangerous URL schemes are ignored', '?title=Test&url=javascript%3Aalert(1)',
    (d) => d.getElementById('siOpen').hidden && d.getElementById('siUrlRow').hidden],
  ['an empty share shows the friendly empty state', '?title=&text=&url=',
    (d) => !d.getElementById('siEmpty').hidden && d.getElementById('siContent').hidden]
]) {
  const dom = new JSDOM(intake, {
    url: 'https://www.prayerdome.net/share' + query,
    runScripts: 'dangerously', virtualConsole: new VirtualConsole()
  });
  t('the intake page handles ' + label, check(dom.window.document));
  dom.window.close();
}
t('shared values are rendered as text, never as HTML',
  intake.includes("$('siTitle').textContent") && intake.includes("$('siText').textContent") &&
  !/\$\('si(Title|Text)'\)\.innerHTML/.test(intake));
t('the intake page can re-share and copy without a backend',
  intake.includes('navigator.share(shareData)') && intake.includes('navigator.clipboard.writeText(value)'));

/* -------------------------------------------------- install architecture */
t('the manifest still declares installable icons, screenshots and shortcuts',
  manifest.display === 'standalone' && manifest.icons.length >= 4 &&
  manifest.screenshots.length >= 2 && manifest.shortcuts.length >= 8);
t('install prompt, iOS guidance and update bar remain in the app shell',
  app.includes('beforeinstallprompt') && /iOS|Add to Home Screen/i.test(app) &&
  app.includes('update'));

console.log(`\n${passed} phase 5 PWA assertions passed.`);
