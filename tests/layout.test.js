'use strict';

/**
 * Global layout guard.
 *
 * The app shipped a universal `overflow-wrap: anywhere` / `word-break:
 * break-word` layer that turned table headings (DATE, NAME, EMAIL) into
 * one-letter columns on phones. This test locks the corrected model in:
 * words wrap between words, tables keep a column-count based minimum width and
 * scroll inside a wrapper, and no page can quietly re-introduce letter
 * stacking.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const htmlPath = (name) => path.join(ROOT, name);

const brand = read('assets/pd-brand.css');
const responsive = read('assets/pd-responsive-fix.css');
const app = read('assets/pd-app.js');

/* ---------------------------------------------------------------- source CSS */
// The old global rule forced `display:block` on tables at <=640px, which made
// every cell its own line and destroyed header/data alignment.
assert.doesNotMatch(brand, /:where\(table\)[^{]*\{[^}]*display:\s*block/s,
  'tables must not become block boxes that stack cells vertically');
// The old blanket minimum made every small receipt table wider than a phone,
// even when the page (not the table) was the scrolling element.
assert.doesNotMatch(brand, /(?:^|\})\s*table\s*\{[^}]*min-width:\s*600px/s,
  'a single global 600px table minimum is not a responsive table model');

const textFoundation = brand.slice(brand.indexOf('Words wrap between words'), brand.indexOf('Words wrap between words') + 900);
assert.match(textFoundation, /word-break:\s*normal/, 'ordinary text wraps between words');
assert.match(textFoundation, /overflow-wrap:\s*break-word/, 'only an over-wide token may break');
assert.match(textFoundation, /hyphens:\s*manual/, 'automatic hyphenation cannot split words into letters');

assert.match(responsive, /\.pd-table-scroll[\s\S]{0,700}overflow-x:\s*auto/,
  'the shared table wrapper scrolls sideways');
assert.match(responsive, /\.pd-table-scroll[\s\S]{0,700}overflow-y:\s*visible/,
  'the wrapper does not swallow vertical page scroll');
assert.match(responsive, /min-width:\s*var\(--pd-table-min,\s*720px\)/,
  'tables take their minimum width from their real column count');
assert.match(responsive, /\.pd-table-scroll th[\s\S]{0,500}white-space:\s*nowrap\s*!important/,
  'headings stay on one horizontal line');
assert.match(responsive, /\.pd-table-scroll td[\s\S]{0,500}min-width:\s*96px/,
  'a data column is never narrower than a real word');
assert.match(responsive, /\.pd-table-scroll td[\s\S]{0,500}word-break:\s*normal\s*!important/,
  'data cells never break words into letters');
assert.match(responsive, /\.pd-table-scroll \.pd-break-token/, 'only explicit tokens may break inside a word');

// Page-level rules must not undo the model: no ordinary text rule may use
// `overflow-wrap: anywhere` again on about/account/team.
for (const page of ['about.html', 'account.html', 'team.html', 'bible.html']) {
  assert.doesNotMatch(read(page), /overflow-wrap:\s*anywhere/,
    `${page} must not split ordinary words anywhere`);
}

