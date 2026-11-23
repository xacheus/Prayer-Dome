/*
 * Smoke tests for the certificate tracking UI:
 *   - account.html "My Certificates" section renders local + Firestore certs
 *     and binds download buttons.
 *   - admin.html "Certificates" tracker renders the issued list, KPIs and
 *     search filter from Firestore data.
 * Extracts the relevant code blocks from each page's module script and runs
 * them in jsdom with stubbed Firebase APIs.
 *
 * Requires jsdom (same as pages.test.js / premium.test.js):
 *   npm install --no-save jsdom
 *   node tests/certificates.test.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
}

try {
  require('jsdom');
} catch (e) {
  console.log('SKIP  jsdom not installed — run: npm install --no-save jsdom');
  process.exit(0);
}

const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

function moduleScript(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  // The tag may carry extra attributes (e.g. an onerror handler), so match
  // the type attribute rather than the whole opening tag.
  const m = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no module script in ' + file);
  return m[1];
}

/* Every inline script on the page, module and classic together.
   The account page keeps its plain helpers (escapeHtml, showToast) in a
   classic script that runs before the Firebase module, so a page helper may
   live in either one. */
function allScripts(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const blocks = [];
  const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks.join('\n');
}

// Balanced-brace slice starting at `marker` (inclusive of the closing brace line).
function sliceBalanced(code, marker) {
  const start = code.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = code.indexOf('{', start);
  let depth = 0;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced block: ' + marker);
}

