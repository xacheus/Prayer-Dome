'use strict';

/*
 * Phase 3 notification branding and delivery contracts. These checks are
 * device-independent: they prove payloads, channel ids, assets and routing,
 * not that a real FCM message reached a phone.
 *
 * Run: node tests/phase3-notifications.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const app = read('assets/pd-app.js');
const funcs = read('functions/index.js');
const sw = read('sw.js');
let passed = 0;
function t(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS  ' + name); }
  else { console.error('FAIL  ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1; }
}

function pngSize(name) {
  const buf = fs.readFileSync(path.join(ROOT, name));
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

/* ------------------------------------------------------------ icon assets */
const svg = read('assets/notification-badge.svg');
const badge96 = pngSize('assets/notification-badge-96.png');
const badge192 = pngSize('assets/notification-badge-192.png');
t('a dedicated monochrome web notification badge exists',
  /fill="#FFFFFF"/.test(svg) && !/fill="#[0-9A-Fa-f]{6}"[^\n]*(logo|D4AF|0A4D)/i.test(svg) &&
  badge96.width === 96 && badge96.height === 96 && badge192.width === 192 && badge192.height === 192);
t('the badge files stay lightweight',
  badge96.bytes < 8000 && badge192.bytes < 12000, `${badge96.bytes}/${badge192.bytes} bytes`);
t('the full-colour launcher icon is still the large notification icon',
  funcs.includes("const PUSH_ICON = SITE_URL + '/assets/logo-192.png'") &&
  funcs.includes("const PUSH_BADGE = SITE_URL + '/assets/notification-badge-96.png'"));
t('every notification renderer uses the monochrome badge, not the launcher',
  !sw.includes("badge: '/assets/logo-192.png'") &&
  !app.includes("badge: '/assets/logo-192.png'") &&
  app.includes("badge: '/assets/notification-badge-96.png'"));
t('the native small icon is a white-on-transparent vector',
  read('android/app/src/main/res/drawable/ic_notification.xml').includes('android:fillColor="#FFFFFFFF"'));
t('the badge is available offline',
  sw.includes("'/assets/notification-badge-96.png'"));

/* --------------------------------------------------- channels and sound */
const nativeManifest = read('android/app/src/main/AndroidManifest.xml');
const nativeIcon = read('android/app/src/main/res/drawable/ic_notification.xml');
t('the default Android channel matches the versioned branded set',
  nativeManifest.includes('prayer_dome_general_v2') && nativeIcon.length > 200);
t('an original lightweight chime is packaged as a native resource',
  fs.existsSync(path.join(ROOT, 'android/app/src/main/res/raw/pd_notification_chime.wav')) &&
  fs.statSync(path.join(ROOT, 'android/app/src/main/res/raw/pd_notification_chime.wav')).size < 60000 &&
  app.includes("CHANNEL_SOUND = 'pd_notification_chime'"));
t('the app creates branded and silent channel twins for every category',
  app.includes('channelDefinition(base, false)') && app.includes('channelDefinition(base, true)') &&
  app.includes('sound: quiet ? null : CHANNEL_SOUND') &&
  app.includes("id: 'prayer_dome_' + base.id + '_' + CHANNEL_VERSION + (quiet ? '_quiet' : '')"));
t('the sound preference is persisted and sent with category preferences',
  app.includes("var SOUND_KEY = 'pd_notif_sound'") &&
  app.includes('Object.assign(readPrefs(), { sound: soundEnabled() })') &&
  app.includes('stored.sound'));
t('server sends sound and silent recipients as separate non-overlapping groups',
  funcs.includes('async function sendPushAudience(audience, base)') &&
  funcs.includes("!audience.quiet.has(token)") && funcs.includes('audience.quiet.has(token)') &&
  funcs.includes('quiet ? \'_quiet\' : \'\''));
t('a muted category is still filtered before any channel selection',
  funcs.includes('prefs[prefKey] === false') && funcs.includes('return { allowed, quiet }'));
t('no unused LocalNotifications dependency remains',
  !app.includes('LocalNotifications') &&
  !JSON.parse(read('package.json')).dependencies['@capacitor/local-notifications']);

/* ---------------------------------------------------- categories and links */
const categories = ['verse', 'live', 'prayer', 'news', 'sermon', 'event'];
t('each supported category has a channel and a click destination',
  categories.every((kind) => funcs.includes(`${kind}: 'prayer_dome_${kind === 'event' ? 'events' : kind}_v2'`)) &&
  ['live.html', 'prayer.html', 'news.html', 'sermons.html', 'events.html', 'bible.html']
    .every((page) => funcs.includes('/' + page)));
t('the service worker keeps one stable tag per notification and routes clicks',
  sw.includes('notificationclick') && sw.includes('data.url') && sw.includes('tag:'));
t('the public mirror and FCM share one deterministic id per broadcast',
  funcs.includes("await mirrorPublicNotification({ ...notification, type: kind, link }, context.params.notificationId)") &&
  read('admin.html').includes('queued?.id || payload.tag'));

console.log(`\n${passed} phase 3 notification assertions passed.`);
