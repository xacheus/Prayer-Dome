'use strict';

/*
 * Radio infrastructure honesty checks.
 *
 * The station may not show a green "24/7 ready" state merely because the code
 * exists. These tests pin the configuration preflight, the secret-free status
 * endpoint and the admin dashboard's "names present, not connection tested"
 * wording.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRadioConfig } = require('../server/radio/config.js');

const ROOT = path.join(__dirname, '..');
const FULL_ENV = {
  TIDB_DATABASE_URL: 'mysql://user:pass@gateway01.eu-west-1.prod.aws.tidbcloud.com:4000/prayerdome',
  RADIO_DB_ENGINE: 'mysql',
  R2_ACCOUNT_ID: 'account',
  R2_ACCESS_KEY_ID: 'access',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET_NAME: 'prayer-dome',
  R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
  R2_PUBLIC_BASE_URL: 'https://media.prayerdome.net',
  AZURACAST_BASE_URL: 'https://radio.prayerdome.net',
  AZURACAST_API_KEY: 'api-key',
  AZURACAST_STATION_ID: '1',
  RADIO_STREAM_URL: 'https://radio.prayerdome.net/listen/prayerdome/stream.mp3',
  RADIO_TTS_PROVIDER: 'piper',
  RADIO_TTS_ENDPOINT: 'http://127.0.0.1:5000/synthesize',
  RADIO_DISCOVERY_PROVIDER: 'manual'
};

function invoke(query) {
  const handler = require('../api/radio.js');
  const headers = {};
  let body = '';
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(value) { body = value || ''; }
  };
  return Promise.resolve(handler({ method: 'GET', query, url: '/api/radio', headers: {} }, res))
    .then(() => ({ status: res.statusCode, headers, body, json: body ? JSON.parse(body) : null }));
}

(async function run() {
  let passed = 0;
  let failed = 0;
  function test(name, condition, detail) {
    if (condition) passed += 1;
    else failed += 1;
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? '  ' + detail : ''}`);
  }

  const empty = readRadioConfig({});
  test('an empty environment is never reported as ready', empty.ready === false);
  test('every missing infrastructure group is named',
    ['database', 'storage', 'streaming', 'voices', 'discovery'].every((id) =>
      empty.groups.some((group) => group.id === id && group.ready === false)));
  test('the R2 secret is requested by name, never shown as a value',
    empty.groups.find((group) => group.id === 'storage').missing.includes('R2_SECRET_ACCESS_KEY') &&
    !JSON.stringify(empty).includes('secret'));

  const full = readRadioConfig(FULL_ENV);
  test('a complete configuration is reported as ready', full.ready === true,
    full.groups.filter((group) => !group.ready).map((group) => group.id).join(','));
  test('the station timezone is Africa/Lusaka', full.timezone === 'Africa/Lusaka');
  test('configuration is explicitly not a health claim', /not a connection, playback or broadcast test/i.test(full.note));

  const r2dev = readRadioConfig(Object.assign({}, FULL_ENV, { R2_PUBLIC_BASE_URL: 'https://bucket.r2.dev' }));
  test('the rate-limited r2.dev host is rejected as a production media URL',
    r2dev.ready === false && r2dev.groups.find((group) => group.id === 'storage').notes.join(' ').includes('r2.dev'));

  const mismatch = readRadioConfig(Object.assign({}, FULL_ENV, {
    TIDB_DATABASE_URL: 'postgres://user:pass@example:5432/prayerdome', RADIO_DB_ENGINE: 'postgres'
  }));
  test('a PostgreSQL URL is called out against TiDB instead of silently accepted',
    mismatch.groups.find((group) => group.id === 'database').notes.join(' ').includes('TiDB is MySQL-compatible'));

  const conflict = readRadioConfig(Object.assign({}, FULL_ENV, { RADIO_DB_ENGINE: 'postgres' }));
  test('a declared engine that conflicts with the URL is not ready', conflict.ready === false);

  const station = readRadioConfig(Object.assign({}, FULL_ENV, { RADIO_TTS_PROVIDER: 'elevenlabs', RADIO_TTS_API_KEY: 'key' }));
  test('a paid voice provider is flagged for approval',
    station.groups.find((group) => group.id === 'voices').notes.join(' ').includes('must be approved'));

  const response = await invoke({ view: 'status' });
  test('the status endpoint is private and never cached', response.status === 200 && response.headers['cache-control'] === 'no-store');
  test('the status payload contains groups but no connection string or key values',
    response.json.view === 'status' &&
    response.json.infrastructure.groups.length === 5 &&
    !response.body.includes(FULL_ENV.R2_SECRET_ACCESS_KEY) &&
    !response.body.includes(FULL_ENV.TIDB_DATABASE_URL) &&
    !response.body.includes(FULL_ENV.AZURACAST_API_KEY));

  const ordinary = await invoke({});
  test('the ordinary public radio response is unchanged', ordinary.json.success === true && Array.isArray(ordinary.json.radio) && ordinary.json.view === undefined);

  const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const consoleSource = fs.readFileSync(path.join(ROOT, 'assets', 'pd-radio-admin.js'), 'utf8');
  test('the admin dashboard contains the infrastructure panel',
    ['radioInfrastructurePanel', 'radioInfraSummary', 'radioInfraGroups', 'radioInfraChecked'].every((id) => admin.includes('id="' + id + '"')));
  test('the panel loads the secret-free status endpoint',
    consoleSource.includes("fetch('/api/radio?view=status'") && consoleSource.includes('window.loadRadioInfrastructure = loadInfrastructure'));
  test('the panel says names are present, not that the service is reachable',
    consoleSource.includes('Names present') && consoleSource.includes('not a connection test'));

  const page = fs.readFileSync(path.join(ROOT, 'radio.html'), 'utf8');
  const engine = fs.readFileSync(path.join(ROOT, 'assets', 'pd-radio-live.js'), 'utf8');
  test('the station ticker has a real, continuously moving track',
    page.includes('id="radioTickerTrack"') && page.includes('animation: ticker 42s linear infinite') &&
    !page.includes('“HE DOES EVERYTHING BLAMELESSLY” — MARK 7:37'));
  test('the ticker content is station, programme, LIVE/presenter and Now Playing',
    engine.includes('function updateTicker()') && engine.includes("add('Prayer Dome Radio')") &&
    engine.includes("if (slot && slot.title) add(slot.title)") &&
    engine.includes("if (state.live && state.live.status === 'live')") &&
    engine.includes("add(state.currentTrack.title)"));
  test('the ticker becomes static for reduced motion and never hides itself',
    page.includes('prefers-reduced-motion') && /ticker-track[^}]*animation:\s*none/.test(page) &&
    !/radioTicker(?:Track)?[^\n]*setTimeout/.test(engine));

  const cli = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'radio-preflight.mjs'), '--json'], {
    cwd: ROOT, env: { PATH: process.env.PATH }, encoding: 'utf8'
  }));
  test('the preflight CLI reports the same missing state', cli.ready === false && cli.groups.length === 5);

  console.log(`\nRadio infrastructure checks: ${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
})();
