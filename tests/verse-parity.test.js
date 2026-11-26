'use strict';

/*
 * Cross-platform daily verse parity.
 *
 * assets/pd-verse-data.js is the single source of truth. The Android widget,
 * the service worker and the server push bank are generated from it or load it
 * directly. These checks prove that the same date and slot produces the same
 * reference and text on every surface, including leap days and year boundaries.
 *
 * Run: node tests/verse-parity.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const site = require(path.join(ROOT, 'assets', 'pd-verse-data.js'));
const server = require(path.join(ROOT, 'functions', 'verse-bank.js'));
const widget = JSON.parse(read('android/app/src/main/res/raw/pd_widget_verses.json'));

let passed = 0;
function t(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS  ' + name); }
  else { console.error('FAIL  ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1; }
}

/* 1. Both generated banks are byte-for-byte current. */
const generated = spawnSync(process.execPath, ['scripts/build-widget-verses.mjs', '--check'], { cwd: ROOT });
t('the widget and server verse banks are generated from the source library',
  generated.status === 0, String(generated.stderr || '').trim());

t('the generated server bank declares its source and warns against edits',
  read('functions/verse-bank.js').startsWith('/*!\n * Prayer Dome — GENERATED server verse bank. DO NOT EDIT BY HAND.'));

/* 2. The slot order and all 80 NIV verses are identical. */
t('all four slots survive generation in the same order',
  server.SLOTS.map((slot) => slot.id).join(',') === site.SLOTS.map((slot) => slot.id).join(',') &&
  widget.slots.map((slot) => slot.id).join(',') === site.SLOTS.map((slot) => slot.id).join(','));

const siteVerses = site.SLOTS.flatMap((slot) =>
  site.VERSES[slot.id].map((verse) => `${slot.id}|${verse.ref}|${verse.text}`));
const serverVerses = server.SLOTS.flatMap((slot) =>
  server.VERSES[slot.id].map((verse) => `${slot.id}|${verse.ref}|${verse.text}`));
const widgetVerses = widget.slots.flatMap((slot) =>
  widget.verses[slot.id].map((verse) => `${slot.id}|${verse.ref}|${verse.text}`));
t('the server bank contains every source verse, reference and translation',
  siteVerses.length === 80 && siteVerses.join('\n') === serverVerses.join('\n'),
  `${siteVerses.length} source / ${serverVerses.length} server`);
t('the widget bank contains every source verse, reference and translation',
  siteVerses.join('\n') === widgetVerses.join('\n'),
  `${siteVerses.length} source / ${widgetVerses.length} widget`);
t('the server preserves the NIV attribution and slot labels',
  server.verseFor('morning', '2026-01-01').translation === 'NIV' &&
  /Biblica/.test(server.verseFor('morning', '2026-01-01').copyright) &&
  site.SLOTS.every((slot, index) => server.SLOTS[index].label === slot.label));

/* 3. Replay the full rotation on many dates, with both Date and YYYY-MM-DD inputs. */
const dates = [
  '2024-02-29', '2024-12-31', '2025-01-01', '2025-06-15', '2026-01-01',
  '2026-02-28', '2026-11-26', '2026-12-31', '2027-03-01', '2028-02-29',
  '2029-11-30', '2030-01-01'
];
const slots = site.SLOTS.map((slot) => slot.id);
const mismatches = [];
for (const stamp of dates) {
  const parts = stamp.split('-').map(Number);
  const asDate = new Date(parts[0], parts[1] - 1, parts[2]);
  for (const slot of slots) {
    const fromSite = site.verseFor(slot, asDate);
    const fromServer = server.verseFor(slot, stamp);
    const fromServerDate = server.verseFor(slot, asDate);
    if (fromSite.reference !== fromServer.reference ||
        fromSite.text !== fromServer.text ||
        fromSite.slotLabel !== fromServer.slotLabel ||
        fromSite.reference !== fromServerDate.reference ||
        site.dayIndex(asDate) !== server.dayIndex(stamp)) {
      mismatches.push(`${stamp}/${slot}: ${fromSite.reference} vs ${fromServer.reference}`);
    }
  }
}
t(`all ${dates.length * slots.length} site/server verse calculations agree`,
  mismatches.length === 0, mismatches.slice(0, 4).join(', '));

/* 4. The widget checkpoints must satisfy both non-browser consumers. */
const checkpointMismatch = widget.checkpoints.filter((point) => {
  const [year, month, day] = point.date.split('-').map(Number);
  const fromSite = site.verseFor(point.slot, new Date(year, month - 1, day));
  const fromServer = server.verseFor(point.slot, point.date);
  return fromSite.reference !== point.ref || fromServer.reference !== point.ref ||
    server.dayIndex(point.date) !== point.dayIndex;
});
t(`all ${widget.checkpoints.length} widget checkpoints match the server bank`,
  checkpointMismatch.length === 0,
  checkpointMismatch.slice(0, 4).map((point) => `${point.date}/${point.slot}`).join(', '));

/* 5. Every consumer is actually wired to the shared library. */
const indexJs = read('functions/index.js');
t('push dispatch passes the member calendar date to the generated bank',
  /verseBank\.verseFor\(slot\.id, localDate\)/.test(indexJs) &&
  !/verseBank\.verseFor\(slot\.id, local\)/.test(indexJs));
t('push dispatch still supports the administrator verse override',
  indexJs.includes("verseSchedule/${localDate}") && indexJs.includes('special.reference'));
const sw = read('sw.js');
t('the service worker imports and uses the source library',
  sw.includes("importScripts('/assets/pd-verse-data.js')") && sw.includes('self.PD_VERSES.verseFor(slot.id)'));
t('the worker and page share one deduplication tag for each verse and date',
  sw.includes("'pd-verse-' + verse.slot + '-' + todayStamp()") &&
  read('assets/pd-verse-alerts.js').includes("'verse-' + id + '-' + stamp"));
t('only the generated file holds a server-side verse bank',
  fs.readdirSync(path.join(ROOT, 'functions'))
    .filter((name) => name.endsWith('.js'))
    .filter((name) => name !== 'verse-bank.js')
    .every((name) => !/const VERSES\s*=/.test(read(`functions/${name}`))));

t('the build script writes both generated banks',
  read('scripts/build-widget-verses.mjs').includes('writeFileSync(SERVER_FILE, serverSource'));

console.log(`\n${passed} daily verse parity assertions passed.`);
