'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function test(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function invoke(modulePath, method = 'GET', requestBody = null, query = {}) {
  const handler = require(path.join(ROOT, modulePath));
  const headers = {};
  let body = '';
  const response = {
    statusCode: 200,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
    },
    status(status) { this.statusCode = status; return this; },
    send(value) { body = value || ''; return value; },
    end(value) { body = value || ''; return value; }
  };
  const request = {
    method,
    headers: { host: 'prayerdome.net', 'x-forwarded-proto': 'https' },
    query,
    body: requestBody,
    url: '/'
  };
  return Promise.resolve(handler(request, response)).then(() => ({
    status: response.statusCode,
    headers,
    body,
    json: body ? JSON.parse(body) : null
  }));
}

(async function run() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

  test('Vercel uses the explicit static framework preset', config.framework === null);
  test('Vercel installs the server-side Firebase Admin dependency without running postinstall',
    config.installCommand === 'npm ci --ignore-scripts --no-audit --no-fund' &&
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies['firebase-admin']);
  test('Vercel builds an allowlisted public bundle',
    config.buildCommand === 'node scripts/build-vercel.mjs' && config.outputDirectory === 'dist');
  test('Vercel functions have bounded execution time and traced data files',
    config.functions && config.functions['api/*.js'] &&
    config.functions['api/*.js'].maxDuration === 20 &&
    config.functions['api/*.js'].includeFiles.includes('pd-content-data.js') &&
    config.functions['api/*.js'].includeFiles.includes('functions/billing*.js') &&
    config.functions['api/*.js'].includeFiles.length <= 256);

  const apiFunctions = fs.readdirSync(path.join(ROOT, 'api')).filter(name => name.endsWith('.js'));
  test('the API stays within the 12-function Hobby plan limit',
    apiFunctions.length <= 12, `${apiFunctions.length} functions in api/`);
  const newsletterRewrite = (config.rewrites || []).find(rule => rule.source === '/api/newsletter');
  test('/api/newsletter is routed through the consolidated system function',
    newsletterRewrite && newsletterRewrite.destination.startsWith('/api/system?op=newsletter'));
  const iceRewrite = (config.rewrites || []).find(rule => rule.source === '/api/live-ice');
  test('/api/live-ice is routed through the consolidated system function',
    iceRewrite && iceRewrite.destination === '/api/system?op=live-ice');
  const billingRewrite = (config.rewrites || []).find(rule => rule.source === '/api/billing');
  test('/api/billing is routed through the consolidated system function',
    billingRewrite && billingRewrite.destination === '/api/system?op=billing');
  const webhookRewrite = (config.rewrites || []).find(rule => rule.source === '/api/payment-webhook');
  test('/api/payment-webhook is routed through the consolidated system function',
    webhookRewrite && webhookRewrite.destination === '/api/system?op=payment-webhook');
  test('automatic deployments are enabled for arena branches and main',
    config.git && config.git.deploymentEnabled.main === true &&
    config.git.deploymentEnabled['**'] === false &&
    config.git.deploymentEnabled['*'] === false &&
    config.git.deploymentEnabled['arena/**'] === true);

  for (const section of ['rewrites', 'redirects', 'headers']) {
    const sources = (config[section] || []).map(item => item.source);
    test(`${section} do not contain duplicate source rules`, new Set(sources).size === sources.length);
  }

  const missingDestinations = [];
  for (const rule of config.rewrites || []) {
    const destination = rule.destination.split('?')[0];
    if (destination.includes(':')) continue;
    if (destination.startsWith('/api/')) {
      if (!fs.existsSync(path.join(ROOT, `${destination.slice(1)}.js`))) missingDestinations.push(destination);
    } else if (path.extname(destination) && !fs.existsSync(path.join(ROOT, destination.slice(1)))) {
      missingDestinations.push(destination);
    }
  }
  test('every concrete Vercel rewrite target exists', missingDestinations.length === 0,
    missingDestinations.join(', '));

  const globalHeaders = (config.headers || []).find(rule => rule.source === '/(.*)');
  const headerMap = Object.fromEntries((globalHeaders && globalHeaders.headers || [])
    .map(header => [header.key.toLowerCase(), header.value]));
  test('Vercel sends the core security headers',
    ['content-security-policy', 'strict-transport-security', 'x-content-type-options',
      'x-frame-options', 'referrer-policy', 'permissions-policy']
      .every(name => headerMap[name]));
  test('content policy blocks plugins and unsafe base URLs',
    headerMap['content-security-policy'].includes("object-src 'none'") &&
    headerMap['content-security-policy'].includes("base-uri 'self'"));

  const cacheRule = (source) => (config.headers || [])
    .find((rule) => rule.source === source);
  const cacheFor = (source) => {
    const rule = cacheRule(source);
    const header = rule && rule.headers.find((h) => h.key.toLowerCase() === 'cache-control');
    return (header && header.value) || '';
  };
  test('static assets are cached for a week, including the 3D engine and its models',
    ['/(.*).(js|mjs|css|png|jpg|jpeg|svg|webp|woff2|vrm|glb)', '/assets/domey/(.*)', '/assets/vendor/(.*)']
      .every((source) => cacheFor(source).includes('max-age=604800')));
  test('the character model is not marked immutable, because its URL never changes',
    !cacheFor('/assets/domey/(.*)').includes('immutable'));

  execFileSync(process.execPath, ['scripts/build-vercel.mjs'], { cwd: ROOT, stdio: 'inherit' });
  const output = path.join(ROOT, 'dist');
  const htmlPages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
  const missingPages = htmlPages.filter(name => !fs.existsSync(path.join(output, name)));
  test('the Vercel bundle contains every website page', missingPages.length === 0,
    missingPages.join(', '));
  test('the Vercel bundle contains PWA and SEO files',
    ['manifest.json', 'sw.js', 'firebase-messaging-sw.js', 'robots.txt', 'sitemap.xml']
      .every(name => fs.existsSync(path.join(output, name))));
  test('the Vercel bundle contains the Android assetlinks verification file',
    fs.existsSync(path.join(output, '.well-known', 'assetlinks.json')));
  test('Vercel serves assetlinks.json as JSON',
    (config.headers || []).some(rule => rule.source === '/.well-known/assetlinks.json' &&
      rule.headers.some(header => header.key === 'Content-Type' && header.value === 'application/json')));
  test('private repository files are not published',
    ['README.md', 'package.json', 'firebase.json', 'firestore.rules', 'tests', 'android', 'scripts']
      .every(name => !fs.existsSync(path.join(output, name))));

  const bundledHtml = [];
  function collectHtml(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collectHtml(file);
      else if (entry.name.endsWith('.html')) bundledHtml.push(file);
    }
  }
  collectHtml(output);
  const missingAssetReferences = [];
  for (const file of bundledHtml) {
    const document = new JSDOM(fs.readFileSync(file, 'utf8')).window.document;
    for (const element of document.querySelectorAll(
      'script[src], link[href], img[src], source[src], audio[src], video[src], video[poster]')) {
      const reference = (element.getAttribute('src') || element.getAttribute('href') ||
        element.getAttribute('poster') || '').trim();
      if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) continue;
      const assetPath = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
      if (assetPath.startsWith('/api/')) continue; // serverless handlers are outside dist/
      const asset = path.resolve(assetPath.startsWith('/') ? output : path.dirname(file),
        assetPath.startsWith('/') ? `.${assetPath}` : assetPath);
      if (!asset.startsWith(output + path.sep) || !fs.existsSync(asset)) {
        missingAssetReferences.push(`${path.relative(output, file)} -> ${reference}`);
      }
    }
  }
  test('every local page, script, style, image and media reference ships in the bundle',
    missingAssetReferences.length === 0, missingAssetReferences.join(', '));

  const news = await invoke('api/news.js');
  test('/api/news returns a successful non-empty payload',
    news.status === 200 && news.json.success === true && news.json.count > 0 &&
    news.json.count === news.json.stories.length);
  test('/api/news sets JSON and CDN cache headers',
    news.headers['content-type'].startsWith('application/json') &&
    news.headers['cache-control'].includes('s-maxage=300'));

  const radio = await invoke('api/radio.js');
  test('/api/radio is honest about stations, streams and podcasts',
    radio.status === 200 && radio.json.success === true && radio.json.radio.length > 0 &&
    Array.isArray(radio.json.podcasts) && typeof radio.json.radioConfigured === 'boolean' &&
    radio.json.radio.every(station => !/soundhelix|sample\.mp3/i.test(station.streamUrl || '')) &&
    radio.json.radioConfigured === radio.json.radio.some(station => Boolean(station.streamUrl)));

  const ice = await invoke('api/system.js', 'GET', null, { op: 'live-ice' });
  test('/api/live-ice returns STUN servers and no committed TURN secret',
    ice.status === 200 && ice.json.ok === true && Array.isArray(ice.json.iceServers) &&
    ice.json.iceServers.length > 0 &&
    ice.json.iceServers.every(server => (Array.isArray(server.urls) ? server.urls : [server.urls])
      .every(url => /^(?:stun|stuns|turn|turns):/i.test(url))));
  test('/api/live-ice refuses write methods',
    (await invoke('api/system.js', 'POST', null, { op: 'live-ice' })).status === 405);
  test('the live engine never hardcodes a TURN username or credential',
    !/credential:\s*['"][^'"]+['"]/.test(fs.readFileSync(path.join(ROOT, 'assets/pd-live-webrtc.js'), 'utf8')) &&
    !/turn:[^'"]*metered\.ca/.test(fs.readFileSync(path.join(ROOT, 'assets/pd-live-webrtc.js'), 'utf8')));

  // Cloudflare's TURN key is server-only. This proves the endpoint mints a
  // short-lived credential and never returns the key or API token itself.
  const savedFetch = global.fetch;
  const savedEnv = {
    TURN_PROVIDER: process.env.TURN_PROVIDER,
    TURN_KEY_ID: process.env.TURN_KEY_ID,
    TURN_KEY_API_TOKEN: process.env.TURN_KEY_API_TOKEN,
    METERED_TURN_API_KEY: process.env.METERED_TURN_API_KEY
  };
  let cloudflareRequest = null;
  process.env.TURN_PROVIDER = 'cloudflare';
  process.env.TURN_KEY_ID = 'test-key-id-1234567890';
  process.env.TURN_KEY_API_TOKEN = 'test-api-token-value';
  delete process.env.METERED_TURN_API_KEY;
  global.fetch = async (url, options = {}) => {
    cloudflareRequest = { url: String(url), options };
    return {
      ok: true,
      status: 201,
      json: async () => ({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          {
            urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
            username: 'ephemeral-user',
            credential: 'ephemeral-credential'
          }
        ]
      })
    };
  };
  const cloudflareIce = await invoke('api/system.js', 'GET', null, { op: 'live-ice' });
  global.fetch = savedFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  test('/api/live-ice mints Cloudflare TURN credentials server-side',
    cloudflareIce.status === 200 && cloudflareIce.json.provider === 'cloudflare' &&
    cloudflareIce.json.relay === true &&
    cloudflareIce.json.iceServers.some(server =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url))) &&
    cloudflareRequest && cloudflareRequest.url ===
      'https://rtc.live.cloudflare.com/v1/turn/keys/test-key-id-1234567890/credentials/generate-ice-servers' &&
    cloudflareRequest.options.method === 'POST' &&
    cloudflareRequest.options.headers.Authorization === 'Bearer test-api-token-value' &&
    cloudflareRequest.options.body === JSON.stringify({ ttl: 3600 }));
  test('the Cloudflare key and API token never reach the browser payload',
    !JSON.stringify(cloudflareIce.json).includes('test-api-token-value') &&
    !JSON.stringify(cloudflareIce.json).includes('test-key-id-1234567890'));

  const rejected = await invoke('api/news.js', 'POST');
  test('read-only APIs reject unsupported methods',
    rejected.status === 405 && rejected.headers.allow === 'GET, HEAD');
  const head = await invoke('api/radio.js', 'HEAD');
  test('read-only APIs support bodyless HEAD probes', head.status === 200 && head.body === '');

  const health = await invoke('api/system.js');
  test('/api/health is available for deployment monitoring',
    health.status === 200 && health.json.ok === true && health.json.service === 'prayer-dome' &&
    health.headers['cache-control'] === 'no-store');

  const newsletterProbe = await invoke('api/system.js', 'GET', null, { op: 'newsletter' });
  test('/api/newsletter reaches the Brevo handler and stays POST-only',
    newsletterProbe.status === 405 && newsletterProbe.headers.allow === 'POST');

  const ignore = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8');
  test('.vercelignore excludes the repository by default and allows required sources',
    ignore.includes('\n/*\n') && ignore.includes('!api/') &&
    ignore.includes('!scripts/build-vercel.mjs') && ignore.includes('!functions/share.js'));
  test('.vercelignore keeps the postinstall hook that `npm install` runs on Vercel',
    ignore.includes('!scripts/install-functions.mjs'),
    'package.json "postinstall" must survive the upload filter');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}()).catch(error => {
  console.error(error);
  process.exit(1);
});
