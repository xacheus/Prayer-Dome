/*
 * Prayer Dome — QR and official-signature checks
 * ===========================================================================
 * The membership card must render a real, scannable QR without reaching a
 * CDN, and both the card and the certificate must carry the founder's real
 * signing mark. These checks execute the vendored encoder and inspect the
 * generated SVG rather than trusting a string in the page.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// ---- vendored encoder -------------------------------------------------------
const encoder = read('assets/qrcode-generator.js');
assert.match(encoder, /QR Code Generator for JavaScript/, 'the MIT encoder must be vendored');
assert.doesNotMatch(read('membership.html'), /cdn\.jsdelivr\.net\/npm\/qrcode-generator/,
  'the card must never depend on a QR CDN');
assert.match(read('membership.html'), /<script src="\/assets\/qrcode-generator\.js"><\/script>/,
  'the card must load the local encoder before its module');

const context = { window: {} };
vm.runInNewContext(encoder, context, { filename: 'qrcode-generator.js' });
const qrcode = context.qrcode || context.window.qrcode;
assert.equal(typeof qrcode, 'function', 'the encoder must publish qrcode()');

function encode(token) {
  const url = 'https://prayerdome.net/verify?ref=' + encodeURIComponent(token);
  const qr = qrcode(0, 'L');
  qr.addData(url);
  qr.make();
  return { url, qr, svg: qr.createSvgTag({ cellSize: 3, margin: 4, scalable: true }) };
}

// 16 characters = 96 bits on the server and 72 bits for an administrator
// token. Together with the URL prefix this is 50 bytes, which fits QR version
// 3 (29 modules). Fewer modules means visibly larger dots on a 68 px card.
const shortToken = 'AbCdEfGhIjKlMnOp';
const short = encode(shortToken);
assert.equal(short.url.length, 50, 'short verification URL must be 50 characters');
assert.equal(short.qr.getModuleCount(), 29, 'short token must produce version-3 QR (29 modules)');
assert.match(short.svg, /^<svg /, 'encoder must return an SVG');
assert.match(short.svg, /viewBox="0 0 \d+ \d+"/, 'SVG must scale to its container');
assert.doesNotMatch(short.svg, /<svg[^>]*\swidth=/, 'scalable SVG must not pin a pixel width');
assert.match(short.svg, /<path[^>]*d="/, 'QR modules must be drawn as a path');
assert.match(short.svg, /fill="#000000"|fill="black"/, 'QR modules must be solid black');
assert.doesNotMatch(short.svg, /<script|javascript:/i, 'QR SVG must not carry executable content');

// A legacy 24-character token still works; it simply needs version 4.
const legacy = encode('AbCdEfGhIjKlMnOpQrStUvWx');
assert.equal(legacy.qr.getModuleCount(), 33, 'legacy token must still encode (version 4)');

// ---- official signature ----------------------------------------------------
const png = fs.readFileSync(path.join(ROOT, 'assets/pd-signature.png'));
assert.equal(png.slice(1, 4).toString('ascii'), 'PNG', 'signature must be a real PNG');
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
assert.ok(width >= 900 && height >= 200, 'signature must be large enough to print cleanly');
assert.ok(png.length > 5000, 'signature must contain the drawn mark, not an empty canvas');

const svg = read('assets/pd-signature.svg');
assert.match(svg, /<path[^>]*d="/, 'signature must be vector-drawn');
assert.match(svg, /S\.K\. Masuku/, 'signature artwork must identify the founder');
assert.ok(fs.existsSync(path.join(ROOT, 'assets/pd-signature.LICENSE.txt')),
  'the signature lettering licence must ship with the asset');

const certificate = read('assets/pd-certificate.js');
assert.match(certificate, /var FOUNDER_NAME = 'S\.K\. MASUKU';/, 'certificate founder name must be exact');
assert.match(certificate, /var DEFAULT_SIGNATURE_URL = '\/assets\/pd-signature\.png';/,
  'certificate must default to the official signature image');
assert.match(certificate, /loadImage\(\(meta && meta\.url\) \|\| DEFAULT_SIGNATURE_URL\)/,
  'a missing cloud signature must not leave the certificate unsigned');
assert.match(certificate, /992 - sh/, 'signature ink must sit on the signature rule');

const membership = read('membership.html');
assert.match(membership, /signature: '\/assets\/pd-signature\.png'/,
  'membership card must default to the official signature image');
assert.match(membership, /signatoryName: 'S\.K\. MASUKU'/,
  'membership card founder name must be exact');

// ---- the card's actual render path ----------------------------------------
const { JSDOM } = require('jsdom');
const html = membership;
const moduleScript = (html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/) || [, ''])[1];
const qrStart = moduleScript.indexOf('function verificationUrl');
const qrEnd = moduleScript.indexOf('function formatCardDate', qrStart);
assert.ok(qrStart >= 0 && qrEnd > qrStart, 'the card QR functions must be present');
const qrFunctions = moduleScript.slice(qrStart, qrEnd);

const dom = new JSDOM('<!doctype html><html><body><div id="idQr"></div></body></html>',
  { url: 'https://prayerdome.net/membership', runScripts: 'outside-only' });
const w = dom.window;
w.eval(encoder);
w.eval(qrFunctions + '\nwindow.__renderCardQr = renderCardQr;');
w.__renderCardQr('PD20260001', true, { verificationRef: shortToken });
const host = w.document.getElementById('idQr');
const rendered = host.querySelector('svg');
assert.ok(rendered, 'an approved card must render an SVG QR, not a text fallback');
assert.equal(host.querySelectorAll('svg').length, 1, 'the card must contain exactly one QR');
assert.match(rendered.getAttribute('viewBox'), /^0 0 \d+ \d+$/, 'the QR must scale to the card');
assert.equal(rendered.getAttribute('role'), 'img');
assert.ok(rendered.querySelectorAll('path').length >= 1, 'the QR must contain drawn modules');
assert.doesNotMatch(host.textContent, /QR appears after approval|could not be registered|prayerdome\.net\/verify/,
  'a successfully issued card must not show a fallback message');

w.__renderCardQr('PD20260001', false, null);
assert.match(host.textContent, /QR appears after approval/, 'pending cards must explain the missing QR');
w.__renderCardQr('PD20260001', true, null);
assert.match(host.textContent, /could not be registered/, 'a missing token must be explained honestly');

console.log('QR encoding, card rendering and official signature checks passed (' +
  width + '×' + height + ' px signature).');
