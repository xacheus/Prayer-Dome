'use strict';

/**
 * Prayer Dome Radio API — stations, discovery, announcements and R2 audio.
 * ---------------------------------------------------------------------------
 * One Vercel function (the Hobby plan allows 12; this file must not split):
 *
 *   GET  /api/radio                      stations + podcasts (original API)
 *   GET  /api/radio?op=status            station / R2 / TTS / discovery status
 *   GET  /api/radio?op=discover          free gospel catalogue search
 *        &category=african-gospel&rows=20&source=archive|commons|jamendo|all
 *   GET  /api/radio?op=announce          announcement text + R2 cache key
 *        &kind=programme-intro&programmeId=morning-prayer&personaId=warm-female
 *   POST /api/radio?op=announce          generate Piper audio, cache in R2
 *        (admin only; needs TTS_SERVICE_URL — see radio/tts/)
 *   GET  /api/radio?op=r2-status         R2 configured? (no secrets)
 *   POST /api/radio?op=r2-upload         upload audio to R2 (admin only)
 *        headers: x-r2-key, x-r2-content-type; body: raw audio bytes
 *   GET  /api/radio?op=r2-get&key=...    stream an R2 object (Range aware)
 *   GET  /api/radio?op=playlist          timetable + personas for Liquidsoap
 *   GET  /api/radio?op=stream            public stream URL (may be empty)
 *
 * Secrets (R2 keys, TTS token, admin token) live only in Vercel env vars.
 * R2 uploads require a Firebase administrator ID token (or the server-only
 * RADIO_ADMIN_TOKEN used by the radio server / scripts). Nothing here is
 * written to Firestore from Vercel: the browser and Firebase Functions own
 * the database; this function only reads free catalogues and moves audio.
 */

const crypto = require('node:crypto');

const CONTENT = (typeof window !== 'undefined' && window.PD_CONTENT)
  ? window.PD_CONTENT
  : require('../assets/pd-content-data.js');
const DEFAULT_RADIO = Array.isArray(CONTENT.DEFAULT_RADIO) ? CONTENT.DEFAULT_RADIO : [];
const DEFAULT_PODCASTS = Array.isArray(CONTENT.DEFAULT_PODCASTS) ? CONTENT.DEFAULT_PODCASTS : [];
const DISCOVERY = require('../assets/pd-radio-discovery.js');
const ANNOUNCE = require('../assets/pd-radio-announcements.js');
const R2 = require('../functions/r2.js');

const PROJECT_ID = String(process.env.FIREBASE_PROJECT_ID || 'prayer-dome');
const DISCOVER_HITS = new Map(); // best-effort per-instance rate limit

function getRadio() {
  if (typeof window === 'undefined') return DEFAULT_RADIO;
  try {
    var store = window.PDApp && window.PDApp.store;
    if (store) return store.get('radio', 'DEFAULT_RADIO') || DEFAULT_RADIO;
  } catch (_error) { /* use the built-in fallback */ }
  return DEFAULT_RADIO;
}

function getPodcasts() {
  if (typeof window === 'undefined') return DEFAULT_PODCASTS;
  try {
    var store = window.PDApp && window.PDApp.store;
    if (store) return store.get('podcasts', 'DEFAULT_PODCASTS') || DEFAULT_PODCASTS;
  } catch (_error) { /* use the built-in fallback */ }
  return DEFAULT_PODCASTS;
}

function serializeRadio(item) {
  return {
    id: item.id || '',
    name: item.name || '',
    tagline: item.tagline || '',
    streamUrl: item.streamUrl || '',
    icon: item.icon || 'pd-i-radio'
  };
}

function serializePodcast(item) {
  return {
    id: item.id || '',
    title: item.title || '',
    series: item.series || '',
    description: item.description || '',
    audioUrl: item.audioUrl || '',
    duration: item.duration || '',
    date: item.date ? (typeof item.date === 'string' ? item.date : item.date.toISOString()) : null
  };
}

function send(res, status, payload, method) {
  const body = JSON.stringify(payload, null, 2);
  if (!res) return body;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', status === 200
    ? 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600'
    : 'no-store');
  if (method === 'HEAD') return res.end();
  return res.end(body);
}

function queryOf(req) {
  const q = (req && req.query) || {};
  if (q.op || q.category || q.key) return q;
  try {
    const url = new URL((req && req.url) || '/', 'https://prayerdome.net');
    const out = {};
    url.searchParams.forEach((value, key) => { out[key] = value; });
    return out;
  } catch (error) { return q; }
}

