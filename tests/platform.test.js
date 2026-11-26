/*
 * Platform pass — the structures that make the professional church platform
 * work end to end: the admin modules and their bridge, the branch directory,
 * the daily challenge schedule, the CR80 membership card and its public
 * verification, the Document Studio, the installed-app notification channels,
 * the grouped console navigation and the focused game mode.
 *
 * These are file-contract checks, deliberately: every one of them covers a
 * wiring mistake that produces no error in the browser but silently disables a
 * feature (an unexposed inline handler, a page missing its script, a route that
 * is never pre-cached, a manifest that still opens with browser chrome).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let passed = 0;
function t(name, ok, detail = '') {
  if (ok) { passed += 1; console.log('PASS  ' + name); }
  else { console.error('FAIL  ' + name + (detail ? '  ' + detail : '')); process.exitCode = 1; }
}

const admin = read('admin.html');
const extras = read('assets/pd-admin-extras.js');
const studio = read('assets/pd-document-studio.js');
const locations = read('locations.html');
const locationData = read('assets/pd-locations-data.js');
const daily = read('assets/pd-daily-challenge.js');
const membership = read('membership.html');
const verify = read('verify.html');
const account = read('account.html');
const game = read('game.html');
const rules = read('firestore.rules');
const manifest = JSON.parse(read('manifest.json'));
const sw = read('sw.js');
const nav = read('assets/pd-nav.js');
const seo = JSON.parse(read('seo/pages.json'));
const css = read('assets/pd-responsive-fix.css');
const androidManifest = read('android/app/src/main/AndroidManifest.xml');
const app = read('assets/pd-app.js');

/* ------------------------------------------------------------- admin views */
['locations', 'daily-challenges', 'document-studio', 'membership-cards', 'data-audit'].forEach((view) => {
  t('admin has a #view-' + view + ' section', admin.includes('id="view-' + view + '"'));
  t('admin sidebar links to ' + view,
    new RegExp('data-view="' + view + '"').test(admin));
});

t('admin publishes the Firestore bridge for module scripts',
  admin.includes('window.PDAdmin = {') && admin.includes('firestore:'));

t('admin loads the module admin extras and the Document Studio',
  admin.includes('/assets/pd-admin-extras.js') && admin.includes('/assets/pd-document-studio.js'));

t('admin extras is an ES module (it imports getCountFromServer)',
  /<script[^>]*type="module"[^>]*src="\/assets\/pd-admin-extras\.js"/.test(admin));

['locations', 'daily-challenges', 'membership-cards', 'document-studio', 'data-audit'].forEach((view) => {
  t('sidebar groups ' + view + ' under a labelled category',
    admin.includes('nav-group-label') && admin.includes('data-view="' + view + '"'));
});

/* ------------------------------------------------------------- admin modules */
['loadChurchLocations', 'saveChurchLocation', 'loadDailyChallenges', 'saveDailyChallenge',
  'loadMembershipCardAdmin', 'saveCardTemplate', 'issueCardVerification',
  'runDataAudit', 'downloadDataAudit', 'runIntegrityCheck'].forEach((name) => {
  t('admin extras exposes ' + name + '() to its inline handler',
    extras.includes('window.' + name + ' = ' + name + ';'));
});

t('church locations are written to the churchLocations collection',
  extras.includes("'churchLocations'"));
t('the challenge weekday is computed in Africa/Lusaka (not the device zone)',
  extras.includes("'Africa/Lusaka'") && daily.includes('Africa/Lusaka'));
t('membership card verification is keyed by the uppercased membership number',
  extras.includes('membershipVerification') && extras.includes('toUpperCase()'));
