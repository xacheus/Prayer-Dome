'use strict';

/*
 * The home-page Explore grid is four destinations per row at every viewport.
 * This is a source-level check because the repo has no browser layout runner;
 * it proves the final cascade rule cannot collapse to three/two/one column and
 * that all 23 destinations are still present in their original order.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const responsive = fs.readFileSync(path.join(root, 'assets/pd-responsive-fix.css'), 'utf8');
const brand = fs.readFileSync(path.join(root, 'assets/pd-brand.css'), 'utf8');

const expected = [
  'Bible', 'Verse Widget', 'Assistant', 'Sermons', 'Teaching', 'Stories', 'Resources',
  'Translate', 'Gallery', 'Give', 'Live', 'Quiz', 'Game', 'Membership', 'Support',
  'Testimony', 'Events', 'News', 'Media', 'About', 'Contact', 'Team', 'Chat'
];
const grid = (index.match(/<div class="portal-grid"[\s\S]*?<\/div>\s*\n\s*\n\s*<!-- Prayer Dome Academy/) || [''])[0];
const labels = [...grid.matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map((match) => match[1].trim());
assert.deepStrictEqual(labels, expected, 'every Explore destination is present in order');
assert.strictEqual((grid.match(/class="portal-item /g) || []).length, 23);
assert.ok(!/overflow-x\s*:\s*(auto|scroll)/.test(grid), 'the Explore grid is not a sideways rail');

// Inline page CSS: four equal tracks, wrapping labels, no horizontal padding that
// could push the first item inwards beyond the page rhythm.
assert.match(index, /\.portal-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
assert.match(index, /\.portal-item span\s*\{[^}]*white-space:\s*normal[^}]*word-break:\s*normal[^}]*overflow-wrap:\s*break-word/);
assert.match(index, /@media \(max-width: 600px\)[\s\S]*?\.portal-grid\s*\{\s*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);

// The shared override file is the last word in the cascade, including the
// 3/2/1-column rules in pd-brand.css and responsive-fix's own earlier blocks.
const sectionStart = responsive.indexOf('10. Explore grid');
assert.ok(sectionStart > responsive.indexOf('@media (max-width: 380px)'), 'the four-column rule comes after the collapsing media blocks');
const finalGrid = responsive.indexOf('.portal-grid {', sectionStart);
const tail = responsive.slice(finalGrid, responsive.indexOf('@media (max-width: 600px)', finalGrid));
assert.match(tail, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)\s*!important/);
assert.match(tail, /gap:\s*10px\s*!important/);
assert.match(tail, /width:\s*100%\s*!important/);
assert.match(responsive.slice(finalGrid), /\.portal-grid > \.portal-item > span[\s\S]*?word-break:\s*normal[\s\S]*?overflow-wrap:\s*break-word/);

// Old brand rules still exist for other grids but no longer own the final word.
assert.match(brand, /\.portal-grid\s*\{\s*grid-template-columns:\s*repeat\(3/);

console.log('Explore grid checks passed (23 destinations, four per row at every breakpoint).');