function headerOf(req, name) {
  const headers = (req && req.headers) || {};
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

function clientIp(req) {
  return headerOf(req, 'x-forwarded-for').split(',')[0].trim() || 'unknown';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (DISCOVER_HITS.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= 30) return true;
  hits.push(now);
  DISCOVER_HITS.set(ip, hits);
  return false;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'PrayerDomeRadio/1.0 (+https://prayerdome.net/radio)' }
    });
    if (!response.ok) throw new Error('Upstream returned ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* --- Firebase administrator check (ID token + Firestore role) ------------ */
let jwksCache = null;
let jwksAt = 0;

async function jwks() {
  if (jwksCache && Date.now() - jwksAt < 3600000) return jwksCache;
  const response = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!response.ok) throw new Error('Could not load Firebase signing keys.');
  jwksCache = await response.json();
  jwksAt = Date.now();
  return jwksCache;
}

function base64UrlJson(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

async function verifyFirebaseToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const header = base64UrlJson(parts[0]);
  const payload = base64UrlJson(parts[1]);
  if (header.alg !== 'RS256' || payload.aud !== PROJECT_ID ||
      payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  const keys = jwks();
  const key = (keys.keys || []).find((k) => k.kid === header.kid);
  if (!key) return null;
  const publicKey = crypto.createPublicKey({
    key: { kty: 'RSA', n: key.n, e: key.e },
    format: 'jwk'
  });
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parts[0] + '.' + parts[1]);
  if (!verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'))) return null;
  return payload;
}

async function isFirebaseAdmin(token) {
  const payload = await verifyFirebaseToken(token).catch(() => null);
  if (!payload || !payload.sub) return false;
  const collections = ['memberships', 'users'];
  for (const collection of collections) {
    try {
      const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
        '/databases/(default)/documents/' + collection + '/' + encodeURIComponent(payload.sub);
      const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) continue;
      const doc = await response.json();
      const fields = (doc && doc.fields) || {};
      const role = fields.role && fields.role.stringValue;
      if (role === 'admin') return true;
    } catch (error) { /* try the next collection */ }
  }
  return false;
}

async function requireAdmin(req) {
  const serverToken = String(process.env.RADIO_ADMIN_TOKEN || '');
  if (serverToken && headerOf(req, 'x-radio-admin-token') === serverToken) return true;
  const auth = headerOf(req, 'authorization');
  const token = auth.toLowerCase().indexOf('bearer ') === 0 ? auth.slice(7) : '';
  if (!token) return false;
  return isFirebaseAdmin(token);
}

/* --- Operations ------------------------------------------------------------ */
function lusakaNow() {
  try {
    if (typeof CONTENT.currentRadioProgramme === 'function') {
      return CONTENT.currentRadioProgramme(new Date());
    }
  } catch (error) { /* fall through */ }
  return { clock: { weekday: new Date().getDay(), minutes: 0, label: '' }, programme: null };
}

function statusPayload() {
  const now = lusakaNow();
  return {
    success: true,
    station: 'Prayer Dome Radio',
    timezone: 'Africa/Lusaka',
    now: now.clock,
    programme: now.programme || null,
    streamUrl: String(process.env.RADIO_STREAM_URL || ''),
    r2: R2.status(),
    tts: {
      engine: 'Piper (open-source, offline neural TTS)',
      serviceConfigured: Boolean(process.env.TTS_SERVICE_URL),
      browserFallback: true
    },
    discovery: {
      sources: ['Internet Archive (public domain / CC)', 'Wikimedia Commons (public domain)', 'Jamendo (review required)'],
      categories: Object.keys(DISCOVERY.CATEGORIES)
    },
    personas: ANNOUNCE.PERSONAS.map((p) => ({ id: p.id, label: p.label, gender: p.gender, piper: p.piper }))
  };
}