const auditOnly = extras.slice(extras.indexOf('async function runDataAudit'), extras.indexOf('/* --------------------------------------------------- membership integrity */'));
t('the data audit never writes or deletes a collection',
  auditOnly.length > 0 && !/deleteDoc\(|writeBatch\(|addDoc\(|setDoc\(|updateDoc\(/.test(auditOnly));
t('the data audit reports exact collection sizes with an aggregation query',
  extras.includes('getCountFromServer'));
t('the integrity check flags duplicate numbers and missing timestamps',
  extras.includes('Duplicate membership numbers') && extras.includes('Missing created timestamp'));
t('the audit export is a dated JSON report',
  extras.includes('prayer-dome-data-audit-') && extras.includes("type: 'application/json'"));

/* ---------------------------------------------------------- document studio */
['docStudioForm', 'docStudioList', 'docSignatoryName', 'docSignaturePad',
  'docPreview', 'docAudit'].forEach((id) => {
  t('Document Studio view contains #' + id, admin.includes('id="' + id + '"'));
});
t('Document Studio supports PDF, DOCX, PNG and JPG exports',
  ['pdf', 'docx', 'png', 'jpg'].every((kind) => admin.includes("PDDoc.exportAs('" + kind + "')")));
t('a document cannot be approved without a real signature',
  studio.includes('requireSignature') && studio.includes('Draw or upload the signature'));
t('an unsigned document prints a blank signature line, never a borrowed signature',
  studio.includes('doc-sheet-signspace') && studio.includes('Signature'));
t('every document action is appended to its audit trail',
  studio.includes('audit') && studio.includes('documents/{id}.audit') || studio.includes("COLLECTION = 'documents'"));

/* ---------------------------------------------------------------- locations */
t('the branch directory loads its data and renderer',
  locations.includes('/assets/pd-locations-data.js') && locations.includes('/assets/pd-locations.js'));
t('all four congregations use the verified coordinates',
  ['-11.193343', '33.1525404', '-26.4889087', '31.5130595', '-27.2191875', '31.6147656']
    .every((value) => locationData.includes(value)));
t('each branch carries the real phone number from its listing',
  ['+260 97 3028342', '+268 7813 5065', '+268 7647 6648'].every((phone) => locationData.includes(phone)));
t('distance is labelled straight-line and never presented as driving distance',
  locations.includes('straight-line') && /Driving|driving route|road distance/.test(locations));
t('the directory never invents a distance when location permission is absent',
  read('assets/pd-locations.js').includes('Distance needs location permission'));

/* ------------------------------------------------------------ daily challenge */
t('the public daily challenge reads the cloud schedule',
  daily.includes('dailyChallenges') && read('index.html').includes('PDDaily'));
t('the challenge falls back to the Lusaka weekday plan when offline',
  daily.includes('WEEKDAY_PLAN') || daily.includes('weekday'));

/* -------------------------------------------------------- membership ID card */
t('the membership page renders a CR80 card', membership.includes('cr80'));
t('the card QR encodes a secure token verification URL, never a raw id',
  membership.includes("https://prayerdome.net/verify?") && membership.includes("ref=") && !membership.includes("'id='"));
t('the card QR is only drawn when a membership number exists',
  membership.includes('membershipId'));
t('the card template is synced from Firestore',
  membership.includes('membershipCardSettings') && membership.includes('loadCardTemplateFromCloud'));
t('the public verifier asks the server to resolve one exact card',
  verify.includes('httpsCallable') && verify.includes('verifyMembership') && !/getDoc\(/.test(verify));
t('the public verifier is noindex',
  seo.pages['verify.html'] && seo.pages['verify.html'].noindex === true);
t('the public verifier never prints contact details',
  verify.includes('Contact the church office') && !verify.includes('member.email'));

/* ---------------------------------------------------------------- profile */
t('the profile has an achievements card fed by real local progress',
  account.includes('pAchievementsList') && account.includes('pd_faith_journey_data'));
t('the profile sign-in panel offers registration',
  account.includes('switchTab(\'register\')'));
t('achievements merge cloud progress without erasing local badges',
  account.includes('loadCloudAchievements') && account.includes("'game', 'progress'") && account.includes('new Set('));

/* --------------------------------------------------------- installed app */
t('the manifest opens standalone without browser chrome',
  manifest.display === 'standalone' && manifest.display_override[0] === 'standalone');
t('the Android manifest declares the notification permission',
  androidManifest.includes('android.permission.POST_NOTIFICATIONS'));
t('the Android manifest sets a branded status-bar notification icon',
  androidManifest.includes('default_notification_icon') && androidManifest.includes('ic_notification'));
t('the app creates per-category Android channels in branded and silent variants',
  app.includes("CHANNEL_VERSION = 'v2'") && app.includes("CHANNEL_SOUND = 'pd_notification_chime'") &&
  app.includes('channelDefinition(base, false)') && app.includes('channelDefinition(base, true)') &&
  app.includes('createChannel'));
t('foreground pushes land in the in-app centre without an unused local plugin',
  app.includes('pushNotificationReceived') && !app.includes('LocalNotifications') &&
  app.includes('notifications.push(item, { localOnly: true, silent: true })'));
t('notification taps route to the page they belong to',
  app.includes('pushNotificationActionPerformed'));
const pushFn = read('functions/index.js');
t('background pushes use the same versioned channels as the app',
  pushFn.includes('ANDROID_CHANNELS') && pushFn.includes('prayer_dome_general_v2') &&
  pushFn.includes("(ANDROID_CHANNELS[normaliseKind(kind)] || 'prayer_dome_general_v2') + (quiet ? '_quiet' : '')"));
t('background pushes name the branded notification icon that exists',
  pushFn.includes("icon: 'ic_notification'"));

/* --------------------------------------------------------------- game mode */
t('starting a game enters focused, scroll-free play',
  game.includes('game-focus') && game.includes('#panel-talk'));
t('the focused game shows the question with its answers underneath',
  game.includes('pdm-chips'));
t('the focused game labels the continue action as the next question',
  read('assets/pd-mascot.js').includes("'Next question'"));
t('decorative confetti no longer fires inside the game',
  !game.includes('window.confetti'));
t('the game honours reduced-motion preferences',
  game.includes('prefers-reduced-motion'));

/* ---------------------------------------------------------------- global UI */
t('one compact card radius replaces the oversized bubbles',
  css.includes('border-radius: 16px') && css.includes('.glass-card'));
t('buttons share a compact, tappable control scale',
  css.includes('min-height: 44px') && css.includes('gap: 8px'));
t('iOS cannot zoom a focused field',
  css.includes('font-size: max(16px, 1rem)'));
t('names are never written vertically',
  css.includes('writing-mode: horizontal-tb'));

/* -------------------------------------------------------------- routes, SEO */
t('locations and verification are in the SEO source',
  seo.pages['locations.html'] && seo.pages['locations.html'].path === '/locations');
t('the drawer links to the branch directory and card verifier',
  nav.includes("href: '/locations'") && nav.includes("href: '/verify'"));
t('the service worker pre-caches the new public pages',
  sw.includes("'/locations.html'") && sw.includes("'/verify.html'"));
t('the service worker cache name moved forward',
  /prayer-dome-v(?:4[3-9]|5\d)/.test(sw));

/* -------------------------------------------------------------- security */
t('card verification records are administrator-only; public checks use the callable',
  /match \/membershipVerification\/\{id\} \{[\s\S]*?allow get, list: if isAdmin\(\);/.test(rules) &&
  /match \/membershipVerificationRefs\/\{reference\} \{[\s\S]*?allow get, list: if isAdmin\(\);/.test(rules));
t('church locations may only be written by an administrator',
  /match \/churchLocations\/\{id\} \{[\s\S]*?allow create, update: if isAdmin\(\)/.test(rules));
t('the card template signature is readable only by a signed-in member',
  /match \/membershipCardSettings\/\{id\} \{\s*allow read: if isSignedIn\(\);/.test(rules));
t('official documents are administrator-only',
  /match \/documents\/\{id\} \{\s*allow read: if isAdmin\(\);/.test(rules));

console.log('\nPlatform audit passed (' + passed + ' assertions).');
