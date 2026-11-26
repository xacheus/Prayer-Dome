'use strict';

/**
 * Public Radio and Podcasts API.
 * Uses the same data as the browser. A station with no licensed stream is
 * returned honestly with an empty streamUrl; podcasts are empty until an
 * administrator publishes an episode with its rights recorded.
 */

const CONTENT = (typeof window !== 'undefined' && window.PD_CONTENT)
  ? window.PD_CONTENT
  : require('../assets/pd-content-data.js');
const DEFAULT_RADIO = Array.isArray(CONTENT.DEFAULT_RADIO) ? CONTENT.DEFAULT_RADIO : [];
const DEFAULT_PODCASTS = Array.isArray(CONTENT.DEFAULT_PODCASTS) ? CONTENT.DEFAULT_PODCASTS : [];
const { readRadioConfig } = require('../server/radio/config.js');

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

function send(res, status, payload, method, privateResponse) {
  const body = JSON.stringify(payload, null, 2);
  if (!res) return body;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', privateResponse || status !== 200
    ? 'no-store'
    : 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600');
  if (method === 'HEAD') return res.end();
  return res.end(body);
}

function queryOf(req) {
  if (req && req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url || '/', 'http://preview').searchParams); }
  catch (error) { return {}; }
}

function handler(req, res) {
  const method = (req && req.method) || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    if (res && res.setHeader) res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, { success: false, error: 'Method not allowed' }, method);
  }

  const query = queryOf(req);
  if (query.view === 'status') {
    // Environment names only. No credential, connection string or secret value
    // is sent to the browser, and this is not a broadcast-health claim.
    return send(res, 200, {
      success: true,
      view: 'status',
      infrastructure: readRadioConfig(process.env)
    }, method, true);
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
}
