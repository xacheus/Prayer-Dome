'use strict';

/*
 * Cloudflare R2 — S3-compatible client (no paid SDK, no new dependency).
 * ---------------------------------------------------------------------------
 * R2 speaks the S3 API. This module signs requests with AWS Signature
 * Version 4 using only Node's built-in crypto, so the Vercel radio function
 * can upload, download and list audio without installing @aws-sdk/*.
 *
 * Credentials come ONLY from environment variables (set in Vercel):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *   R2_BUCKET_NAME, R2_ENDPOINT, R2_PUBLIC_BASE_URL (optional)
 * They are never sent to the browser and never logged.
 *
 * Object layout (see docs/RADIO-24-7.md):
 *   radio/music/          eligible gospel music
 *   radio/announcements/  generated AI presenter announcements
 *   radio/sermons/        sermons
 *   radio/bible-readings/ Bible readings
 *   radio/prayers/        prayer recordings
 *   radio/archives/       radio archives
 */

const crypto = require('node:crypto');

const ALLOWED_PREFIXES = [
  'radio/music/',
  'radio/announcements/',
  'radio/sermons/',
  'radio/bible-readings/',
  'radio/prayers/',
  'radio/archives/'
];
const MAX_OBJECT_BYTES = 50 * 1024 * 1024; // same cap as Firebase Storage radioAudio
const AUDIO_TYPES = /^(audio\/|video\/mp4)/i;

function env(name) {
  return String(process.env[name] || '').trim();
}

function config() {
  const accountId = env('R2_ACCOUNT_ID');
  const accessKey = env('R2_ACCESS_KEY_ID');
  const secret = env('R2_SECRET_ACCESS_KEY');
  const bucket = env('R2_BUCKET_NAME') || 'prayer-dome';
  const endpoint = env('R2_ENDPOINT') ||
    (accountId ? 'https://' + accountId + '.r2.cloudflarestorage.com' : '');
  return { accountId, accessKey, secret, bucket, endpoint: endpoint.replace(/\/$/, '') };
}

function isConfigured() {
  const c = config();
  return Boolean(c.accessKey && c.secret && c.endpoint && c.bucket);
}

function publicBaseUrl() {
  return env('R2_PUBLIC_BASE_URL').replace(/\/$/, '');
}

function validateKey(key) {
  const k = String(key || '');
  if (!k || k.length > 512) return false;
  if (k.indexOf('..') !== -1 || k.indexOf('\\') !== -1 || k.charAt(0) === '/') return false;
  return ALLOWED_PREFIXES.some((prefix) => k.indexOf(prefix) === 0);
}

function validateContentType(contentType) {
  return AUDIO_TYPES.test(String(contentType || ''));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function signingKey(secret, dateStamp, region, service) {
  let key = Buffer.from('AWS4' + secret, 'utf8');
  key = hmac(key, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  return key;
}

function amzDate(now) {
  const d = now || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    stamp: d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()),
    time: pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z'
  };
}

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

/* Build a signed S3 request. Exported for unit tests (no network needed). */
function signRequest(options) {
  const opts = options || {};
  const c = config();
  const method = (opts.method || 'GET').toUpperCase();
  const key = String(opts.key || '');
  const body = opts.body || Buffer.alloc(0);
  const contentType = opts.contentType || 'application/octet-stream';
  const region = opts.region || 'auto';
  const service = 's3';
  const now = amzDate(opts.now);
  const payloadHash = sha256(body);
  const canonicalUri = '/' + encodeKey(c.bucket + (key ? '/' + key : ''));
  const query = opts.query || '';
  const canonicalQuery = query;
  const headers = {
    host: new URL(c.endpoint).host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now.time
  };
  if (method === 'PUT' || method === 'POST') headers['content-type'] = contentType;
  if (opts.range) headers.range = opts.range;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((name) => name + ':' + String(headers[name]).trim() + '\n').join('');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = now.stamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', now.time, scope, sha256(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(c.secret, now.stamp, region, service))
    .update(stringToSign).digest('hex');
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + c.accessKey + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return {
    url: c.endpoint + canonicalUri + (query ? '?' + query : ''),
    method,
    headers: Object.assign({}, headers, { authorization: authorization }),
    body
  };
}

async function request(options) {
  if (!isConfigured()) {
    const error = new Error('Cloudflare R2 is not configured. Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in Vercel.');
    error.code = 'r2-not-configured';
    throw error;
  }
  const signed = signRequest(options);
  const response = await fetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: signed.method === 'GET' || signed.method === 'HEAD' ? undefined : signed.body
  });
  return response;
}

async function uploadObject(key, body, contentType) {
  if (!validateKey(key)) {
    const error = new Error('That R2 key is outside the radio/ prefixes.');
    error.code = 'invalid-key';
    throw error;
  }
  if (!validateContentType(contentType)) {
    const error = new Error('Only audio uploads are accepted.');
    error.code = 'invalid-content-type';
    throw error;
  }
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (!buffer.length || buffer.length > MAX_OBJECT_BYTES) {
    const error = new Error('Audio must be between 1 byte and 50 MB.');
    error.code = 'invalid-size';
    throw error;
  }
  const response = await request({ method: 'PUT', key, body: buffer, contentType });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error('R2 upload failed (' + response.status + '). ' + text.slice(0, 200));
    error.code = 'r2-upload-failed';
    error.status = response.status;
    throw error;
  }
  const base = publicBaseUrl();
  return {
    key,
    bucket: config().bucket,
    publicUrl: base ? base + '/' + encodeKey(key) : '',
    size: buffer.length,
    contentType
  };
}

async function getObject(key, range) {
  if (!validateKey(key)) {
    const error = new Error('That R2 key is outside the radio/ prefixes.');
    error.code = 'invalid-key';
    throw error;
  }
  return request({ method: 'GET', key, range: range || undefined });
}

async function headObject(key) {
  if (!validateKey(key)) {
    const error = new Error('That R2 key is outside the radio/ prefixes.');
    error.code = 'invalid-key';
    throw error;
  }
  return request({ method: 'HEAD', key });
}

async function listObjects(prefix, maxKeys) {
  if (!ALLOWED_PREFIXES.some((p) => String(prefix || '').indexOf(p) === 0)) {
    const error = new Error('That prefix is outside the radio/ folders.');
    error.code = 'invalid-key';
    throw error;
  }
  const query = 'list-type=2&prefix=' + encodeURIComponent(prefix) +
    '&max-keys=' + encodeURIComponent(String(Math.min(Number(maxKeys) || 50, 200)));
  const response = await request({ method: 'GET', key: '', query });
  const xml = await response.text();
  if (!response.ok) {
    const error = new Error('R2 list failed (' + response.status + ').');
    error.code = 'r2-list-failed';
    error.status = response.status;
    throw error;
  }
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let match;
  while ((match = re.exec(xml)) !== null) keys.push(match[1]);
  return { prefix, keys, count: keys.length };
}

function status() {
  const c = config();
  return {
    configured: isConfigured(),
    bucket: c.bucket || 'prayer-dome',
    endpointHost: c.endpoint ? new URL(c.endpoint).host : '',
    publicBaseConfigured: Boolean(publicBaseUrl()),
    prefixes: ALLOWED_PREFIXES.slice()
  };
}

module.exports = {
  ALLOWED_PREFIXES,
  MAX_OBJECT_BYTES,
  config,
  isConfigured,
  publicBaseUrl,
  validateKey,
  validateContentType,
  signRequest,
  uploadObject,
  getObject,
  headObject,
  listObjects,
  status
};