// ------------------------------------------------------------ certificates
(function certificatesPageTest() {
  const html = fs.readFileSync(path.join(ROOT, 'certificates.html'), 'utf8');
  const code = moduleScript('certificates.html');
  const dom = new JSDOM(html, { url: 'https://prayerdome.net/certificates', runScripts: 'outside-only' });
  const w = dom.window;

  t('certificates page has loading, signed-out and signed-in states',
    ['certAuthLoading', 'certSignedOut', 'certContent'].every((id) => w.document.getElementById(id)));
  t('certificates page queries only the signed-in member',
    /where\(\s*['"]userId['"]\s*,\s*['"]==['"]\s*,\s*user\.uid\s*\)/.test(code) &&
    !/where\(\s*['"]userId['"]\s*,\s*['"]==['"]\s*,\s*['"]/.test(code));
  t('cloud results are filtered again by the signed-in uid',
    /filter\(\(cert\) => cert\.userId === user\.uid\)/.test(code));
  t('certificate cards expose preview, download and print',
    ['cert-preview-btn', 'cert-download-btn', 'cert-print-btn'].every((cls) => code.includes(cls)));
  t('certificate cards show title, issue date, reference number and status',
    ['cert.title', 'displayDate(cert.parsed)', 'cert.id', "cert.status"].every((field) => code.includes(field)));
  t('profile does not collect certificates inline',
    !fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8').includes('myCertificatesList'));
  t('navigation points at the dedicated certificates page',
    fs.readFileSync(path.join(ROOT, 'assets/pd-nav.js'), 'utf8').includes("href: '/certificates'"));

  // Local awards are claimed once by the signed-in member and never shown to
  // a different account on the same device.
  const localFn = sliceBalanced(code, 'function localCertificates(uid) {');
  w.localStorage.setItem('pd_academy_progress', JSON.stringify({
    certificates: [{ id: 'PD-LOCAL-1', title: 'Foundations of Prayer', score: 90, date: '2026-07-01T00:00:00Z', name: 'Jane Doe' }]
  }));
  w.eval(localFn);
  t('first signed-in member claims legacy local certificates',
    w.localCertificates('user-a').length === 1 &&
    JSON.parse(w.localStorage.getItem('pd_academy_progress')).ownerUid === 'user-a');
  t('a different signed-in member cannot see the first member\'s local certificates',
    w.localCertificates('user-b').length === 0);
})();

// ---------------------------------------------------------------- admin
(function adminTest() {
  const code = moduleScript('admin.html');
  const helpers =
    code.match(/window\.escapeHTML = [^\n]*/)[0] + '\n' +
    sliceBalanced(code, 'window.toast = (msg, type = \'success\') => {') + '\n';
  const aStart = code.indexOf('/* ==================== CERTIFICATES TRACKER ==================== */');
  const aEnd = code.indexOf('window.exportCertificatesCSV', aStart);
  const adminCertCode = sliceBalanced(code, 'window.loadCertificates = async function () {') +
    '\n' + code.slice(code.indexOf('window.renderCertificates = function () {'), code.indexOf('window.filterCertificates')) +
    '\n' + sliceBalanced(code, 'function renderCertificateCompletionChart() {') + '\n' +
    '\n' + code.slice(aEnd, code.indexOf('\n        };\n', aEnd) + 12);

  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://prayerdome.net/admin', runScripts: 'outside-only' });
  const w = dom.window;
  w.moment = (d) => ({ format: () => String(d) });
  w.URL.createObjectURL = () => 'blob:cert';
  w.URL.revokeObjectURL = () => {};
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = (tag) => tag === 'a' ? { click() {}, style: {} } : origCreate(tag);
  w.confirm = () => true;
  w.toast = () => {};
  w.getDocs = async () => ({
    empty: false,
    forEach(fn) {
      const now = new Date();
      [
        { id: 'doc1', data: () => ({ id: 'PD-1', userId: 'u1', name: 'Jane Doe', email: 'jane@x.com', course: 'Foundations of Prayer', score: 90, date: now.toISOString(), downloads: 3 }) },
        { id: 'doc2', data: () => ({ id: 'PD-2', userId: 'u2', name: 'John Smith', email: 'john@x.com', course: 'Intercession 101', score: 85, date: '2025-12-01T00:00:00Z', downloads: 1 }) },
        { id: 'doc3', data: () => ({ id: 'PD-3', course: 'Old Quiz Cert', score: 80, date: '2025-06-01T00:00:00Z', downloads: 0 }) }
      ].forEach(fn);
    }
  });
  w.query = () => ({}); w.collection = () => ({}); w.orderBy = () => ({}); w.limit = () => ({});
  w.db = {};
  w.doc = () => ({}); w.deleteDoc = async () => {};

  try {
    w.eval(helpers);
    w.eval(adminCertCode);
    w.loadCertificates().then(() => {
      const d = w.document;
      t('admin: certificates table renders all records',
        d.querySelectorAll('#certificatesList tr').length === 3, d.querySelectorAll('#certificatesList tr').length + ' rows');
      t('admin: completion chart renders one bar per course',
        d.querySelectorAll('#certificateCompletionChart rect').length === 3, d.querySelectorAll('#certificateCompletionChart rect').length + ' bars');
      t('admin: chart lists each completed course',
        d.getElementById('certificateCompletionChart').textContent.includes('Foundations of Prayer') &&
        d.getElementById('certificateCompletionChart').textContent.includes('Intercession 101'));
      t('admin: chart has a legend', d.getElementById('certificateCompletionLegend').textContent.includes('Certificates earned per lesson'));
      t('admin: unlinked cert flagged', d.getElementById('certificatesList').textContent.includes('Unlinked'));
      // search filter
      d.getElementById('certSearchInput').value = 'john';
      w.renderCertificates();
      t('admin: search filters the list',
        d.querySelectorAll('#certificatesList tr').length === 1 &&
        d.getElementById('certificatesList').textContent.includes('John Smith'));
      // csv export does not throw
      w.exportCertificatesCSV();
      t('admin: CSV export runs', true);
    }).catch(e => { fail++; console.log('FAIL  admin exception: ' + e.stack); });
  } catch (e) { fail++; console.log('FAIL  admin exception: ' + e.stack); }
})();

setTimeout(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 500);
