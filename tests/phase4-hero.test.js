'use strict';

/*
 * Phase 4 hero contracts. There is no browser in this environment, so this
 * checks the actual CSS declarations and markup rather than claiming a visual
 * screenshot was reviewed.
 *
 * Run: node tests/phase4-hero.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const home = read('index.html');
const brand = read('assets/pd-brand.css');
const responsive = read('assets/pd-responsive-fix.css');
let passed = 0;
function t(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS  ' + name); }
  else { console.error('FAIL  ' + name + (extra ? '  ' + extra : '')); process.exitCode = 1; }
}

const heroCss = home.slice(home.indexOf('/* --- Cinematic prayer hero'), home.indexOf('.typing-cursor'));

t('the hero is a full-width, edge-to-edge section',
  /\.hero\s*\{[\s\S]*?position: relative; width: 100%/.test(heroCss) &&
  /\.hero\s*\{[\s\S]*?border-radius: 0;/.test(heroCss) &&
  /\.hero\s*\{[\s\S]*?margin: 0;/.test(heroCss));
t('hero height is capped with clamp() at every breakpoint',
  heroCss.includes('height: clamp(420px, 42vw, 600px)') &&
  heroCss.includes('height: clamp(360px, 108vw, 420px)') &&
  heroCss.includes('height: clamp(440px, 52vw, 520px)') &&
  heroCss.includes('height: clamp(500px, 38vw, 600px)'));
t('the old rounded-card mobile rule is gone',
  !home.includes('border-radius: 0 0 26px 26px') &&
  !brand.includes('.pd-home .hero { padding: 32px 24px 38px; border-radius: 24px; margin: 0 16px; min-height: 0; }') &&
  !/\.pd-home \.hero[^\n]*margin: 0 16px/.test(brand));
t('admin-managed banners use the same full-bleed geometry',
  /\.pd-hero-managed\s*\{[\s\S]*?width: 100%; height: clamp\(420px, 42vw, 600px\)/.test(brand) &&
  /\.pd-hero-managed\s*\{[\s\S]*?border-radius: 0;/.test(brand) &&
  /\.pd-home \.hero, \.pd-home \.pd-hero-managed\s*\{[\s\S]*?margin: 0; border-radius: 0;/.test(brand));
t('the external stardust texture is no longer fetched',
  !home.includes('transparenttextures.com') && heroCss.includes('.hero::after { content: none; }'));
t('the responsive fix keeps CTA wrapping without reintroducing card sides',
  /\.hero-cta,[\s\S]{0,300}flex-wrap: wrap/.test(responsive));

/* Content and behaviour preserved. */
const heroMarkup = home.slice(home.indexOf('<div class="hero" data-pd-hero>'), home.indexOf('<!-- Install prompt'));
t('the real photograph layers and overlays remain',
  heroMarkup.includes('hero-cinema-a') && heroMarkup.includes('hero-cinema-b') &&
  heroMarkup.includes('hero-cinema-shade') && heroMarkup.includes('hero-cinema-glow'));
t('logo, wordmark, scripture, heading, message and CTAs remain',
  heroMarkup.includes('/assets/logo.png') && heroMarkup.includes('hero-wordmark') &&
  home.includes('data-pd-scripture') && heroMarkup.includes('id="typingHeading"') &&
  heroMarkup.includes('id="js-welcome-message"') &&
  ['/live.html', '/prayer.html', '/bible.html'].every((href) => heroMarkup.includes(`href="${href}"`)));
t('install banner and admin-managed banner renderer remain wired',
  home.includes('data-pd-install-banner') &&
  read('assets/pd-app.js').includes("var hero = $('[data-pd-hero]')") &&
  read('assets/pd-app.js').includes('banners.render(hero, banner)'));
t('declared image dimensions match the real artwork',
  heroMarkup.includes('width="1376" height="768"') && heroMarkup.includes('width="1672" height="941"'));

/* Motion and readability. */
t('crossfade, pan and entrance animations exist',
  heroCss.includes('pdHeroPan') && heroCss.includes('pdHeroFadeA') &&
  heroCss.includes('pdHeroEntrance') && heroCss.includes('animation: pdHeroEntrance'));
t('reduced motion disables every hero animation',
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hero-cinema-a, \.hero-cinema-b,[\s\S]*?animation: none/.test(heroCss));
t('a dark gradient keeps text readable over the photograph',
  heroCss.includes('rgba(5,24,52,.58)') && heroCss.includes('rgba(5,24,52,.94)') &&
  heroCss.includes('text-shadow: 0 4px 28px rgba(0,0,0,.55)'));
t('hero images are precached for offline installs',
  ['/assets/hero-prayer.jpg', '/assets/hero-worship.jpg'].every((file) => read('sw.js').includes(file)));

console.log(`\n${passed} phase 4 hero assertions passed.`);