/* --------------------------------------------------------- cascade behaviour */
// Verify the browser's computed result, not just the source text: page CSS
// (admin/finance inline styles) must lose to the shared table layer, and the
// table must remain a real table (not a stack of block cells).
for (const page of ['admin.html', 'finance.html']) {
  const html = read(page).replace(/<script[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(html, { url: 'https://prayerdome.net/' + page });
  const { document } = dom.window;
  const style = document.createElement('style');
  style.textContent = brand + '\n' + responsive;
  document.head.appendChild(style);

  const table = document.querySelector('table');
  const wrapper = document.createElement('div');
  wrapper.className = 'pd-table-scroll';
  wrapper.style.setProperty('--pd-table-min', '1200px');
  table.parentNode.insertBefore(wrapper, table);
  wrapper.appendChild(table);

  const th = table.querySelector('th');
  const td = table.querySelector('td');
  const css = (element) => dom.window.getComputedStyle(element);
  assert.equal(css(table).display, 'table', `${page}: table keeps table layout`);
  assert.equal(css(th).whiteSpace, 'nowrap', `${page}: headings are horizontal`);
  assert.equal(css(th).wordBreak, 'normal', `${page}: heading words are never split`);
  assert.equal(css(td).whiteSpace, 'normal', `${page}: data may wrap between words`);
  assert.equal(css(td).wordBreak, 'normal', `${page}: data words are never split`);
  assert.equal(css(td).overflowWrap, 'break-word', `${page}: only an over-wide token breaks`);
  assert.equal(css(td).minWidth, '96px', `${page}: data columns keep a readable floor`);
  assert.equal(css(wrapper).overflowX, 'auto', `${page}: wide tables scroll sideways`);
  assert.equal(css(wrapper).overflowY, 'visible', `${page}: page scroll is not trapped`);
  dom.window.close();
}

/* ------------------------------------------------------------- runtime tables */
const pages = [
  ...fs.readdirSync(ROOT).filter((name) => name.endsWith('.html')).sort(),
  'documents/index.html'
];

let totalTables = 0;
for (const page of pages) {
  const html = fs.readFileSync(htmlPath(page), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://prayerdome.net/' + page.replace(/\\/g, '/'),
    runScripts: 'outside-only'
  });
  const { window } = dom;
  // Keep jsdom's optional animation-frame plumbing out of the test; the table
  // enhancer itself is synchronous + MutationObserver based.
  window.requestAnimationFrame = function () { return 0; };
  window.cancelAnimationFrame = function () {};
  window.eval(app);
  assert.ok(window.PDApp && window.PDApp.tables, `${page} exposes the shared table enhancer`);
  window.PDApp.tables.init();

  const tables = [...window.document.querySelectorAll('table')];
  totalTables += tables.length;
  for (const table of tables) {
    const wrapper = table.closest('.pd-table-scroll');
    assert.ok(wrapper, `${page}: every table is inside a horizontal scroll wrapper`);
    const minimum = wrapper.style.getPropertyValue('--pd-table-min');
    assert.match(minimum, /^\d+px$/, `${page}: table has a usable minimum width`);
    const cols = Number(wrapper.getAttribute('data-pd-table-cols'));
    assert.ok(cols >= 1, `${page}: table column count is known`);
    if (cols >= 4) assert.ok(parseInt(minimum, 10) >= 560,
      `${page}: a ${cols}-column table is wide enough for real headings`);
    if (cols <= 2) assert.equal(parseInt(minimum, 10), 0,
      `${page}: a small receipt table may fit the screen`);
  }
  assert.equal(window.document.querySelectorAll('.pd-table-scroll .pd-table-scroll').length, 0,
    `${page}: table wrappers are never nested`);
  window.close();
}
assert.equal(totalTables, 42, 'admin (41, including giving, withdrawals, email delivery and radio programming) and finance (1) tables are all covered');

/* --------------------------------------------------- dynamic admin/report rows */
(async () => {
  const dom = new JSDOM('<body></body>', {
    url: 'https://prayerdome.net/admin.html',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  window.requestAnimationFrame = function () { return 0; };
  window.cancelAnimationFrame = function () {};
  window.eval(app);
  window.PDApp.tables.init();

  const host = window.document.createElement('div');
  host.innerHTML = '<table><thead><tr><th>Date</th><th>Name</th><th>Email</th>' +
    '<th>Subject</th></tr></thead><tbody><tr><td>2026-11-22</td><td>Nsindiso Davis</td>' +
    '<td>nsindiso@example.org</td><td>Prayer request</td></tr></tbody></table>';
  window.document.body.appendChild(host);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const table = window.document.querySelector('table');
  const wrapper = table.closest('.pd-table-scroll');
  assert.ok(wrapper, 'a table rendered after load is wrapped by the observer');
  assert.equal(wrapper.getAttribute('data-pd-table-cols'), '4');
  assert.ok(parseInt(wrapper.style.getPropertyValue('--pd-table-min'), 10) >= 560);

  // A deliberately narrow two-column receipt must not inherit a desktop width.
  const receipt = window.document.createElement('table');
  receipt.innerHTML = '<tbody><tr><td>Total</td><td>ZMW 250</td></tr></tbody>';
  window.document.body.appendChild(receipt);
  window.PDApp.tables.enhance(receipt);
  assert.equal(receipt.closest('.pd-table-scroll').style.getPropertyValue('--pd-table-min'), '0px');

  window.close();
  console.log(`Layout guard passed: ${pages.length} pages, ${totalTables} static tables, dynamic tables covered.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
