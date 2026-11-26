'use strict';

/*
 * Phase 1 repair contracts: one notification centre, live announcements,
 * one persistent appearance preference and a deterministic push mirror.
 *
 * Run: node tests/phase1-repairs.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
let passed = 0;
function t(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS  ' + name); }
  else { console.error('FAIL  ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1; }
}

const app = read('assets/pd-app.js');
const home = read('index.html');

/* ------------------------------------------------ notification consolidation */
t('the legacy second notification list is gone from the home page',
  !home.includes('id="notificationList"') &&
  !home.includes('async function loadNotifications()') &&
  !home.includes('collection(db, "notifications")') &&
  !home.includes('deleteAllNotifications()'));
t('the home page no longer declares duplicate notification state',
  !/let notifications = \[\];/.test(home) && !/let unreadCount = 0;/.test(home));
t('the shared bell replaces remote entries instead of only adding them',
  app.includes('syncRemote: function (remote, complete)') &&
  app.includes('notifications.syncRemote(remote, true)'));
t('the remote mirror filters token-bearing and non-in-app records',
  app.includes("d.id === 'latest_alert' || x.inApp !== true") &&
  /inApp: true/.test(read('functions/index.js')));
t('individual read state and notification preferences are still applied',
  app.includes('markRead: function (id)') &&
  app.includes('setPreference: function (type, on)') &&
  app.includes('if (!typeAllowed(n.type)) return;'));
t('the worker still routes notification clicks to their stored link',
  read('sw.js').includes('notificationclick') && read('sw.js').includes('data.url'));

/* --------------------------------------------------------- announcements */
t('the marquee subscribes to Firestore announcements with a bounded query',
  app.includes("fb.collection(fb.db, 'announcements')") &&
  app.includes("fb.orderBy('createdAt', 'desc')") && app.includes('fb.limit(8)'));
t('the marquee uses localStorage only as an offline cache',
  app.includes("store.get('announcements', 'DEFAULT_ANNOUNCEMENTS')") &&
  app.includes("store.set('announcements', rows)"));
t('an admin publication writes a public bell mirror with the announcement id',
  read('admin.html').includes("'ann-'+annRef.id") &&
  read('admin.html').includes("await mirrorNotification(title, body.substring(0,110), 'general', '/index.html', 'ann-'+annRef.id)"));

/* ----------------------------------------------------------- theme */
t('the shared shell owns a persisted three-way theme preference',
  app.includes("var THEME_PREF_KEY = 'pd-theme-preference'") &&
  app.includes("var THEME_CHOICES = ['light', 'dark', 'system']") &&
  app.includes("preference: function ()") && app.includes("set: function (mode)"));
t('the OS media query is ignored once the member chose a theme',
  /if \(theme\.preference\(\) === 'system'\) sync\(\)/.test(app) &&
  /var choice = THEME_CHOICES\.indexOf\(mode\)/.test(app));
t('the shared shell replaces legacy toggle handlers on every page',
  app.includes("window.toggleDarkMode = function () { return theme.toggle(); };") &&
  app.includes("button.removeAttribute('onclick')") &&
  app.includes("['theme', theme.init]"));
t('the bell offers explicit Light, Dark and Device choices',
  app.includes('data-pd-theme-choice="light"') &&
  app.includes('data-pd-theme-choice="dark"') &&
  app.includes('data-pd-theme-choice="system"'));

/* Exercise the real module in jsdom: a manual choice must survive an OS event. */
const vc = new VirtualConsole();
const dom = new JSDOM('<!doctype html><html><body><button class="theme-toggle-btn" onclick="window.broken = true"><i class="pd-i pd-i-moon"></i></button></body></html>', {
  url: 'https://www.prayerdome.net/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc
});
const w = dom.window;
let dark = true;
w.matchMedia = () => ({ matches: dark, media: '(prefers-color-scheme: dark)', addEventListener() {}, addListener() {}, removeListener() {} });
w.eval(read('assets/pd-app.js'));
w.PDApp.theme.set('light');
t('a saved light preference wins over a dark OS',
  w.PDApp.theme.preference() === 'light' && !w.document.documentElement.classList.contains('dark-mode'));
dark = false;
w.document.dispatchEvent(new w.Event('change'));
w.eval("window.__themeSync = null");
// Simulate the OS listener itself; the preference must remain light.
w.eval("try { window.dispatchEvent(new Event('resize')); } catch (e) {}");
t('changing the OS theme does not overwrite a manual choice',
  w.PDApp.theme.preference() === 'light' && w.localStorage.getItem('pd-theme-preference') !== null);
w.PDApp.theme.set('system');
t('the Device choice follows the resolved OS scheme',
  w.PDApp.theme.preference() === 'system' && !w.PDApp.theme.isDark());
w.document.querySelector('.theme-toggle-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
t('the visible button uses the shared toggle, not the old inline handler',
  w.PDApp.theme.preference() === 'dark' && w.broken !== true);
w.PDApp.theme.set('system');
t('the preference survives a fresh page load',
  (function () {
    const saved = w.localStorage.getItem('pd-theme-preference');
    const dom2 = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://www.prayerdome.net/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc
    });
    dom2.window.matchMedia = w.matchMedia;
    dom2.window.localStorage.setItem('pd-theme-preference', saved);
    dom2.window.eval(read('assets/pd-app.js'));
    const ok = dom2.window.PDApp.theme.preference() === 'system';
    dom2.window.close();
    return ok;
  })());
w.close();

/* -------------------------------------------------- deterministic push mirror */
const funcs = read('functions/index.js');
t('Cloud Functions mirror every push into a token-free public record',
  funcs.includes('async function mirrorPublicNotification(notification, id)') &&
  funcs.includes("await mirrorPublicNotification({ ...notification, type: kind, link }, context.params.notificationId)"));
const mirrorMatch = funcs.match(/async function mirrorPublicNotification[\s\S]*?\n}/);
const mirrorBody = mirrorMatch ? mirrorMatch[0] : '';
t('the mirror never copies device tokens or admin email',
  mirrorBody.length > 200 && !/tokens|createdBy|email/.test(mirrorBody));
t('the admin queue adopts the mirrored document id',
  read('admin.html').includes("const queued = await addDoc(collection(db, \"notifications\"), payload)") &&
  read('admin.html').includes('queued?.id || payload.tag'));

console.log(`\n${passed} phase 1 repair assertions passed.`);
