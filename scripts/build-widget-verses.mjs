#!/usr/bin/env node
/**
 * Prayer Dome — Android widget verse data: build step.
 *
 * The daily verse rotation lives in one place, assets/pd-verse-data.js, and is
 * used by the website, the service worker, the notification system and the
 * Android home-screen / lock-screen widget. Android cannot read that file, so
 * this script copies the same library — verse by verse, slot by slot — into
 * android/app/src/main/res/raw/pd_widget_verses.json, together with:
 *
 *   • the exact rotation rule the widget must apply (and that the site uses),
 *   • the slot boundaries that decide which verse is current right now,
 *   • checkpoints: date/slot/reference samples computed by the site library, so
 *     the widget can verify at runtime that it is showing the same verse the
 *     website shows.
 *
 * The widget never edits this file; it only reads it. Re-run after changing
 * assets/pd-verse-data.js:
 *
 *   node scripts/build-widget-verses.mjs           write the file
 *   node scripts/build-widget-verses.mjs --check   exit 1 if it is stale
 *
 * `npm run mobile:sync` and `npm run lint` both call it, so a verse edit can
 * never ship a widget that quotes a different Scripture to the website.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'assets', 'pd-verse-data.js');
const OUT_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'raw');
const OUT_FILE = join(OUT_DIR, 'pd_widget_verses.json');
const SERVER_FILE = join(ROOT, 'functions', 'verse-bank.js');
const CHECK = process.argv.includes('--check');

/** Slot boundaries used by PD_VERSES.currentSlot(): hour -> slot index. */
const BOUNDARIES = [0, 11, 14, 18];
const NIV_COPYRIGHT = 'NIV® — Holy Bible, New International Version®. Copyright © 1973, 1978, 1984, 2011 by Biblica, Inc.® Used by permission. All rights reserved worldwide.';

const verses = require(SOURCE);
const slots = verses.SLOTS.map((slot) => ({
  id: slot.id,
  label: slot.label,
  greeting: slot.greeting,
  defaultTime: slot.defaultTime
}));

const pools = {};
for (const slot of slots) {
  pools[slot.id] = (verses.VERSES[slot.id] || []).map((verse) => ({
    ref: verse.ref,
    text: verse.text
  }));
}

/* ------------------------------------------------------------- checkpoints */
/* Dates chosen to cover a leap day, year boundaries, every slot and a date
   several years out (so a widget installed later can still be verified). */
const CHECKPOINT_DATES = [
  '2024-02-29', '2024-12-31', '2025-01-01', '2025-06-15',
  '2026-01-01', '2026-02-28', '2026-12-31', '2027-03-01',
  '2027-07-04', '2028-02-29', '2029-11-30', '2030-01-01'
];

const checkpoints = [];
for (const stamp of CHECKPOINT_DATES) {
  const [year, month, day] = stamp.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  for (const slot of slots) {
    const verse = verses.verseFor(slot.id, date);
    checkpoints.push({
      date: stamp,
      slot: slot.id,
      dayIndex: verses.dayIndex(date),
      index: (verses.dayIndex(date) * slots.length + slots.indexOf(slot)) % pools[slot.id].length,
      ref: verse.reference
    });
  }
}

const payload = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  source: 'assets/pd-verse-data.js',
  translation: 'New International Version (NIV)',
  brand: {
    name: 'Prayer Dome',
    tagline: 'A House of Prayer for All Nations',
    site: 'prayerdome.net'
  },
  rotation: {
    slotOrder: slots.map((slot) => slot.id),
    /* dayIndex = floor((localDate - new Date(year, 0, 0)) / 86 400 000) */
    dayIndexMillisecondsPerDay: 86400000,
    /* index = (dayIndex * slotCount + slotIndex) % poolSize */
    indexFormula: '(dayIndex * slotCount + slotIndex) % poolSize',
    slotBoundaries: BOUNDARIES
  },
  slots,
  verses: pools,
  checkpoints
};

const serialised = JSON.stringify(payload, null, 1) + '\n';
const relativeOut = relative(ROOT, OUT_FILE);

