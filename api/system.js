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

module.exports = function system(req, res) {
  if (operation(req) === 'newsletter') return brevo.newsletterHandler(req, res);
  return health(req, res);
};
