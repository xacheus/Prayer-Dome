#!/usr/bin/env node
/**
 * Mirrors shared radio modules from assets/ into functions/ so the Firebase
 * Functions deploy (which only uploads functions/) always carries the same
 * logic the browser uses. Run after editing assets/pd-radio-discovery.js:
 *   npm run sync:radio
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = `/*! GENERATED COPY — do not edit here.
 * Source of truth: assets/pd-radio-discovery.js (shared with the browser).
 * Firebase deploys only the functions/ directory, so the module is mirrored.
 * Refresh with: npm run sync:radio (scripts/sync-radio-modules.mjs). */
`;

const source = readFileSync(join(root, 'assets', 'pd-radio-discovery.js'), 'utf8');
writeFileSync(join(root, 'functions', 'discovery.js'), HEADER + source);
console.log('functions/discovery.js refreshed from assets/pd-radio-discovery.js');