/* ------------------------------------------------------------------ server
 * Cloud Functions cannot import a browser global. Generate a byte-stable
 * CommonJS mirror from the same library so push notifications quote exactly
 * the same verse as the site, the service worker and the widget. The rotation
 * helpers below are deliberately the same code as assets/pd-verse-data.js.
 */
const serverSource = `/*!
 * Prayer Dome — GENERATED server verse bank. DO NOT EDIT BY HAND.
 * Source of truth: assets/pd-verse-data.js
 * Regenerate: node scripts/build-widget-verses.mjs
 *
 * Copyright notice for the NIV text is preserved from the source library:
 * NIV® — Holy Bible, New International Version®. Copyright © 1973, 1978, 1984,
 * 2011 by Biblica, Inc.® Used by permission. All rights reserved worldwide.
 */
'use strict';

const SLOTS = ${JSON.stringify(verses.SLOTS, null, 2)};

const VERSES = ${JSON.stringify(verses.VERSES, null, 2)};

const NIV_COPYRIGHT = ${JSON.stringify(NIV_COPYRIGHT)};

/** Accept a Date or an explicit YYYY-MM-DD calendar date (used by push). */
function asDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parts = value.split('-').map(Number);
    if (parts.length === 3 && parts.every((n) => isFinite(n))) {
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
  }
  return new Date();
}

function dayIndex(date) {
  const d = asDate(date);
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

function verseFor(slotId, date) {
  const pool = VERSES[slotId] || VERSES.morning;
  const slotIndex = Math.max(0, SLOTS.map((s) => s.id).indexOf(slotId));
  const index = (dayIndex(date) * SLOTS.length + slotIndex) % pool.length;
  const verse = pool[index];
  const slot = SLOTS[slotIndex];
  return {
    slot: slot.id,
    slotLabel: slot.label,
    icon: slot.icon,
    greeting: slot.greeting,
    reference: verse.ref,
    text: verse.text,
    translation: 'NIV',
    translationName: 'New International Version',
    copyright: NIV_COPYRIGHT
  };
}

function currentSlot(date) {
  const h = asDate(date).getHours();
  if (h < 11) return 'morning';
  if (h < 14) return 'midday';
  if (h < 18) return 'afternoon';
  return 'evening';
}

module.exports = { SLOTS, VERSES, verseFor, dayIndex, currentSlot };
`;
const relativeServer = relative(ROOT, SERVER_FILE);

if (CHECK) {
  let current = null;
  try { current = readFileSync(OUT_FILE, 'utf8'); } catch { /* missing */ }
  /* The "generated" stamp is the day the file was written. Comparing it
     byte-for-byte made the check fail every midnight, even when nothing
     about the verses had changed — the lint and the test suite then failed
     for a reason that had nothing to do with the code. The stamp is
     therefore ignored when deciding whether the library is stale; the
     verses, slots, rotation rule and checkpoints still have to match. */
  let comparable = current;
  if (comparable !== null) {
    try {
      const parsed = JSON.parse(comparable);
      delete parsed.generated;
      comparable = JSON.stringify(parsed, null, 1) + '\n';
    } catch { comparable = current; }
  }
  const expected = JSON.stringify(Object.assign({}, payload, { generated: undefined }), null, 1) + '\n';
  if (comparable !== expected) {
    console.error(`${relativeOut} is stale — run: node scripts/build-widget-verses.mjs`);
    process.exit(1);
  }
  let currentServer = null;
  try { currentServer = readFileSync(SERVER_FILE, 'utf8'); } catch { /* missing */ }
  if (currentServer !== serverSource) {
    console.error(`${relativeServer} is stale — run: node scripts/build-widget-verses.mjs`);
    process.exit(1);
  }
  console.log(`${relativeOut} and ${relativeServer} match ${relative(ROOT, SOURCE)} (${checkpoints.length} checkpoints).`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, serialised, 'utf8');
writeFileSync(SERVER_FILE, serverSource, 'utf8');
console.log(`Wrote ${relativeOut} and ${relativeServer}: ${slots.length} slots, ` +
  `${Object.values(pools).reduce((total, pool) => total + pool.length, 0)} verses, ` +
  `${checkpoints.length} checkpoints.`);
