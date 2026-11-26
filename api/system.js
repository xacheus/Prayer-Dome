'use strict';

/*
 * Consolidated system endpoint.
 *
 * Vercel's Hobby plan allows no more than 12 Serverless Functions per
 * deployment. The deployment probe and the tiny Brevo newsletter intake are
 * both low-traffic system endpoints, so they share this one function file
 * instead of spending two of those twelve slots. vercel.json keeps the public
 * URLs stable:
 *
 *   /api/health    -> /api/system?op=health
 *   /api/newsletter -> /api/system?op=newsletter
 *
 * Both public paths behave exactly as before. The newsletter handler still owns
 * validation, consent, rate limiting and the Brevo key (server-side only), and
 * the health probe remains a dependency-free GET/HEAD endpoint.
 */

const brevo = require('../functions/brevo');
const billingServer = require('../lib/billing-server');

function operation(req) {
  const query = req && req.query;
  if (query && (query.op || query.endpoint)) return String(query.op || query.endpoint);
  try {
    return new URL((req && req.url) || '/', 'https://prayerdome.net').searchParams.get('op') || '';
  } catch (error) {
    return '';
  }
}

function health(req, res) {
  const method = (req && req.method) || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  }

  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || 'local';
  const payload = JSON.stringify({
    ok: true,
    service: 'prayer-dome',
    revision: sha === 'local' ? sha : sha.slice(0, 12),
    environment: process.env.VERCEL_ENV || 'local',
    region: process.env.VERCEL_REGION || null
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (method === 'HEAD') return res.end();
  return res.end(payload);
}


function sendJson(res, status, payload, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.keys(extraHeaders || {}).forEach(function (name) {
    res.setHeader(name, extraHeaders[name]);
  });
  res.end(JSON.stringify(payload));
}

function iceServerList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(function (server) {
    if (!server) return false;
    var urls = server.urls;
    var list = Array.isArray(urls) ? urls : [urls];
    return list.length > 0 && list.every(function (url) {
      return typeof url === 'string' && /^(?:stun|stuns|turn|turns):[^\s]+$/i.test(url);
    });
  }).map(function (server) {
    var clean = { urls: server.urls };
    if (typeof server.username === 'string') clean.username = server.username;
    if (typeof server.credential === 'string') clean.credential = server.credential;
    return clean;
  });
}

// Metered returns an array, Cloudflare wraps the same shape in {"iceServers": [...]}.
// Accept either, plus a single object, without passing unknown fields to the browser.
function iceServersFrom(value) {
  if (Array.isArray(value)) return iceServerList(value);
  if (value && value.iceServers) {
    return Array.isArray(value.iceServers)
      ? iceServerList(value.iceServers)
      : iceServerList([value.iceServers]);
  }
  return [];
}

async function liveIce(req, res) {
  var method = (req && req.method) || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { 'Cache-Control': 'no-store' });
  }

  var stun = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  var cloudflareKeyId = (process.env.TURN_KEY_ID || process.env.CLOUDFLARE_TURN_KEY_ID || '').trim();
  var cloudflareToken = (process.env.TURN_KEY_API_TOKEN || process.env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
  var provider = String(process.env.TURN_PROVIDER || '').trim().toLowerCase();
  var key = process.env.METERED_TURN_API_KEY || process.env.TURN_API_KEY || '';
  var subdomain = process.env.METERED_TURN_SUBDOMAIN || 'prayerdome';
  var endpoint = process.env.TURN_CREDENTIALS_URL || '';
  if (!endpoint && key) {
    endpoint = 'https://' + subdomain + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(key);
  }

  var iceServers = stun;
  var relay = false;
  var providerUsed = 'none';
  var warning = 'Relay not configured; direct WebRTC only.';
  var cloudflareConfigured = !!(cloudflareKeyId && cloudflareToken);
  if (provider === 'cloudflare' || (!provider && cloudflareConfigured)) {
    providerUsed = 'cloudflare';
    if (!cloudflareConfigured) {
      warning = 'Cloudflare TURN is selected but its key ID or API token is missing; direct WebRTC only.';
    } else if (!/^[A-Za-z0-9_-]{8,128}$/.test(cloudflareKeyId)) {
      // Never interpolate an unvalidated key into the provider URL.
      warning = 'Cloudflare TURN key ID has an unexpected format; direct WebRTC only.';
    } else {
      try {
        var cfResponse = await fetch(
          'https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(cloudflareKeyId) + '/credentials/generate-ice-servers',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + cloudflareToken,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({ ttl: 3600 }),
            cache: 'no-store'
          }
        );
        if (cfResponse.ok) {
          var cfMinted = iceServersFrom(await cfResponse.json());
          if (cfMinted.length) {
            iceServers = cfMinted;
            relay = cfMinted.some(function (server) {
              var urls = Array.isArray(server.urls) ? server.urls : [server.urls];
              return urls.some(function (url) { return /^turns?:/i.test(url); });
            });
            warning = relay ? null : 'Cloudflare returned no TURN URL; direct WebRTC only.';
          } else {
            warning = 'Cloudflare returned no usable ICE servers; direct WebRTC only.';
          }
        } else {
          warning = 'Cloudflare TURN did not issue credentials (HTTP ' + cfResponse.status + '); direct WebRTC only.';
        }
      } catch (error) {
        warning = 'Cloudflare TURN is unreachable; direct WebRTC only.';
      }
    }
  } else if (endpoint) {
    providerUsed = key ? 'metered' : 'custom';
    try {
      var headers = { Accept: 'application/json' };
      if (process.env.TURN_API_KEY && !process.env.METERED_TURN_API_KEY) {
        headers.Authorization = 'Bearer ' + process.env.TURN_API_KEY;
      }
      var response = await fetch(endpoint, { headers: headers, cache: 'no-store' });
      if (response.ok) {
        var minted = iceServersFrom(await response.json());
        if (minted.length) {
          iceServers = minted;
          relay = minted.some(function (server) {
            var urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return urls.some(function (url) { return /^turns?:/i.test(url); });
          });
          warning = relay ? null : 'Relay returned no TURN URL; direct WebRTC only.';
        }
      } else {
        warning = 'Relay service did not issue credentials; direct WebRTC only.';
      }
    } catch (error) {
      warning = 'Relay service is unreachable; direct WebRTC only.';
    }
  }

  var payload = {
    ok: true,
    provider: providerUsed,
    relay: relay,
    iceServers: iceServers,
    expiresInSeconds: 3600,
    warning: warning
  };
  if (method === 'HEAD') return sendJson(res, 200, {}, { 'Cache-Control': 'no-store' });
  return sendJson(res, 200, payload, {
    'Cache-Control': 'no-store',
    'X-PD-Relay': relay ? 'turn' : 'stun',
    'X-PD-Turn-Provider': providerUsed
  });
}

module.exports = function system(req, res) {
  var op = operation(req);
  if (op === 'newsletter') return brevo.newsletterHandler(req, res);
  if (op === 'live-ice') return liveIce(req, res);
  // Billing lives on this consolidated endpoint so Hobby deployments stay
  // within the 12-serverless-function limit.
  if (op === 'billing') return billingServer.billingHandler(req, res);
  if (op === 'payment-webhook') return billingServer.webhookHandler(req, res);
  return health(req, res);
};
