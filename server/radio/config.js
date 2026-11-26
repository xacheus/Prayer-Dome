'use strict';

/**
 * Radio infrastructure configuration — names and validation only.
 *
 * This module never performs a network request and never returns a secret.
 * A value can be "present" while the service is still unreachable, so the
 * public status endpoint calls this `configuration`, not `health`. The admin
 * dashboard must not show a green "online" light from env presence alone.
 */

const R2_REQUIRED = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT',
  'R2_PUBLIC_BASE_URL'
];

const STREAM_REQUIRED = [
  'AZURACAST_BASE_URL',
  'AZURACAST_API_KEY',
  'AZURACAST_STATION_ID'
];

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function present(env, name) {
  return Boolean(clean(env && env[name]));
}

function group(env, id, label, required, optional) {
  const missing = required.filter((name) => !present(env, name));
  return {
    id,
    label,
    ready: missing.length === 0,
    configured: required.length - missing.length,
    required: required.length,
    missing,
    optional: (optional || []).map((name) => ({ name, present: present(env, name) }))
  };
}

function databaseUrl(env) {
  return clean(env && (env.TIDB_DATABASE_URL || env.DATABASE_URL));
}

/**
 * TiDB Cloud speaks the MySQL protocol. A PostgreSQL URL cannot be used with
 * the TiDB driver, so the mismatch is a hard configuration failure rather than
 * a warning that disappears in production.
 */
function database(env) {
  const url = databaseUrl(env);
  const declared = clean(env && env.RADIO_DB_ENGINE).toLowerCase();
  let detected = '';
  if (/^mysql:\/\//i.test(url)) detected = 'mysql';
  else if (/^postgres(ql)?:\/\//i.test(url)) detected = 'postgres';
  const engine = declared || detected;
  const notes = [];
  if (!url) notes.push('Set TIDB_DATABASE_URL (or DATABASE_URL) on the server. Never commit it.');
  if (url && !detected) notes.push('The database URL must start with mysql:// or postgres://.');
  if (declared && detected && declared !== detected) {
    notes.push('RADIO_DB_ENGINE=' + declared + ' conflicts with the ' + detected + ' URL.');
  }
  if (engine === 'postgres') {
    notes.push('TiDB is MySQL-compatible; confirm that this really is a PostgreSQL service before writing migrations.');
  }
  const missing = [];
  if (!url) missing.push('TIDB_DATABASE_URL');
  if (!engine) missing.push('RADIO_DB_ENGINE');
  return {
    id: 'database',
    label: 'TiDB metadata',
    ready: Boolean(url && engine && (!detected || !declared || declared === detected)),
    configured: missing.length ? 0 : 1,
    required: 1,
    missing,
    engine: engine || '',
    notes,
    optional: []
  };
}

function storage(env) {
  const result = group(env, 'storage', 'Cloudflare R2 audio', R2_REQUIRED, []);
  const endpoint = clean(env && env.R2_ENDPOINT);
  const publicBase = clean(env && env.R2_PUBLIC_BASE_URL);
  const notes = [];
  if (endpoint && !/^https:\/\//i.test(endpoint)) notes.push('R2_ENDPOINT must use https://.');
  if (publicBase && !/^https:\/\//i.test(publicBase)) notes.push('R2_PUBLIC_BASE_URL must use https://.');
  if (/\.r2\.dev(?:\/|$)/i.test(publicBase)) {
    notes.push('Do not use the rate-limited r2.dev host as the permanent production media URL. Use a verified custom media domain.');
  }
  if (publicBase && /\/radio\/(?:music|announcements|sermons|bible-readings|prayers|archives|metadata)\/?$/i.test(publicBase)) {
    notes.push('R2_PUBLIC_BASE_URL should be the bucket origin, not a radio/ prefix.');
  }
  if (notes.length) result.ready = false;
  result.notes = notes;
  return result;
}

function streaming(env) {
  const result = group(env, 'streaming', 'AzuraCast / Liquidsoap stream', STREAM_REQUIRED, ['RADIO_STREAM_URL', 'AZURACAST_STREAMER_PREFIX']);
  const base = clean(env && env.AZURACAST_BASE_URL);
  const stream = clean(env && env.RADIO_STREAM_URL);
  const notes = [];
  if (base && !/^https:\/\//i.test(base)) notes.push('AZURACAST_BASE_URL must use https://.');
  if (stream && !/^https:\/\//i.test(stream)) notes.push('RADIO_STREAM_URL must use https://.');
  if (notes.length) result.ready = false;
  result.notes = notes;
  return result;
}

function voices(env) {
  const provider = clean(env && env.RADIO_TTS_PROVIDER).toLowerCase();
  const endpoint = clean(env && env.RADIO_TTS_ENDPOINT);
  const key = clean(env && env.RADIO_TTS_API_KEY);
  const missing = [];
  if (!provider) missing.push('RADIO_TTS_PROVIDER');
  if (provider && provider !== 'piper' && !key) missing.push('RADIO_TTS_API_KEY');
  if ((provider === 'piper' || provider === 'custom') && !endpoint) missing.push('RADIO_TTS_ENDPOINT');
  const notes = [];
  if (provider === 'elevenlabs' || provider === 'azure' || provider === 'google') {
    notes.push('This is a paid voice provider. Its price and monthly usage must be approved before it is enabled.');
  }
  return {
    id: 'voices',
    label: 'AI presenter voices',
    ready: missing.length === 0,
    configured: missing.length ? 0 : 1,
    required: 1,
    missing,
    provider: provider || '',
    notes,
    optional: [
      { name: 'RADIO_TTS_DEFAULT_VOICE', present: present(env, 'RADIO_TTS_DEFAULT_VOICE') },
      { name: 'RADIO_TTS_FALLBACK_VOICE', present: present(env, 'RADIO_TTS_FALLBACK_VOICE') }
    ]
  };
}

function discovery(env) {
  const provider = clean(env && env.RADIO_DISCOVERY_PROVIDER).toLowerCase();
  const key = clean(env && env.RADIO_DISCOVERY_API_KEY);
  const missing = [];
  if (!provider) missing.push('RADIO_DISCOVERY_PROVIDER');
  if (provider && provider !== 'manual' && !key) missing.push('RADIO_DISCOVERY_API_KEY');
  return {
    id: 'discovery',
    label: 'Licensed music discovery',
    ready: missing.length === 0,
    configured: missing.length ? 0 : 1,
    required: 1,
    missing,
    provider: provider || '',
    notes: provider && provider !== 'manual'
      ? ['The provider licence must expressly permit internet-radio broadcasting before a track is queued.']
      : ['No discovery provider is active. Only tracks an administrator has already approved can broadcast.'],
    optional: []
  };
}

function readRadioConfig(env) {
  const source = env || {};
  const groups = [database(source), storage(source), streaming(source), voices(source), discovery(source)];
  const ready = groups.every((item) => item.ready);
  return {
    station: 'Prayer Dome Radio',
    timezone: 'Africa/Lusaka',
    ready,
    groups,
    checkedAt: new Date().toISOString(),
    note: 'Configuration presence only. This is not a connection, playback or broadcast test.'
  };
}

module.exports = { readRadioConfig, R2_REQUIRED, STREAM_REQUIRED };