async function discover(req, res, query) {
  if (rateLimited(req)) return send(res, 429, { success: false, error: 'Too many discovery requests. Try again in a minute.' });
  const category = DISCOVERY.CATEGORIES[query.category] ? query.category : 'gospel-worship';
  const rows = Math.min(Math.max(Number(query.rows) || 20, 1), 50);
  const source = ['archive', 'commons', 'jamendo', 'all'].indexOf(query.source) !== -1 ? query.source : 'all';
  const queryText = DISCOVERY.CATEGORIES[category].query;
  const tracks = [];
  const errors = [];

  if (source === 'archive' || source === 'all') {
    try {
      const json = await fetchJson(DISCOVERY.archiveSearchUrl(queryText, rows));
      tracks.push(...DISCOVERY.parseArchive(json, category));
    } catch (error) { errors.push('Internet Archive: ' + error.message); }
  }
  if (source === 'commons' || source === 'all') {
    try {
      const json = await fetchJson(DISCOVERY.commonsSearchUrl(queryText, rows));
      tracks.push(...DISCOVERY.parseCommons(json, category));
    } catch (error) { errors.push('Wikimedia Commons: ' + error.message); }
  }
  if (source === 'jamendo' || source === 'all') {
    const clientId = String(process.env.JAMENDO_CLIENT_ID || '');
    if (clientId) {
      try {
        const json = await fetchJson(DISCOVERY.jamendoSearchUrl(queryText, rows, clientId));
        tracks.push(...DISCOVERY.parseJamendo(json, category));
      } catch (error) { errors.push('Jamendo: ' + error.message); }
    } else {
      errors.push('Jamendo: skipped (set JAMENDO_CLIENT_ID to enable; it is free to register).');
    }
  }

  const unique = DISCOVERY.dedupe(tracks);
  return send(res, 200, {
    success: true,
    category,
    categoryLabel: DISCOVERY.CATEGORIES[category].label,
    count: unique.length,
    autoApprovable: unique.filter((t) => t.approved).length,
    reviewRequired: unique.filter((t) => t.reviewRequired).length,
    tracks: unique,
    sourceErrors: errors
  });
}

function announceText(query) {
  const programmes = CONTENT.RADIO_PROGRAMMES || [];
  const programme = programmes.find((p) => p.id === query.programmeId) || programmes[0] || {};
  const persona = ANNOUNCE.personaForProgramme(programme.id, query.personaId);
  const now = lusakaNow();
  const hour = Math.floor((now.clock.minutes || 0) / 60);
  const text = ANNOUNCE.announcementText({
    kind: query.kind || 'programme-intro',
    programme,
    hour,
    day: now.clock.weekday,
    seed: hour * 7 + (now.clock.weekday || 0),
    track: query.trackTitle ? { title: query.trackTitle, artist: query.trackArtist || '' } : null
  });
  return { text, persona, programme };
}

async function announce(req, res, query) {
  const method = (req && req.method) || 'GET';
  if (method === 'GET' || method === 'HEAD') {
    const result = announceText(query);
    const key = ANNOUNCE.cacheKey(result.text, result.persona.id);
    const base = R2.publicBaseUrl();
    return send(res, 200, {
      success: true,
      text: result.text,
      persona: { id: result.persona.id, label: result.persona.label, gender: result.persona.gender, piper: result.persona.piper },
      programme: result.programme.title || '',
      cacheKey: key,
      cachedAudioUrl: base ? base + '/' + key.split('/').map(encodeURIComponent).join('/') : '',
      ttsServiceConfigured: Boolean(process.env.TTS_SERVICE_URL)
    }, method);
  }
  if (method !== 'POST') {
    if (res && res.setHeader) res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { success: false, error: 'Method not allowed' });
  }
  if (!(await requireAdmin(req))) {
    return send(res, 403, { success: false, error: 'Administrator sign-in is required to generate announcements.' });
  }
  const ttsUrl = String(process.env.TTS_SERVICE_URL || '').trim();
  if (!ttsUrl) {
    return send(res, 503, {
      success: false,
      error: 'No TTS service is configured. Set TTS_SERVICE_URL (see radio/tts/README.md) or use the free browser voice fallback. Music continues without announcements.',
      text: announceText(query).text
    });
  }
  const result = announceText(query);
  const key = ANNOUNCE.cacheKey(result.text, result.persona.id);
  const ttsResponse = await fetch(ttsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
      ...(process.env.TTS_SERVICE_TOKEN ? { Authorization: 'Bearer ' + process.env.TTS_SERVICE_TOKEN } : {})
    },
    body: JSON.stringify({ text: result.text, voice: result.persona.piper, personaId: result.persona.id })
  });
  if (!ttsResponse.ok) {
    return send(res, 502, { success: false, error: 'TTS service returned ' + ttsResponse.status + '. Music continues without this announcement.' });
  }
  const audio = Buffer.from(await ttsResponse.arrayBuffer());
  const uploaded = await R2.uploadObject(key, audio, 'audio/mpeg');
  return send(res, 200, {
    success: true,
    text: result.text,
    persona: result.persona.id,
    cacheKey: key,
    audioUrl: uploaded.publicUrl || ('/api/radio?op=r2-get&key=' + encodeURIComponent(key)),
    size: uploaded.size
  });
}

