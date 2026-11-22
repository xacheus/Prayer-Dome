'use strict';

/*
 * Guards the member-facing global update:
 *   • no public language picker anywhere,
 *   • a complete profile view that survives a slow Firestore read,
 *   • certificates download as PDF and print,
 *   • the membership card has PDF/image/print actions,
 *   • the team page hides passed-away members and never clips a card,
 *   • filter rails swipe sideways on a phone.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function t(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

/* ------------------------------------------------------- language retirement */
const selectorPages = pages.filter((f) => read(f).includes('pd-lang-select'));
t('the header language selector is gone from every page', selectorPages.length === 0, selectorPages.join(', '));

const app = read('assets/pd-app.js');
t('the shared header cannot inject a language picker', !app.includes("createElement('select')"));
t('the shared header still injects the notification bell',
  app.includes("bell.id='pdNotifBell'") && app.includes('HEADER_HTML'));

const heavyI18nPages = pages.filter((f) => {
  const html = read(f);
  return html.includes('/assets/pd-phrases.js') || html.includes('/assets/pd-i18n.js');
});
t('public pages no longer download the retired translation payload',
  heavyI18nPages.length === 0, heavyI18nPages.join(', '));

/* ---------------------------------------------------------------- profile */
const account = read('account.html');
t('profile data is declared before it is used (no blank profile crash)',
  /async function loadProfileData\(user\) \{\s*\/\/[\s\S]{0,600}let data = \{\};/.test(account) &&
  account.includes('Promise.allSettled'));
t('profile shows name, photo, email, branch, phone and member-since',
  ['pNameDisplay', 'pPhoto', 'pEmailDisplay', 'pBranchDisplay', 'pPhoneDisplay', 'pJoinedDisplay']
    .every((id) => account.includes(`id="${id}"`)));
t('profile links to the official membership card',
  account.includes('/membership#card') && account.includes('My membership card'));

/* --------------------------------------------------------- certificates */
const cert = read('assets/pd-certificate.js');
t('certificate download produces a PDF, not only an image',
  cert.includes("fileStem(opts) + '.pdf'") && cert.includes('buildPdf'));
t('certificate still offers a PNG for sharing', cert.includes('downloadPng') && cert.includes("+ '.png'"));
t('profile certificate buttons say Download PDF and Print',
  account.includes('Download PDF</button>') && account.includes('cert-print-btn'));
t('printed certificate opens a clean standalone page',
  account.includes('window.printCertificate') && account.includes('Preparing your certificate'));

/* ------------------------------------------------------- membership card */
const membership = read('membership.html');
t('membership card contains the required official fields',
  ['idPhoto', 'idName', 'idNumber', 'idChurch', 'barcodeImg'].every((id) => membership.includes(`id="${id}"`)));
t('membership card has PDF, image and print actions',
  membership.includes("downloadID('pdf')") && membership.includes("downloadID('png')") && membership.includes('printID()'));
t('membership print stylesheet isolates the card',
  membership.includes('@media print') && membership.includes('#captureArea, #captureArea * { visibility: visible'));

/* ------------------------------------------------------------------ team */
const team = read('team.html');
t('passed-away and archived members never reach the public grid',
  /filter\(m => !m\.archived && !m\.deceased\)/.test(team));
t('team cards show role, location and a readable bio',
  team.includes('team-location') && team.includes('team-bio') && team.includes('team-title'));
t('team card text wraps between words without letter stacking',
  /\.team-name[\s\S]{0,220}overflow-wrap: break-word/.test(team) &&
  /\.team-bio[\s\S]{0,220}overflow-wrap: break-word/.test(team) &&
  /\.team-name[\s\S]{0,220}word-break: normal/.test(team));
const admin = read('admin.html');
t('admin can permanently remove a team member from the roster',
  admin.includes('deleteAdminTeamMemberById') && admin.includes('> Remove</button>'));
t('admin can edit every detail of an existing member',
  ['teamMemberName', 'teamMemberTitle', 'teamMemberRole', 'teamMemberCountry',
    'teamMemberDescription', 'teamMemberImageUrl', 'teamMemberEmail', 'teamMemberPhone']
    .every((id) => admin.includes(`id="${id}"`)));

/* --------------------------------------------------------------- filters */
const responsive = read('assets/pd-responsive-fix.css');
t('mobile filter rails scroll horizontally instead of wrapping',
  /flex-wrap: nowrap !important/.test(responsive) && /overflow-x: auto !important/.test(responsive));
t('the rail rule covers the tabs used across the site',
  ['category-tabs', 'filter-bar', 'tab-container', 'pd-acad-filters'].every((c) => responsive.includes('.' + c)));

/* ------------------------------------------------------- content cleanup */
const about = read('about.html');
t('about page links the real teaching PDFs and has no Coming Soon cards',
  about.includes('/documents/statement-of-faith.pdf') && !about.includes('Coming Soon'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