async function r2Upload(req, res) {
  if (!(await requireAdmin(req))) {
    return send(res, 403, { success: false, error: 'Administrator sign-in is required to upload radio audio.' });
  }
  const key = headerOf(req, 'x-r2-key');
  const contentType = headerOf(req, 'x-r2-content-type') || 'audio/mpeg';
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', resolve);
    req.on('error', reject);
  });
  const body = Buffer.concat(chunks);
  const uploaded = await R2.uploadObject(key, body, contentType);
  return send(res, 200, { success: true, ...uploaded });
}

async function r2Get(req, res, query) {
  const key = String(query.key || '');
  if (!R2.validateKey(key)) return send(res, 400, { success: false, error: 'That key is outside the radio/ folders.' });
  const base = R2.publicBaseUrl();
  if (base && (req.method === 'GET' || req.method === 'HEAD')) {
    res.statusCode = 302;
    res.setHeader('Location', base + '/' + key.split('/').map(encodeURIComponent).join('/'));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end();
  }
  const upstream = await R2.getObject(key, headerOf(req, 'range') || undefined);
  if (!upstream.ok) {
    return send(res, upstream.status === 404 ? 404 : 502, { success: false, error: 'Audio not found in R2.' });
  }
  res.statusCode = upstream.status;
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
  if (upstream.headers.get('content-range')) res.setHeader('Content-Range', upstream.headers.get('content-range'));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (req.method === 'HEAD') return res.end();
  const reader = upstream.body.getReader();
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  };
  return pump();
}

function playlistPayload() {
  const programmes = (CONTENT.RADIO_PROGRAMMES || []).map((p) => ({
    id: p.id,
    title: p.title,
    start: p.start,
    end: p.end,
    days: p.days,
    description: p.description || p.kind || '',
    category: p.category || 'gospel-worship',
    personaId: (ANNOUNCE.personaForProgramme(p.id).id)
  }));
  return {
    success: true,
    station: 'Prayer Dome Radio',
    timezone: 'Africa/Lusaka',
    programmes,
    categories: DISCOVERY.CATEGORIES,
    personas: ANNOUNCE.PERSONAS.map((p) => ({ id: p.id, label: p.label, gender: p.gender, piper: p.piper })),
    note: 'Liquidsoap reads the live Firestore timetable/playlists when deployed (radio/server/). This endpoint publishes the default timetable so a server can run without database credentials.'
  };
}

async function handler(req, res) {
  const method = (req && req.method) || 'GET';
  const query = queryOf(req);
  const op = String(query.op || '');

  try {
    if (op === 'status') return send(res, 200, statusPayload(), method);
    if (op === 'discover') {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { success: false, error: 'Method not allowed' });
      return await discover(req, res, query);
    }
    if (op === 'announce') return await announce(req, res, query);
    if (op === 'r2-status') return send(res, 200, { success: true, r2: R2.status() }, method);
    if (op === 'r2-upload') {
      if (method !== 'POST') return send(res, 405, { success: false, error: 'Method not allowed' });
      return await r2Upload(req, res);
    }
    if (op === 'r2-get') return await r2Get(req, res, query);
    if (op === 'playlist') return send(res, 200, playlistPayload(), method);
    if (op === 'stream') {
      return send(res, 200, {
        success: true,
        streamUrl: String(process.env.RADIO_STREAM_URL || ''),
        note: 'Empty until a licensed stream or the Liquidsoap/Icecast server (radio/server/) is deployed. Listener-side automation needs no stream URL.'
      }, method);
    }
  } catch (error) {
    const status = error && error.code === 'r2-not-configured' ? 503 : 500;
    return send(res, status, { success: false, error: (error && error.message) || 'Radio service error.' });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    if (res && res.setHeader) res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, { success: false, error: 'Method not allowed' }, method);
  }

  const radio = getRadio().map(serializeRadio);
  return send(res, 200, {
    success: true,
    radio,
    radioConfigured: radio.some((station) => Boolean(station.streamUrl)),
    count: radio.length,
    podcasts: getPodcasts().map(serializePodcast)
  }, method);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = handler;
  module.exports.handler = handler;
  module.exports.getRadio = getRadio;
  module.exports.getPodcasts = getPodcasts;
  module.exports.statusPayload = statusPayload;
  module.exports.playlistPayload = playlistPayload;
}
